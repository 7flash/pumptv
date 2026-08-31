import { hostname } from "node:os";
import { generateNextClip } from "./generate.ts";
import { classifyGenerationFailure } from "./generation-recovery.ts";
import { acquireRoomLease, releaseRoomLease, renewRoomLease } from "./lease.ts";
import { workerMeasure } from "./observability.ts";
import { dbPath } from "./db.ts";
import {
  clearGenerationPause,
  closePromptRoundIfDue,
  ensureOpenPromptRound,
  getLatestClip,
  getRoomRow,
  getOpenPromptRound,
  hasQueuedDirective,
  nextEpisode,
  recoverGeneratingDirectives,
  setGenerationPause,
  setWorkerState,
  touchWorkerHeartbeat,
} from "./repository.ts";

const LEASE_TTL_MS = Number(process.env.PUMPTV_LEASE_TTL_MS || 30_000);
const IDLE_POLL_MS = Math.max(
  150,
  Number(process.env.PUMPTV_IDLE_POLL_MS || 500),
);
const ERROR_BACKOFF_MS = Number(process.env.PUMPTV_ERROR_BACKOFF_MS || 2_000);
const WEB_HEARTBEAT_TTL_MS = Math.max(
  3_000,
  Number(process.env.PUMPTV_WEB_HEARTBEAT_TTL_MS || 6_000),
);
const MIN_GENERATION_INTERVAL_MS = Math.max(
  0,
  Number(process.env.PUMPTV_MIN_GENERATION_INTERVAL_MS || 0),
);
const WORKER_HEARTBEAT_MS = Math.max(
  500,
  Number(process.env.PUMPTV_WORKER_HEARTBEAT_MS || 1_000),
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const owner = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
let stopping = false;

async function generationTick() {
  await touchWorkerHeartbeat();
  const room = await getRoomRow();

  const webHeartbeat = Number(room.webHeartbeatAtMs || 0);
  if (!webHeartbeat || Date.now() - webHeartbeat > WEB_HEARTBEAT_TTL_MS) {
    console.log(`[worker] web owner heartbeat lost; stopping worker`);
    stopping = true;
    return { generated: false, sleepMs: 0 };
  }

  const falKey = (process.env.FAL_KEY || "").trim();
  if (!falKey) {
    const reason = "FAL_KEY is missing.";
    if (
      room.generationPauseKind !== "config" ||
      room.generationPauseReason !== reason
    ) {
      await setGenerationPause({
        kind: "config",
        reason,
        retryAtMs: Date.now() + 86_400_000,
        failureCount: 0,
      });
    }
    await setWorkerState("idle", null, "full");
    return { generated: false, sleepMs: 1_000 };
  }

  if (room.generationPauseKind === "config") await clearGenerationPause();
  if (!room.running) {
    await setWorkerState("idle", null, "full");
    return { generated: false, sleepMs: 1_000 };
  }

  const now = Date.now();
  const retryAtMs =
    room.generationRetryAtMs == null ? 0 : Number(room.generationRetryAtMs);
  if (room.generationPauseKind && retryAtMs > now) {
    await setWorkerState("idle", null, "full");
    return {
      generated: false,
      sleepMs: Math.max(100, Math.min(1_000, retryAtMs - now)),
    };
  }
  if (room.generationPauseKind && retryAtMs <= now)
    await clearGenerationPause();

  const latest = await getLatestClip();
  const opening = !latest;

  if (opening) {
    // Viewers can start suggesting EP 2 while the opening is still rendering.
    await ensureOpenPromptRound(1);
  } else {
    await closePromptRoundIfDue();
    if (!(await hasQueuedDirective())) {
      await ensureOpenPromptRound(await nextEpisode());
      await setWorkerState("idle", null, "full");
      const round = await getOpenPromptRound();
      const untilClose = round?.closesAtMs
        ? Math.max(80, round.closesAtMs - Date.now())
        : IDLE_POLL_MS;
      return { generated: false, sleepMs: Math.min(IDLE_POLL_MS, untilClose) };
    }
    // Never render more than one episode ahead of the published/live edge.
    if (latest.startsAtMs > Date.now()) {
      await setWorkerState("idle", null, "full");
      return {
        generated: false,
        sleepMs: Math.min(
          IDLE_POLL_MS,
          Math.max(80, latest.startsAtMs - Date.now()),
        ),
      };
    }
  }

  if (!acquireRoomLease(owner, LEASE_TTL_MS)) {
    return { generated: false, sleepMs: IDLE_POLL_MS };
  }

  const leaseHeartbeat = setInterval(
    () => {
      renewRoomLease(owner, LEASE_TTL_MS);
    },
    Math.max(1_000, Math.floor(LEASE_TTL_MS / 3)),
  );
  const workerHeartbeat = setInterval(() => {
    void touchWorkerHeartbeat().catch(() => {});
  }, WORKER_HEARTBEAT_MS);

  try {
    await recoverGeneratingDirectives();

    const lockedRoom = await getRoomRow();
    const lockedLatest = await getLatestClip();
    const lockedOpening = !lockedLatest;
    if (!lockedRoom.running) return { generated: false, sleepMs: IDLE_POLL_MS };
    if (!lockedOpening) {
      await closePromptRoundIfDue();
      if (!(await hasQueuedDirective())) {
        await setWorkerState("idle", null, "full");
        return { generated: false, sleepMs: IDLE_POLL_MS };
      }
      if (lockedLatest.startsAtMs > Date.now())
        return { generated: false, sleepMs: IDLE_POLL_MS };
    }

    const episode = await nextEpisode();
    console.log(
      `[worker] generating EP ${episode + 1} · ${lockedRoom.resolution} · ${lockedOpening ? "opening" : "pump.fun prompt"}`,
    );
    await setWorkerState("generating", null, "full");

    let clip;
    try {
      clip = await workerMeasure.measure.assert(
        {
          label: "Generate episode",
          episode,
          resolution: lockedRoom.resolution,
          mode: "full",
        },
        () =>
          generateNextClip({
            previousClip: lockedLatest,
            resolution: lockedRoom.resolution,
            mode: "full",
          }),
      );
    } catch (error) {
      const failures = Number(lockedRoom.generationFailureCount || 0) + 1;
      const recovery = classifyGenerationFailure(error, failures);
      console.error(
        `[worker] generation paused · ${recovery.kind} · ${recovery.reason}`,
      );
      await setGenerationPause({ ...recovery, failureCount: failures });
      return {
        generated: false,
        sleepMs: Math.max(
          250,
          Math.min(1_000, recovery.retryAtMs - Date.now()),
        ),
      };
    }

    console.log(
      `[worker] published EP ${clip.episode + 1} · ${clip.totalGenerationMs ?? 0}ms`,
    );
    const finishedAtMs = Date.now();
    await ensureOpenPromptRound(clip.episode + 1);

    if (MIN_GENERATION_INTERVAL_MS > 0) {
      await setGenerationPause({
        kind: "cooldown",
        reason: `Generation spacing: ${MIN_GENERATION_INTERVAL_MS}ms`,
        retryAtMs: finishedAtMs + MIN_GENERATION_INTERVAL_MS,
        failureCount: 0,
      });
    } else {
      await clearGenerationPause(finishedAtMs);
      await setWorkerState("idle", null, "full");
    }

    return { generated: true, sleepMs: 80 };
  } finally {
    clearInterval(leaseHeartbeat);
    clearInterval(workerHeartbeat);
    releaseRoomLease(owner);
  }
}

export async function runRoomWorker() {
  console.log(`[worker] PumpTV room worker ${owner}`);
  console.log(
    `[worker] cwd=${process.cwd()} · FAL_KEY=${(process.env.FAL_KEY || "").trim() ? "present" : "missing"} · room=${process.env.PUMPTV_ROOM || "main"}`,
  );
  console.log(
    `[worker] jsx-ai=${process.env.JSX_AI_RUNTIME || "default"}/${process.env.JSX_AI_MODEL || "runtime-default"}`,
  );
  console.log(`[worker] db=${dbPath}`);

  while (!stopping) {
    try {
      const result = await generationTick();
      await sleep(result.sleepMs);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error || "Unknown worker error");
      console.error(`[worker] tick failed · ${message}`);
      await setWorkerState("error", message);
      await sleep(ERROR_BACKOFF_MS);
    }
  }

  releaseRoomLease(owner);
}

export function stopRoomWorker() {
  stopping = true;
  releaseRoomLease(owner);
}
