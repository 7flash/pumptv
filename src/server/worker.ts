import { hostname } from "node:os";
import type { GenerationMode } from "../shared/contracts.ts";
import { commitPromptRound, ensurePromptRound } from "./arbitration.ts";
import { BUFFER_CLIP_MS, evaluateBuffer } from "./adaptive-buffer.ts";
import { generateNextClip } from "./generate.ts";
import { classifyGenerationFailure } from "./generation-recovery.ts";
import { acquireRoomLease, releaseRoomLease, renewRoomLease } from "./lease.ts";
import { arbitrationMeasure, workerMeasure } from "./observability.ts";
import {
  getLatestClip,
  getRecentGenerationTimings,
  getRoomRow,
  hasQueuedDirective,
  clearGenerationPause,
  nextEpisode,
  recoverGeneratingDirectives,
  setWorkerState,
  setGenerationPause,
} from "./repository.ts";

const LEASE_TTL_MS = Number(process.env.SLOP_LEASE_TTL_MS || 30_000);
const IDLE_POLL_MS = Number(process.env.SLOP_IDLE_POLL_MS || 250);
const ERROR_BACKOFF_MS = Number(process.env.SLOP_ERROR_BACKOFF_MS || 2_000);
const MIN_GENERATION_INTERVAL_MS = Math.max(
  0,
  Number(process.env.SLOP_MIN_GENERATION_INTERVAL_MS || 0),
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const owner = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
let stopping = false;

function clipEndMs(clip: Awaited<ReturnType<typeof getLatestClip>>) {
  return clip ? clip.startsAtMs + clip.durationSeconds * 1000 : null;
}

async function bufferSnapshot(
  latest: Awaited<ReturnType<typeof getLatestClip>>,
  activeMode?: GenerationMode,
) {
  const timings = await getRecentGenerationTimings();
  const now = Date.now();
  const endMs = clipEndMs(latest) || now;
  return evaluateBuffer({
    bufferMs: Math.max(0, endMs - now),
    samples: timings,
    activeMode,
    hasClip: Boolean(latest),
  });
}

async function waitForPromptWindow(
  latest: Awaited<ReturnType<typeof getLatestClip>>,
  generationLeadMs: number,
) {
  if (!latest) return 0;
  if (await hasQueuedDirective()) return 0;

  const episode = await nextEpisode();
  const endMs = clipEndMs(latest);
  const round = await arbitrationMeasure.measure("Ensure scene ballot", () =>
    ensurePromptRound(episode, endMs, generationLeadMs),
  );
  if (!round) return 0;

  const now = Date.now();
  const bufferMs = Math.max(0, (endMs || now) - now);
  if (now >= round.closesAtMs) return 0;

  // Dynamic lead is based on recent end-to-end generation time. Keep voting open
  // only while measured headroom says the next render can still land safely.
  if (bufferMs <= generationLeadMs) return 0;
  return Math.max(25, Math.min(500, round.closesAtMs - now));
}

async function generationTick() {
  const room = await getRoomRow();
  if (!room.running) {
    await setWorkerState("idle", null);
    return { generated: false, sleepMs: 1_000 };
  }

  const now = Date.now();
  const retryAtMs =
    room.generationRetryAtMs == null ? 0 : Number(room.generationRetryAtMs);
  if (room.generationPauseKind && retryAtMs > now) {
    await setWorkerState("idle", null, room.generationMode || "full");
    return {
      generated: false,
      sleepMs: Math.max(100, Math.min(1_000, retryAtMs - now)),
    };
  }
  if (room.generationPauseKind === "cooldown" && retryAtMs <= now) {
    await clearGenerationPause();
  }

  const latest = await getLatestClip();
  const adaptive = await bufferSnapshot(latest, room.generationMode || "full");
  const bufferedUntilMs = clipEndMs(latest) || 0;

  if (latest && adaptive.bufferMs >= adaptive.targetBufferMs) {
    // The prompt market remains live while the worker sits on a healthy 2–3 clip reserve.
    await ensurePromptRound(
      await nextEpisode(),
      bufferedUntilMs,
      adaptive.adaptiveLeadMs,
    );
    return {
      generated: false,
      sleepMs: Math.max(
        100,
        Math.min(500, adaptive.bufferMs - adaptive.targetBufferMs),
      ),
    };
  }

  const ballotSleep = await waitForPromptWindow(
    latest,
    adaptive.adaptiveLeadMs,
  );
  if (ballotSleep > 0) return { generated: false, sleepMs: ballotSleep };

  if (!acquireRoomLease(owner, LEASE_TTL_MS)) {
    return { generated: false, sleepMs: IDLE_POLL_MS };
  }

  const heartbeat = setInterval(
    () => {
      renewRoomLease(owner, LEASE_TTL_MS);
    },
    Math.max(1_000, Math.floor(LEASE_TTL_MS / 3)),
  );

  try {
    await recoverGeneratingDirectives();

    const lockedRoom = await getRoomRow();
    const lockedLatest = await getLatestClip();
    const lockedBufferUntil = clipEndMs(lockedLatest) || 0;
    const lockedAdaptive = await bufferSnapshot(
      lockedLatest,
      lockedRoom.generationMode || "full",
    );

    if (
      !lockedRoom.running ||
      (lockedLatest && lockedAdaptive.bufferMs >= lockedAdaptive.targetBufferMs)
    ) {
      return { generated: false, sleepMs: IDLE_POLL_MS };
    }

    const episode = await nextEpisode();
    const queued = await hasQueuedDirective();

    if (lockedLatest && !queued) {
      const round = await ensurePromptRound(
        episode,
        lockedBufferUntil,
        lockedAdaptive.adaptiveLeadMs,
      );
      const now = Date.now();
      const bufferMs = Math.max(0, lockedBufferUntil - now);
      if (
        round &&
        now < round.closesAtMs &&
        bufferMs > lockedAdaptive.adaptiveLeadMs
      ) {
        return {
          generated: false,
          sleepMs: Math.max(25, Math.min(500, round.closesAtMs - now)),
        };
      }

      await arbitrationMeasure.measure(
        { label: "Select scene winner", episode },
        () => commitPromptRound(episode),
      );
    }

    // Pipeline the market: while episode N is rendering, viewers vote on N+1.
    // The projected end includes the clip we are about to append to the timeline.
    const projectedStartMs = lockedLatest
      ? Math.max(lockedBufferUntil, Date.now() + 75)
      : Date.now() + 900;
    const projectedBufferUntil = projectedStartMs + BUFFER_CLIP_MS;
    await arbitrationMeasure.measure("Open pipelined scene ballot", () =>
      ensurePromptRound(
        episode + 1,
        projectedBufferUntil,
        lockedAdaptive.adaptiveLeadMs,
      ),
    );

    const mode = lockedLatest ? lockedAdaptive.recommendedMode : "full";
    await setWorkerState("generating", null, mode);

    let clip;
    try {
      clip = await generateNextClip({
        previousClip: lockedLatest,
        resolution: lockedRoom.resolution,
        mode,
      });
    } catch (error) {
      const failures = Number(lockedRoom.generationFailureCount || 0) + 1;
      const recovery = classifyGenerationFailure(error, failures);
      await setGenerationPause({ ...recovery, failureCount: failures });
      return {
        generated: false,
        sleepMs: Math.max(
          250,
          Math.min(1_000, recovery.retryAtMs - Date.now()),
        ),
      };
    }

    const finishedAtMs = Date.now();
    if (MIN_GENERATION_INTERVAL_MS > 0) {
      await setGenerationPause({
        kind: "cooldown",
        reason: `Intentional generation spacing is active (${Math.round(MIN_GENERATION_INTERVAL_MS / 100) / 10}s between renders). Replays remain available during the gap.`,
        retryAtMs: finishedAtMs + MIN_GENERATION_INTERVAL_MS,
        failureCount: 0,
      });
    } else {
      await clearGenerationPause(finishedAtMs);
      await setWorkerState("idle", null, mode);
    }

    const postAdaptive = await bufferSnapshot(clip, mode);
    await arbitrationMeasure.measure("Sync next scene ballot", () =>
      ensurePromptRound(
        clip.episode + 1,
        clip.startsAtMs + clip.durationSeconds * 1000,
        postAdaptive.adaptiveLeadMs,
      ),
    );

    return { generated: true, sleepMs: 40 };
  } finally {
    clearInterval(heartbeat);
    releaseRoomLease(owner);
  }
}

export async function runRoomWorker() {
  console.log(`[worker] slop room worker ${owner}`);

  while (!stopping) {
    const result = await workerMeasure.measure("Room tick", () =>
      generationTick(),
    );
    if (!result) {
      await setWorkerState(
        "error",
        "Generation tick failed; retrying automatically.",
      );
      await sleep(ERROR_BACKOFF_MS);
      continue;
    }
    await sleep(result.sleepMs);
  }

  releaseRoomLease(owner);
}

export function stopRoomWorker() {
  stopping = true;
  releaseRoomLease(owner);
}
