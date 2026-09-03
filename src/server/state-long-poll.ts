import type { StreamState } from "../shared/contracts.ts";
import { db } from "./db.ts";
import { getViewerCount, touchViewer } from "./presence.ts";
import { getRuntimeStreamState } from "./runtime-state.ts";

const ROOM_NAME = process.env.PUMPTV_ROOM || "main";
const CHECK_MS = Math.max(
  200,
  Number(process.env.PUMPTV_LONG_POLL_CHECK_MS || 400),
);
const TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.PUMPTV_LONG_POLL_TIMEOUT_MS || 25_000),
);

type PollResult = {
  revision: number;
  state: StreamState | null;
};

type Waiter = {
  since: number;
  resolve: (value: PollResult) => void;
  timeout: ReturnType<typeof setTimeout>;
  abort?: () => void;
};

let revision = 0;
let cachedState: StreamState | null = null;
let lastLightKey = "";
let checking = false;
let checkTimer: ReturnType<typeof setTimeout> | null = null;
const waiters = new Set<Waiter>();

function tableStamp(table: string) {
  const row =
    db.raw<any>(
      `SELECT COALESCE(MAX(id), 0) AS maxId,
              COALESCE(MAX(updatedAt), '') AS updatedAt,
              COUNT(*) AS count
       FROM ${table}`,
    )[0] || {};
  return [
    Number(row.maxId || 0),
    String(row.updatedAt || ""),
    Number(row.count || 0),
  ];
}

function roundStamp() {
  const row =
    db.raw<any>(
      `SELECT COALESCE(MAX(id), 0) AS maxId,
              COALESCE(MAX(updatedAt), '') AS updatedAt,
              COUNT(*) AS count,
              COALESCE(MAX(closesAtMs), 0) AS closesAtMs,
              COALESCE(MAX(votingStartedAtMs), 0) AS votingStartedAtMs,
              COALESCE(MAX(closedAtMs), 0) AS closedAtMs,
              COALESCE(MAX(winnerProposalId), 0) AS winnerProposalId
       FROM promptRounds`,
    )[0] || {};
  return [
    Number(row.maxId || 0),
    String(row.updatedAt || ""),
    Number(row.count || 0),
    Number(row.closesAtMs || 0),
    Number(row.votingStartedAtMs || 0),
    Number(row.closedAtMs || 0),
    Number(row.winnerProposalId || 0),
  ];
}

/**
 * Cheap, unmeasured change detector. The expensive measured StreamState query
 * only runs after a meaningful change. Exact heartbeat timestamps are excluded,
 * but the derived online/offline bit is included.
 */
function lightKey() {
  const now = Date.now();
  const room =
    db.raw<any>(
      `SELECT running, resolution, workerState, lastError,
              heartbeatAtMs, generationStage, generationStartedAtMs,
              generationMode, generationPauseKind, generationPauseReason,
              generationRetryAtMs, generationFailureCount
       FROM rooms
       WHERE name = ?
       ORDER BY id ASC LIMIT 1`,
      ROOM_NAME,
    )[0] || {};
  const workerHeartbeatAtMs = Number(room.heartbeatAtMs || 0);
  const workerOnline =
    workerHeartbeatAtMs > 0 && now - workerHeartbeatAtMs < 5_000;
  const published =
    db.raw<any>(
      `SELECT COUNT(*) AS count, COALESCE(MAX(id), 0) AS maxId
       FROM clips WHERE startsAtMs <= ?`,
      now,
    )[0] || {};

  return JSON.stringify({
    room: [
      Boolean(room.running),
      room.resolution || null,
      room.workerState || null,
      room.lastError || null,
      workerOnline,
      room.generationStage || null,
      room.generationStartedAtMs == null
        ? null
        : Number(room.generationStartedAtMs),
      room.generationMode || null,
      room.generationPauseKind || null,
      room.generationPauseReason || null,
      room.generationRetryAtMs == null
        ? null
        : Number(room.generationRetryAtMs),
      Number(room.generationFailureCount || 0),
    ],
    published: [Number(published.count || 0), Number(published.maxId || 0)],
    clips: tableStamp("clips"),
    directives: tableStamp("directives"),
    rounds: roundStamp(),
    proposals: tableStamp("proposals"),
    votes: tableStamp("proposalVotes"),
    world: tableStamp("worldStateSnapshots"),
    viewers: getViewerCount(),
  });
}

function settle(waiter: Waiter, value: PollResult) {
  if (!waiters.delete(waiter)) return;
  clearTimeout(waiter.timeout);
  waiter.abort?.();
  waiter.resolve(value);
}

function releaseChangedWaiters() {
  for (const waiter of [...waiters]) {
    if (waiter.since !== revision) {
      settle(waiter, { revision, state: cachedState });
    }
  }
}

async function refreshIfChanged(force = false) {
  if (checking) return;
  checking = true;
  try {
    const key = lightKey();
    if (force || !cachedState || key !== lastLightKey) {
      lastLightKey = key;
      cachedState = await getRuntimeStreamState();
      revision += 1;
      releaseChangedWaiters();
    }
  } finally {
    checking = false;
  }
}

function scheduleCheck() {
  if (checkTimer || waiters.size === 0) return;
  checkTimer = setTimeout(async () => {
    checkTimer = null;
    try {
      await refreshIfChanged(false);
    } finally {
      if (waiters.size > 0) scheduleCheck();
    }
  }, CHECK_MS);
}

export async function longPollState(input: {
  viewerId: string;
  since: number;
  signal?: AbortSignal;
}): Promise<PollResult> {
  touchViewer(input.viewerId);
  await refreshIfChanged(!cachedState);
  if (input.since !== revision) return { revision, state: cachedState };

  return new Promise<PollResult>((resolve) => {
    const waiter: Waiter = {
      since: input.since,
      resolve,
      timeout: setTimeout(() => {
        settle(waiter, { revision, state: null });
      }, TIMEOUT_MS),
    };

    if (input.signal) {
      const onAbort = () => settle(waiter, { revision, state: null });
      input.signal.addEventListener("abort", onAbort, { once: true });
      waiter.abort = () => input.signal?.removeEventListener("abort", onAbort);
    }

    waiters.add(waiter);
    scheduleCheck();
  });
}
