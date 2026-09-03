import { hostname } from "node:os";
import type { Directive } from "../shared/contracts.ts";
import { generateClaimedClip } from "./generate.ts";
import { classifyGenerationFailure } from "./generation-recovery.ts";
import { acquireRoomLease, releaseRoomLease, renewRoomLease } from "./lease.ts";
import { workerMeasure } from "./observability.ts";
import { dbPath } from "./db.ts";
import { PrewarmController } from "./prewarm.ts";
import { kickRewardProcessor } from "./rewards.ts";
import {
  autoTriggerNextProposalIfDue,
  claimQueuedDirective,
  clearExpiredPrewarmSlot,
  clearGenerationPause,
  ensureOpenPromptRound,
  getLatestClip,
  getRoomRow,
  hasQueuedDirective,
  nextEpisode,
  peekQueuedDirective,
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
const prewarm = new PrewarmController(`prewarm:${owner}`);
let stopping = false;

function serviceWinnerRewards() {
  void kickRewardProcessor().catch((error) => {
    workerMeasure.measureSync("Winner reward processor failed", () => ({
      error: error instanceof Error ? error.message : String(error),
    }));
  });
}

async function maybeAutoLock(now = Date.now()) {
  let queued = await hasQueuedDirective();
  if (!queued) {
    const automatic = await autoTriggerNextProposalIfDue(now);
    queued = Boolean(automatic) || (await hasQueuedDirective());
  }
  return queued;
}

async function waitForPrewarmIfWinnerIsAlreadyRendering(
  queuedDirective: Directive | null,
) {
  if (!(await prewarm.shouldWaitForLockedDirective(queuedDirective)))
    return false;
  await setWorkerState("idle", null, "full");
  return true;
}

async function generationTick() {
  serviceWinnerRewards();
  await touchWorkerHeartbeat();
  const room = await getRoomRow();

  const webHeartbeat = Number(room.webHeartbeatAtMs || 0);
  if (!webHeartbeat || Date.now() - webHeartbeat > WEB_HEARTBEAT_TTL_MS) {
    workerMeasure.measureSync("Web owner heartbeat lost; stopping worker");
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
    await prewarm.stop("room stopped");
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
    const queued = await maybeAutoLock(now);
    const queuedDirective = queued ? await peekQueuedDirective() : null;

    if (await waitForPrewarmIfWinnerIsAlreadyRendering(queuedDirective)) {
      return { generated: false, sleepMs: Math.min(IDLE_POLL_MS, 250) };
    }

    if (!queued) {
      const round = await ensureOpenPromptRound(await nextEpisode());
      await prewarm.syncWithOpenRound(round);
      await prewarm.maybeStart({
        round,
        previousClip: latest,
        resolution: room.resolution,
        now,
      });
      await setWorkerState("idle", null, "full");
      return { generated: false, sleepMs: IDLE_POLL_MS };
    }

    // Never publish more than one episode ahead of the published/live edge.
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

    let queuedDirective: Directive | null = null;
    if (!lockedOpening) {
      const queued = await maybeAutoLock();
      if (!queued) {
        await setWorkerState("idle", null, "full");
        return { generated: false, sleepMs: IDLE_POLL_MS };
      }

      queuedDirective = await peekQueuedDirective();
      if (await waitForPrewarmIfWinnerIsAlreadyRendering(queuedDirective)) {
        return { generated: false, sleepMs: Math.min(IDLE_POLL_MS, 250) };
      }
      if (lockedLatest.startsAtMs > Date.now())
        return { generated: false, sleepMs: IDLE_POLL_MS };
    }

    const episode = await nextEpisode();
    let clip;

    try {
      if (lockedOpening) {
        await setWorkerState("generating", null, "full");
        clip = await workerMeasure.measure(
          {
            start: () =>
              `Generate EP ${episode + 1} · ${lockedRoom.resolution} · opening`,
            end: (result) => ({
              episode: result.episode + 1,
              totalMs: result.totalGenerationMs ?? null,
              directive: result.directive,
            }),
          },
          () =>
            generateClaimedClip({
              previousClip: null,
              resolution: lockedRoom.resolution,
              mode: "full",
              episode,
              directive: null,
            }),
        );
      } else {
        const claimed = await claimQueuedDirective(episode);
        if (!claimed)
          throw new Error(
            "No triggered proposal is queued for the next episode.",
          );

        let usedPrewarm = false;
        clip = await workerMeasure.measure(
          {
            start: () =>
              `Resolve EP ${episode + 1} · ${lockedRoom.resolution} · proposal #${claimed.proposalId ?? "?"}`,
            end: (result) => ({
              episode: result.episode + 1,
              totalMs: result.totalGenerationMs ?? null,
              directive: result.directive,
              prewarmed: usedPrewarm,
            }),
          },
          async () => {
            const promotion = await prewarm.promoteIfReady({
              episode,
              claimed,
            });
            if (promotion.kind === "promoted") {
              usedPrewarm = true;
              return promotion.clip;
            }

            const canonicalDirective =
              promotion.kind === "rejected"
                ? await claimQueuedDirective(episode)
                : claimed;
            if (!canonicalDirective)
              throw new Error(
                "Locked directive disappeared before canonical generation",
              );

            await setWorkerState("generating", null, "full");
            return generateClaimedClip({
              previousClip: lockedLatest,
              resolution: lockedRoom.resolution,
              mode: "full",
              episode,
              directive: canonicalDirective,
            });
          },
        );
      }
    } catch (error) {
      const failures = Number(lockedRoom.generationFailureCount || 0) + 1;
      const recovery = classifyGenerationFailure(error, failures);
      workerMeasure.measureSync("Generation paused", () => ({
        kind: recovery.kind,
        reason: recovery.reason,
        retryAtMs: recovery.retryAtMs,
      }));
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
  await clearExpiredPrewarmSlot();
  serviceWinnerRewards();

  workerMeasure.measureSync(
    {
      start: () => `PumpTV worker ${owner}`,
      end: (info) => info,
    },
    () => ({
      cwd: process.cwd(),
      room: process.env.PUMPTV_ROOM || "main",
      db: dbPath,
      fal: (process.env.FAL_KEY || "").trim() ? "present" : "missing",
      jsxAI: `${process.env.JSX_AI_RUNTIME || "default"}/${process.env.JSX_AI_MODEL || "runtime-default"}`,
      prewarm: prewarm.policy,
    }),
  );

  while (!stopping) {
    try {
      const result = await generationTick();
      await sleep(result.sleepMs);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error || "Unknown worker error");
      workerMeasure.measureSync("Worker tick failed", () => ({
        error: message,
      }));
      await setWorkerState("error", message);
      await sleep(ERROR_BACKOFF_MS);
    }
  }

  await prewarm.stop();
  releaseRoomLease(owner);
}

export function stopRoomWorker() {
  stopping = true;
  prewarm.stopSoon();
  releaseRoomLease(owner);
}
