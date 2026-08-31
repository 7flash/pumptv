import { hostname } from "node:os";
import {
  commitPromptRound,
  ensurePromptRound,
  GENERATION_LEAD_MS,
} from "./arbitration.ts";
import { generateNextClip } from "./generate.ts";
import { acquireRoomLease, releaseRoomLease, renewRoomLease } from "./lease.ts";
import { arbitrationMeasure, workerMeasure } from "./observability.ts";
import {
  getLatestClip,
  getRoomRow,
  hasQueuedDirective,
  nextEpisode,
  recoverGeneratingDirectives,
  setWorkerState,
} from "./repository.ts";

const LEASE_TTL_MS = Number(process.env.SLOP_LEASE_TTL_MS || 30_000);
const TARGET_BUFFER_MS = Number(process.env.SLOP_TARGET_BUFFER_MS || 6_500);
const IDLE_POLL_MS = Number(process.env.SLOP_IDLE_POLL_MS || 250);
const ERROR_BACKOFF_MS = Number(process.env.SLOP_ERROR_BACKOFF_MS || 2_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const owner = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
let stopping = false;

function clipEndMs(clip: Awaited<ReturnType<typeof getLatestClip>>) {
  return clip ? clip.startsAtMs + clip.durationSeconds * 1000 : null;
}

async function waitForPromptWindow(
  latest: Awaited<ReturnType<typeof getLatestClip>>,
) {
  if (!latest) return 0;
  if (await hasQueuedDirective()) return 0;

  const episode = await nextEpisode();
  const endMs = clipEndMs(latest);
  const round = await arbitrationMeasure.measure("Ensure scene ballot", () =>
    ensurePromptRound(episode, endMs),
  );
  if (!round) return 0;

  const now = Date.now();
  const bufferMs = Math.max(0, (endMs || now) - now);
  if (now >= round.closesAtMs) return 0;

  // Never preserve voting at the expense of an underrun. Once only the expected
  // generation lead remains, close early and let the generator start.
  if (bufferMs <= GENERATION_LEAD_MS) return 0;
  return Math.max(25, Math.min(500, round.closesAtMs - now));
}

async function generationTick() {
  const room = await getRoomRow();
  if (!room.running) {
    await setWorkerState("idle", null);
    return { generated: false, sleepMs: 1_000 };
  }

  const latest = await getLatestClip();
  const now = Date.now();
  const bufferedUntilMs = clipEndMs(latest) || 0;
  const bufferMs = bufferedUntilMs - now;

  if (latest && bufferMs >= TARGET_BUFFER_MS) {
    // The scene ballot remains live while enough generated video exists.
    await ensurePromptRound(await nextEpisode(), bufferedUntilMs);
    return {
      generated: false,
      sleepMs: Math.max(100, Math.min(500, bufferMs - TARGET_BUFFER_MS)),
    };
  }

  const ballotSleep = await waitForPromptWindow(latest);
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

    if (
      !lockedRoom.running ||
      (lockedLatest && lockedBufferUntil - Date.now() >= TARGET_BUFFER_MS)
    ) {
      return { generated: false, sleepMs: IDLE_POLL_MS };
    }

    const episode = await nextEpisode();
    const queued = await hasQueuedDirective();

    if (lockedLatest && !queued) {
      const round = await ensurePromptRound(episode, lockedBufferUntil);
      const now = Date.now();
      const bufferMs = lockedBufferUntil - now;
      if (round && now < round.closesAtMs && bufferMs > GENERATION_LEAD_MS) {
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

    await setWorkerState("generating", null);
    const clip = await generateNextClip({
      previousClip: lockedLatest,
      resolution: lockedRoom.resolution,
    });
    await setWorkerState("idle", null);

    await arbitrationMeasure.measure("Open next scene ballot", () =>
      ensurePromptRound(
        clip.episode + 1,
        clip.startsAtMs + clip.durationSeconds * 1000,
      ),
    );

    return { generated: true, sleepMs: 50 };
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
