import { hostname } from "node:os";
import { generateNextClip } from "./generate.ts";
import { acquireRoomLease, releaseRoomLease, renewRoomLease } from "./lease.ts";
import { workerMeasure } from "./observability.ts";
import {
  getLatestClip,
  getRoomRow,
  recoverGeneratingDirectives,
  setWorkerState,
} from "./repository.ts";

const LEASE_TTL_MS = Number(process.env.SLOP_LEASE_TTL_MS || 30_000);
const TARGET_BUFFER_MS = Number(process.env.SLOP_TARGET_BUFFER_MS || 6_500);
const IDLE_POLL_MS = Number(process.env.SLOP_IDLE_POLL_MS || 500);
const ERROR_BACKOFF_MS = Number(process.env.SLOP_ERROR_BACKOFF_MS || 2_000);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const owner = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
let stopping = false;

async function generationTick() {
  const room = await getRoomRow();
  if (!room.running) {
    await setWorkerState("idle", null);
    return { generated: false, sleepMs: 1_000 };
  }

  const latest = await getLatestClip();
  const now = Date.now();
  const bufferedUntilMs = latest
    ? latest.startsAtMs + latest.durationSeconds * 1000
    : 0;
  const bufferMs = bufferedUntilMs - now;

  if (latest && bufferMs >= TARGET_BUFFER_MS) {
    return {
      generated: false,
      sleepMs: Math.max(200, Math.min(1_000, bufferMs - TARGET_BUFFER_MS)),
    };
  }

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
    // Only the lease holder may recover a directive abandoned by a crashed generator.
    await recoverGeneratingDirectives();

    // Re-read after acquiring the lease because another worker may have generated
    // between our optimistic buffer check and lease acquisition.
    const lockedRoom = await getRoomRow();
    const lockedLatest = await getLatestClip();
    const lockedBufferUntil = lockedLatest
      ? lockedLatest.startsAtMs + lockedLatest.durationSeconds * 1000
      : 0;

    if (
      !lockedRoom.running ||
      (lockedLatest && lockedBufferUntil - Date.now() >= TARGET_BUFFER_MS)
    ) {
      return { generated: false, sleepMs: IDLE_POLL_MS };
    }

    await setWorkerState("generating", null);
    await generateNextClip({
      previousClip: lockedLatest,
      resolution: lockedRoom.resolution,
    });
    await setWorkerState("idle", null);
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
