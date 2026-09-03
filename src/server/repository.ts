import type {
  Clip,
  Directive,
  DirectiveSource,
  GenerationMode,
  GenerationStage,
  GenerationTimingSample,
  PumpChatState,
  PromptProposal,
  PromptRound,
  PrewarmStage,
  Resolution,
  RoomState,
  StreamState,
  WorkerState,
  WorldState,
  WorldStateAudit,
} from "../shared/contracts.ts";
import { evaluateBuffer } from "./adaptive-buffer.ts";
import { db } from "./db.ts";
import { ROOM_NAME } from "./lease.ts";
import { dbMeasure } from "./observability.ts";
import { EMPTY_WORLD_STATE, parseWorldStateJson } from "./world-state.ts";
import { getViewerCount } from "./presence.ts";
import { deriveLiveProgramState } from "./program-state.ts";

const PUMPFUN_MINT = (process.env.PUMPTV_PUMPFUN_MINT || "").trim();
const PUMPFUN_PREFIX = process.env.PUMPTV_PUMPFUN_PREFIX ?? "!next";
const VOTE_WINDOW_MS = Math.max(
  1_000,
  Number(process.env.PUMPTV_VOTE_WINDOW_MS || 15_000),
);
const MAX_PROPOSALS_PER_ROUND = Math.max(
  2,
  Number(process.env.PUMPTV_MAX_PROPOSALS_PER_ROUND || 40),
);
const AUTO_TRIGGER_ENABLED = process.env.PUMPTV_AUTO_TRIGGER !== "0";
const SOLO_DECISION_MS = Math.max(
  5_000,
  Number(process.env.PUMPTV_SOLO_DECISION_MS || 20_000),
);
const VOTING_BASE_MS = Math.max(
  8_000,
  Number(process.env.PUMPTV_VOTING_BASE_MS || 15_000),
);
const VOTING_MIN_MS = Math.max(
  5_000,
  Math.min(
    VOTING_BASE_MS,
    Number(process.env.PUMPTV_AUTO_TRIGGER_MIN_MS || 8_000),
  ),
);
const VOTING_GUARANTEE_MS = Math.max(
  VOTING_MIN_MS,
  Number(process.env.PUMPTV_VOTING_GUARANTEE_MS || 10_000),
);
const AUTO_TRIGGER_IDEA_STEP_MS = Math.max(
  0,
  Number(process.env.PUMPTV_AUTO_TRIGGER_IDEA_STEP_MS || 2_000),
);
const AUTO_TRIGGER_VOTE_STEP_MS = Math.max(
  0,
  Number(process.env.PUMPTV_AUTO_TRIGGER_VOTE_STEP_MS || 1_000),
);

export class DecisionWindowClosedError extends Error {}

function assertRoundAcceptingActivity(round: PromptRound) {
  if (round.status !== "open")
    throw new DecisionWindowClosedError("This decision is already closed.");
  if (round.closesAtMs > 0 && Date.now() >= round.closesAtMs)
    throw new DecisionWindowClosedError(
      "This decision is locking now. Wait for the next board before participating again.",
    );
}

function toClip(row: any): Clip {
  return {
    id: Number(row.id),
    requestId: row.requestId,
    videoUrl: row.videoUrl,
    expandedPrompt: row.expandedPrompt ?? null,
    h3Prompt: row.h3Prompt ?? null,
    inferenceSeconds: row.inferenceSeconds ?? null,
    directive: row.directive,
    directiveId: row.directiveId ?? null,
    episode: Number(row.episode),
    anchorFrameUrl: row.anchorFrameUrl ?? null,
    startFrameUrl: row.startFrameUrl ?? row.anchorFrameUrl ?? null,
    middleFrameUrl: row.middleFrameUrl ?? null,
    endFrameUrl: row.endFrameUrl ?? null,
    usedAnchorFrame: Boolean(row.usedAnchorFrame),
    resolution: row.resolution,
    startsAtMs: Number(row.startsAtMs || 0),
    durationSeconds: Number(row.durationSeconds || 5),
    showrunnerModel: row.showrunnerModel ?? null,
    showrunnerPlanJson: row.showrunnerPlanJson ?? null,
    showrunnerInputTokens: row.showrunnerInputTokens ?? null,
    showrunnerOutputTokens: row.showrunnerOutputTokens ?? null,
    generationMode: row.generationMode || "full",
    showrunnerMs: row.showrunnerMs ?? null,
    h3Ms: row.h3Ms ?? null,
    frameSampleMs: row.frameSampleMs ?? null,
    visionMs: row.visionMs ?? null,
    totalGenerationMs: row.totalGenerationMs ?? null,
    directiveSource: row.directiveSource ?? null,
    directiveAuthor: row.directiveAuthor ?? null,
    directiveAuthorAddress: row.directiveAuthorAddress ?? null,
    directiveProposalId:
      row.directiveProposalId == null ? null : Number(row.directiveProposalId),
    directiveVoteCount:
      row.directiveVoteCount == null ? null : Number(row.directiveVoteCount),
  };
}

function toDirective(row: any): Directive {
  return {
    id: Number(row.id),
    text: row.text,
    status: row.status,
    usedEpisode: row.usedEpisode ?? null,
    source: row.source || "web",
    sourceId: row.sourceId ?? null,
    author: row.author ?? null,
    authorAddress: row.authorAddress ?? null,
    sourceRoom: row.sourceRoom ?? null,
    proposalId: row.proposalId ?? null,
    voteCount: row.voteCount == null ? null : Number(row.voteCount),
  };
}

function directiveWithVotesById(id: number) {
  return dbMeasure.measureSync(
    "Load attributed directive",
    () =>
      db.raw<any>(
        `SELECT d.*,
              CASE WHEN d.proposalId IS NULL THEN NULL
                   ELSE (SELECT COALESCE(p.operatorVoteOverride, (SELECT COALESCE(SUM(v.weight), 0) FROM proposalVotes v WHERE v.proposalId = d.proposalId) + COALESCE(p.ownerWeight, 1)) FROM proposals p WHERE p.id = d.proposalId)
              END AS voteCount
       FROM directives d
       WHERE d.id = ?
       LIMIT 1`,
        id,
      )[0] || null,
  );
}

function nextPendingDirectiveWithVotes() {
  return dbMeasure.measureSync(
    {
      start: () => "Load next pending directive",
      end: (row) =>
        row
          ? {
              id: row.id,
              status: row.status,
              proposalId: row.proposalId,
              text: String(row.text || "").slice(0, 80),
            }
          : null,
    },
    () =>
      db.raw<any>(
        `SELECT d.*,
              CASE WHEN d.proposalId IS NULL THEN NULL
                   ELSE (SELECT COALESCE(p.operatorVoteOverride, (SELECT COALESCE(SUM(v.weight), 0) FROM proposalVotes v WHERE v.proposalId = d.proposalId) + COALESCE(p.ownerWeight, 1)) FROM proposals p WHERE p.id = d.proposalId)
              END AS voteCount
       FROM directives d
       WHERE COALESCE(d.triggered, 0) = 1
         AND d.sourceId LIKE 'trigger:%'
         AND d.status IN ('generating', 'queued')
       ORDER BY CASE d.status WHEN 'generating' THEN 0 ELSE 1 END, d.id ASC
       LIMIT 1`,
      )[0] || null,
  );
}

function toRoom(
  row: any,
  bufferedUntilMs: number | null = null,
  buffer?: RoomState["buffer"],
): RoomState {
  return {
    name: row.name,
    running: Boolean(row.running),
    resolution: row.resolution,
    workerState: row.workerState,
    workerOnline:
      Number(row.heartbeatAtMs || 0) > 0 &&
      Date.now() - Number(row.heartbeatAtMs || 0) < 5_000,
    workerHeartbeatAtMs: Number(row.heartbeatAtMs || 0) || null,
    webOwnerPid: row.webOwnerPid == null ? null : Number(row.webOwnerPid),
    webHeartbeatAtMs: Number(row.webHeartbeatAtMs || 0) || null,
    generationStage: row.generationStage || "idle",
    generationStartedAtMs:
      row.generationStartedAtMs == null
        ? null
        : Number(row.generationStartedAtMs),
    prewarm: {
      roundId: row.prewarmRoundId == null ? null : Number(row.prewarmRoundId),
      proposalId:
        row.prewarmProposalId == null ? null : Number(row.prewarmProposalId),
      stage: (row.prewarmStage || "idle") as PrewarmStage,
      startedAtMs:
        row.prewarmStartedAtMs == null ? null : Number(row.prewarmStartedAtMs),
    },
    lastError: row.lastError ?? null,
    bufferedUntilMs,
    buffer:
      buffer ||
      evaluateBuffer({
        bufferMs: 0,
        samples: [],
        activeMode: row.generationMode || "full",
        hasClip: false,
      }),
    pumpfun: {
      enabled: Boolean(PUMPFUN_MINT),
      mint: PUMPFUN_MINT || null,
      prefix: PUMPFUN_PREFIX || null,
      state: PUMPFUN_MINT ? row.pumpChatState || "standby" : "disabled",
      lastError: row.pumpChatError ?? null,
    },
    generation: {
      paused: Boolean(row.generationPauseKind),
      kind: row.generationPauseKind ?? null,
      reason: row.generationPauseReason ?? null,
      retryAtMs:
        row.generationRetryAtMs == null
          ? null
          : Number(row.generationRetryAtMs),
      failureCount: Number(row.generationFailureCount || 0),
    },
    viewerCount: getViewerCount(),
    voteWindowMs: VOTE_WINDOW_MS,
    workerProcess: {
      name: "pumptv-worker",
      state: "unknown",
      pid: null,
      error: null,
      checkedAtMs: 0,
    },
  };
}

export function normalizeResolution(value: unknown): Resolution {
  return value === "768P" ? "768P" : "480P";
}

export async function getRoomRow() {
  let row = await dbMeasure.measureSync(
    {
      start: () => "Load room",
      end: (value) =>
        value
          ? {
              running: Boolean(value.running),
              resolution: value.resolution,
              workerState: value.workerState,
              stage: value.generationStage,
            }
          : null,
    },
    () =>
      db.rooms.select().where({ name: ROOM_NAME }).orderBy("id", "ASC").first(),
  );

  if (!row) {
    row = await dbMeasure.measureSync("Create room", () =>
      db.rooms.insert({ name: ROOM_NAME }),
    );
  }
  if (!row) throw new Error("Room row is missing");

  // Current config is authoritative. A persisted room from an older run must not
  // keep PumpTV at 768P after the repo config moves to 480P.
  const configuredResolution = normalizeResolution(
    process.env.PUMPTV_RESOLUTION,
  );
  if ((row as any).resolution !== configuredResolution) {
    await dbMeasure.measureSync("Sync room resolution", () =>
      db.rooms
        .select()
        .where({ id: (row as any).id })
        .updateAll({ resolution: configuredResolution }),
    );
    row = { ...(row as any), resolution: configuredResolution } as any;
  }

  return row as any;
}

export async function updateRoomSettings(input: {
  running?: boolean;
  resolution?: Resolution;
}) {
  const room = await getRoomRow();
  const patch: Record<string, unknown> = {};
  if (typeof input.running === "boolean") patch.running = input.running;
  if (input.resolution) patch.resolution = input.resolution;
  if (!Object.keys(patch).length) return room;

  await dbMeasure.measureSync("Update room settings", () =>
    db.rooms
      .select()
      .where({ id: room.id })
      .updateAll(patch as any),
  );
  return getRoomRow();
}

export async function touchWorkerHeartbeat() {
  const room = await getRoomRow();
  return dbMeasure.measureSync("Touch worker heartbeat", () =>
    db.rooms
      .select()
      .where({ id: room.id })
      .updateAll({ heartbeatAtMs: Date.now() }),
  );
}

export async function touchWebHeartbeat(pid = process.pid) {
  const room = await getRoomRow();
  return dbMeasure.measureSync("Touch web heartbeat", () =>
    db.rooms
      .select()
      .where({ id: room.id })
      .updateAll({ webOwnerPid: pid, webHeartbeatAtMs: Date.now() }),
  );
}

export async function clearWebHeartbeat(pid = process.pid) {
  const room = await getRoomRow();
  if (Number(room.webOwnerPid || 0) !== pid) return;
  return dbMeasure.measureSync("Clear web heartbeat", () =>
    db.rooms
      .select()
      .where({ id: room.id })
      .updateAll({ webOwnerPid: null, webHeartbeatAtMs: 0 }),
  );
}

export async function setGenerationStage(stage: GenerationStage) {
  const room = await getRoomRow();
  return dbMeasure.measureSync("Set generation stage", () =>
    db.rooms
      .select()
      .where({ id: room.id })
      .updateAll({ generationStage: stage }),
  );
}

export async function claimPrewarmSlot(input: {
  owner: string;
  roundId: number;
  proposalId: number;
  ttlMs: number;
}) {
  return (
    dbMeasure.measureSync(
      {
        start: () => `Claim prewarm #${input.proposalId}`,
        end: (claimed) => ({
          claimed,
          roundId: input.roundId,
          proposalId: input.proposalId,
        }),
      },
      () => {
        const now = Date.now();
        db.exec("BEGIN IMMEDIATE");
        try {
          const room =
            db.raw<any>(
              `SELECT * FROM rooms WHERE name = ? ORDER BY id ASC LIMIT 1`,
              ROOM_NAME,
            )[0] || null;
          if (!room) {
            db.exec("COMMIT");
            return false;
          }
          if (
            room.prewarmOwner &&
            room.prewarmOwner !== input.owner &&
            Number(room.prewarmLeaseUntilMs || 0) > now
          ) {
            db.exec("COMMIT");
            return false;
          }
          db.exec(
            `UPDATE rooms
           SET prewarmOwner = ?, prewarmLeaseUntilMs = ?,
               prewarmRoundId = ?, prewarmProposalId = ?,
               prewarmStartedAtMs = ?, prewarmStage = 'planning'
           WHERE id = ?`,
            input.owner,
            now + input.ttlMs,
            input.roundId,
            input.proposalId,
            now,
            room.id,
          );
          db.exec("COMMIT");
          return true;
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {}
          throw error;
        }
      },
    ) ?? false
  );
}

export async function renewPrewarmSlot(owner: string, ttlMs: number) {
  const room = await getRoomRow();
  return (
    dbMeasure.measureSync("Renew prewarm slot", () => {
      db.exec(
        `UPDATE rooms SET prewarmLeaseUntilMs = ? WHERE id = ? AND prewarmOwner = ?`,
        Date.now() + ttlMs,
        room.id,
        owner,
      );
      const current =
        db.raw<any>(
          `SELECT prewarmOwner FROM rooms WHERE id = ? LIMIT 1`,
          room.id,
        )[0] || null;
      return current?.prewarmOwner === owner;
    }) ?? false
  );
}

export async function setPrewarmStage(owner: string, stage: PrewarmStage) {
  const room = await getRoomRow();
  return dbMeasure.measureSync(
    {
      start: () => `Set prewarm stage · ${stage}`,
      end: () => ({ stage }),
    },
    () =>
      db.rooms
        .select()
        .where({ id: room.id, prewarmOwner: owner } as any)
        .updateAll({ prewarmStage: stage }),
  );
}

export async function clearPrewarmSlot(owner?: string) {
  const room = await getRoomRow();
  if (owner && room.prewarmOwner !== owner) return false;
  return dbMeasure.measureSync("Clear prewarm slot", () =>
    db.rooms.select().where({ id: room.id }).updateAll({
      prewarmRoundId: null,
      prewarmProposalId: null,
      prewarmStartedAtMs: null,
      prewarmStage: "idle",
      prewarmOwner: null,
      prewarmLeaseUntilMs: 0,
    }),
  );
}

export async function clearExpiredPrewarmSlot(now = Date.now()) {
  const room = await getRoomRow();
  if (!room.prewarmOwner || Number(room.prewarmLeaseUntilMs || 0) > now)
    return false;
  return dbMeasure.measureSync("Clear expired prewarm slot", () =>
    db.rooms.select().where({ id: room.id }).updateAll({
      prewarmRoundId: null,
      prewarmProposalId: null,
      prewarmStartedAtMs: null,
      prewarmStage: "idle",
      prewarmOwner: null,
      prewarmLeaseUntilMs: 0,
    }),
  );
}

export async function setWorkerState(
  state: WorkerState,
  error: string | null = null,
  generationMode?: GenerationMode,
) {
  const room = await getRoomRow();
  return dbMeasure.measureSync("Set worker state", () =>
    db.rooms
      .select()
      .where({ id: room.id })
      .updateAll({
        workerState: state,
        lastError: error
          ? error.replace(/\s+/g, " ").trim().slice(0, 600)
          : null,
        ...(state === "generating"
          ? { generationStartedAtMs: Date.now() }
          : { generationStartedAtMs: null, generationStage: "idle" }),
        ...(generationMode ? { generationMode } : {}),
      }),
  );
}

export async function setGenerationPause(input: {
  kind: "config" | "cooldown" | "funds" | "rate_limit" | "provider";
  reason: string;
  retryAtMs: number;
  failureCount?: number;
}) {
  const room = await getRoomRow();
  return dbMeasure.measureSync("Pause generation", () =>
    db.rooms
      .select()
      .where({ id: room.id })
      .updateAll({
        generationPauseKind: input.kind,
        generationPauseReason: input.reason
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 600),
        generationRetryAtMs: input.retryAtMs,
        generationFailureCount:
          input.failureCount ?? Number(room.generationFailureCount || 0),
        workerState: "idle",
        generationStage: "idle",
        generationStartedAtMs: null,
        lastError: null,
      }),
  );
}

export async function clearGenerationPause(lastGenerationAtMs?: number) {
  const room = await getRoomRow();
  return dbMeasure.measureSync("Clear generation pause", () =>
    db.rooms
      .select()
      .where({ id: room.id })
      .updateAll({
        generationPauseKind: null,
        generationPauseReason: null,
        generationRetryAtMs: null,
        generationFailureCount: 0,
        ...(lastGenerationAtMs === undefined ? {} : { lastGenerationAtMs }),
      }),
  );
}

export async function setPumpChatState(
  state: PumpChatState,
  error: string | null = null,
) {
  const room = await getRoomRow();
  return dbMeasure.measureSync("Set Pump.fun chat state", () =>
    db.rooms
      .select()
      .where({ id: room.id })
      .updateAll({
        pumpChatState: state,
        pumpChatError: error
          ? error.replace(/\s+/g, " ").trim().slice(0, 600)
          : null,
      }),
  );
}

function normalizeProposalText(value: string) {
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

function proposalTokens(value: string) {
  return new Set(
    normalizeProposalText(value)
      .split(" ")
      .filter((token) => token.length > 1),
  );
}

function textSimilarity(a: string, b: string) {
  const left = normalizeProposalText(a);
  const right = normalizeProposalText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    const ratio =
      Math.min(left.length, right.length) / Math.max(left.length, right.length);
    if (ratio >= 0.68) return 0.95;
  }

  const aTokens = proposalTokens(left);
  const bTokens = proposalTokens(right);
  let intersection = 0;
  for (const token of aTokens) if (bTokens.has(token)) intersection += 1;
  const union = aTokens.size + bTokens.size - intersection;
  const jaccard = union ? intersection / union : 0;

  const trigrams = (value: string) => {
    const compact = `  ${value} `;
    const out = new Set<string>();
    for (let i = 0; i <= compact.length - 3; i += 1)
      out.add(compact.slice(i, i + 3));
    return out;
  };
  const a3 = trigrams(left);
  const b3 = trigrams(right);
  let shared = 0;
  for (const tri of a3) if (b3.has(tri)) shared += 1;
  const dice = a3.size + b3.size ? (2 * shared) / (a3.size + b3.size) : 0;
  return Math.max(jaccard, dice);
}

function similarProposal(roundId: number, text: string) {
  const rows = db.raw<any>(
    `SELECT * FROM proposals WHERE roundId = ? AND status = 'open' ORDER BY id ASC`,
    roundId,
  );
  let best: any = null;
  let bestScore = 0;
  for (const row of rows) {
    const score = textSimilarity(text, row.text);
    if (score > bestScore) {
      best = row;
      bestScore = score;
    }
  }
  return bestScore >= 0.66 ? best : null;
}

function normalizedHandle(value: string) {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

function proposalFromRow(row: any): PromptProposal {
  const realVoteCount = Number(row.realVoteCount ?? row.voteCount ?? 0);
  const voterCount = Math.max(0, Number(row.voterCount ?? 0));
  const ownerWeight = Math.max(0, Number(row.ownerWeight ?? 1));
  const override =
    row.operatorVoteOverride == null ? null : Number(row.operatorVoteOverride);
  return {
    id: Number(row.id),
    roundId: Number(row.roundId),
    text: row.text,
    status: row.status,
    source: row.source || "pumpfun",
    sourceId: row.sourceId ?? null,
    author: row.author ?? null,
    authorAddress: row.authorAddress ?? null,
    sourceRoom: row.sourceRoom ?? null,
    ownerWeight,
    realVoteCount,
    voterCount,
    operatorVoteOverride: override,
    voteCount: override ?? ownerWeight + realVoteCount,
  };
}

function participantIdentity(row: any) {
  const explicit = String(row.participantKey || "").trim();
  if (explicit) return explicit;
  const sourceId = String(row.sourceId || "").trim();
  if (sourceId) return `${row.source || "unknown"}:${sourceId}`;
  return `proposal:${Number(row.id)}`;
}

function loadRoundById(id: number): PromptRound | null {
  const row =
    db.raw<any>(`SELECT * FROM promptRounds WHERE id = ? LIMIT 1`, id)[0] ||
    null;
  if (!row) return null;
  const proposalRows = db.raw<any>(
    `SELECT p.*,
            (SELECT COALESCE(SUM(v.weight), 0) FROM proposalVotes v WHERE v.proposalId = p.id) AS realVoteCount,
            (SELECT COUNT(DISTINCT COALESCE(v.participantKey, v.voterKey)) FROM proposalVotes v WHERE v.proposalId = p.id) AS voterCount
     FROM proposals p WHERE p.roundId = ?
     ORDER BY COALESCE(p.operatorVoteOverride, COALESCE(p.ownerWeight, 1) + (SELECT COALESCE(SUM(v.weight), 0) FROM proposalVotes v WHERE v.proposalId = p.id)) DESC, p.id ASC`,
    id,
  );
  const proposals = proposalRows.map(proposalFromRow);
  const participantCount = new Set(
    proposalRows
      .filter((proposal: any) => proposal.status === "open")
      .map(participantIdentity),
  ).size;
  const decisionMode =
    proposals.filter((proposal) => proposal.status === "open").length === 0
      ? "waiting"
      : participantCount >= 2
        ? "voting"
        : "solo";
  return {
    id: Number(row.id),
    targetEpisode: Number(row.targetEpisode),
    status: row.status,
    openedAtMs: Number(row.openedAtMs),
    votingStartedAtMs:
      row.votingStartedAtMs == null ? null : Number(row.votingStartedAtMs),
    contestedAtMs: row.contestedAtMs == null ? null : Number(row.contestedAtMs),
    decisionMode,
    participantCount,
    closesAtMs: Number(row.closesAtMs || 0),
    closedAtMs: row.closedAtMs == null ? null : Number(row.closedAtMs),
    winnerProposalId:
      row.winnerProposalId == null ? null : Number(row.winnerProposalId),
    proposals,
  };
}

function votingDelayMs(round: PromptRound) {
  const ideas = Math.max(2, round.proposals.length);
  const outsideVoters = round.proposals.reduce(
    (sum, proposal) => sum + Math.max(0, Number(proposal.voterCount || 0)),
    0,
  );
  const accelerated =
    VOTING_BASE_MS -
    Math.max(0, ideas - 2) * AUTO_TRIGGER_IDEA_STEP_MS -
    Math.min(12, outsideVoters) * AUTO_TRIGGER_VOTE_STEP_MS;
  return Math.max(VOTING_MIN_MS, Math.min(VOTING_BASE_MS, accelerated));
}

function armAutoTriggerForRound(
  roundId: number,
  reason: "proposal" | "vote" | "carry" | "legacy",
  now = Date.now(),
) {
  if (!AUTO_TRIGGER_ENABLED) return null;
  const round = loadRoundById(roundId);
  if (!round || round.status !== "open") return null;

  if (!round.proposals.length) {
    if (
      round.votingStartedAtMs != null ||
      round.contestedAtMs != null ||
      round.closesAtMs !== 0
    ) {
      db.exec(
        `UPDATE promptRounds SET votingStartedAtMs = NULL, contestedAtMs = NULL, closesAtMs = 0 WHERE id = ?`,
        roundId,
      );
    }
    return null;
  }

  const firstArm = round.votingStartedAtMs == null || round.closesAtMs <= 0;
  const enteringVoting =
    round.decisionMode === "voting" && round.contestedAtMs == null;
  let deadline = round.closesAtMs;
  let contestedAtMs = round.contestedAtMs ?? null;

  if (firstArm) {
    deadline =
      round.decisionMode === "voting"
        ? now + VOTING_BASE_MS
        : now + SOLO_DECISION_MS;
  } else if (enteringVoting) {
    // A challenger arriving late gets a real ballot, not a 1-second fake vote.
    // This is the only activity allowed to extend a deadline.
    deadline = Math.max(round.closesAtMs, now + VOTING_GUARANTEE_MS);
  } else if (round.decisionMode === "voting") {
    // Once voting is open, activity can only accelerate the existing deadline.
    deadline = Math.min(round.closesAtMs, now + votingDelayMs(round));
  }

  if (round.decisionMode === "voting" && contestedAtMs == null)
    contestedAtMs = now;
  const startedAtMs = firstArm ? now : round.votingStartedAtMs;

  if (
    firstArm ||
    enteringVoting ||
    deadline !== round.closesAtMs ||
    startedAtMs !== round.votingStartedAtMs ||
    contestedAtMs !== (round.contestedAtMs ?? null)
  ) {
    db.exec(
      `UPDATE promptRounds SET votingStartedAtMs = ?, contestedAtMs = ?, closesAtMs = ? WHERE id = ? AND status = 'open'`,
      startedAtMs,
      contestedAtMs,
      deadline,
      roundId,
    );
    dbMeasure.measureSync(
      {
        start: () =>
          firstArm
            ? round.decisionMode === "voting"
              ? "Arm voting timer"
              : "Arm solo decision timer"
            : enteringVoting
              ? "Open contested voting"
              : "Accelerate voting timer",
        end: (value) => value,
      },
      () => ({
        roundId,
        episode: round.targetEpisode + 1,
        mode: round.decisionMode,
        participants: round.participantCount ?? 0,
        ideas: round.proposals.length,
        voters: round.proposals.reduce(
          (sum, proposal) => sum + proposal.voterCount,
          0,
        ),
        remainingMs: Math.max(0, deadline - now),
        reason,
      }),
    );
  }

  return { deadline, mode: round.decisionMode };
}

function clearAutoTriggerIfBoardEmpty(roundId: number) {
  const count = Number(
    (
      db.raw<any>(
        `SELECT COUNT(*) AS count FROM proposals WHERE roundId = ? AND status = 'open'`,
        roundId,
      )[0] || {}
    ).count || 0,
  );
  if (count === 0) {
    db.exec(
      `UPDATE promptRounds SET votingStartedAtMs = NULL, contestedAtMs = NULL, closesAtMs = 0 WHERE id = ?`,
      roundId,
    );
  }
}

export async function getOpenPromptRound(): Promise<PromptRound | null> {
  return dbMeasure.measureSync(
    {
      start: () => "Load open proposal board",
      end: (round) =>
        round
          ? {
              id: round.id,
              targetEpisode: round.targetEpisode + 1,
              proposals: round.proposals.length,
              leader: round.proposals[0]
                ? {
                    id: round.proposals[0].id,
                    score: round.proposals[0].voteCount,
                    text: round.proposals[0].text.slice(0, 80),
                  }
                : null,
            }
          : null,
    },
    () => {
      const row =
        db.raw<any>(
          `SELECT id FROM promptRounds WHERE status = 'open' ORDER BY id DESC LIMIT 1`,
        )[0] || null;
      return row ? loadRoundById(Number(row.id)) : null;
    },
  );
}

export async function getLatestPromptRound(): Promise<PromptRound | null> {
  return dbMeasure.measureSync("Load latest proposal board", () => {
    const row =
      db.raw<any>(`SELECT id FROM promptRounds ORDER BY id DESC LIMIT 1`)[0] ||
      null;
    return row ? loadRoundById(Number(row.id)) : null;
  });
}

export async function getPromptRoundForProposal(
  proposalId: number,
): Promise<PromptRound | null> {
  return dbMeasure.measureSync("Load proposal round", () => {
    const row =
      db.raw<any>(
        `SELECT roundId FROM proposals WHERE id = ? LIMIT 1`,
        proposalId,
      )[0] || null;
    return row ? loadRoundById(Number(row.roundId)) : null;
  });
}

async function expectedProposalBoardEpisode() {
  const next = await nextEpisode();
  // EP 1 is the opening generated without a proposal. While there are no clips
  // yet, suggestions are therefore for EP 2 (zero-based episode 1).
  if (next === 0) return 1;
  const pending = nextPendingDirectiveWithVotes();
  return next + (pending ? 1 : 0);
}

export async function ensureOpenPromptRound(
  targetEpisode?: number,
): Promise<PromptRound> {
  const desired = targetEpisode ?? (await expectedProposalBoardEpisode());
  const existing = await getOpenPromptRound();
  if (existing) {
    if (existing.targetEpisode !== desired) {
      return dbMeasure.measureSync(
        {
          start: () =>
            `Retarget proposal board EP ${existing.targetEpisode + 1} → ${desired + 1}`,
          end: (round) => ({
            id: round.id,
            targetEpisode: round.targetEpisode + 1,
          }),
        },
        () => {
          db.exec(
            `UPDATE promptRounds SET targetEpisode = ? WHERE id = ?`,
            desired,
            existing.id,
          );
          const loaded = loadRoundById(existing.id);
          if (!loaded) throw new Error("Could not reload proposal board");
          return loaded;
        },
      );
    }
    return existing;
  }
  return dbMeasure.measureSync("Open persistent proposal board", () => {
    const row = db.promptRounds.insert({
      targetEpisode: desired,
      status: "open",
      openedAtMs: Date.now(),
      votingStartedAtMs: null,
      closesAtMs: 0,
      closedAtMs: null,
      winnerProposalId: null,
    });
    if (!row) throw new Error("Could not open prompt round");
    const loaded = loadRoundById(Number((row as any).id));
    if (!loaded) throw new Error("Could not reload prompt round");
    return loaded;
  });
}

async function roundForNewSuggestion() {
  // The board follows actual generated/locked work, never historical round ids.
  // This prevents repeated resets/triggers from drifting EP 7 into EP 16/61.
  return ensureOpenPromptRound();
}

function clampWeight(value: number) {
  return Math.max(1, Number.isFinite(value) ? value : 1);
}

export async function upsertWebProposal(input: {
  text: string;
  ownerKey: string;
  walletAddress?: string | null;
  ownerWeight?: number;
  participantKey: string;
}) {
  const round = await roundForNewSuggestion();
  assertRoundAcceptingActivity(round);
  const text = input.text.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!text) throw new Error("Idea cannot be empty");
  const normalized = normalizeProposalText(text);
  const ownerWeight = clampWeight(input.ownerWeight ?? 1);

  return dbMeasure.measureSync("Upsert persistent web proposal", () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const own =
        db.raw<any>(
          `SELECT * FROM proposals
           WHERE roundId = ? AND source = 'web' AND status = 'open'
             AND (sourceId = ? OR (? IS NOT NULL AND authorAddress = ?))
           ORDER BY CASE WHEN sourceId = ? THEN 0 ELSE 1 END, id ASC
           LIMIT 1`,
          round.id,
          input.ownerKey,
          input.walletAddress ?? null,
          input.walletAddress ?? null,
          input.ownerKey,
        )[0] || null;
      const cohort =
        db.raw<any>(
          `SELECT * FROM proposals
           WHERE roundId = ? AND source = 'web' AND status = 'open'
             AND participantKey = ? AND id != ?
           ORDER BY id ASC LIMIT 1`,
          round.id,
          input.participantKey,
          own?.id ?? -1,
        )[0] || null;
      if (cohort)
        throw new Error(
          "This participant already has an active idea. Edit it from the original session, connect a wallet, or vote instead.",
        );
      const duplicate =
        db.raw<any>(
          `SELECT id FROM proposals WHERE roundId = ? AND normalizedText = ? AND status = 'open' AND id != ? LIMIT 1`,
          round.id,
          normalized,
          own?.id ?? -1,
        )[0] || null;
      if (duplicate) throw new Error("That idea is already on the board");

      let proposal = own;
      if (proposal) {
        const changed = proposal.normalizedText !== normalized;
        if (changed && round.decisionMode === "voting")
          throw new Error(
            "Voting is open; submitted ideas are locked until this decision resolves.",
          );
        db.exec(
          `UPDATE proposals SET text = ?, normalizedText = ?, sourceId = ?, authorAddress = ?, ownerWeight = ?, participantKey = ? WHERE id = ?`,
          text,
          normalized,
          input.ownerKey,
          input.walletAddress ?? null,
          ownerWeight,
          input.participantKey,
          proposal.id,
        );
        // Editing changes the proposition people voted for, so outside votes are
        // cleared. The author's own score remains attached to the edited idea.
        if (changed)
          db.exec(
            `DELETE FROM proposalVotes WHERE proposalId = ?`,
            proposal.id,
          );
        proposal = db.raw<any>(
          `SELECT * FROM proposals WHERE id = ? LIMIT 1`,
          proposal.id,
        )[0];
      } else {
        const count = Number(
          (
            db.raw<any>(
              `SELECT COUNT(*) AS count FROM proposals WHERE roundId = ? AND status = 'open'`,
              round.id,
            )[0] || {}
          ).count || 0,
        );
        if (count >= MAX_PROPOSALS_PER_ROUND)
          throw new Error("The proposal board is full");
        proposal = db.proposals.insert({
          roundId: round.id,
          text,
          normalizedText: normalized,
          status: "open",
          source: "web",
          sourceId: input.ownerKey,
          author: null,
          authorAddress: input.walletAddress ?? null,
          sourceRoom: "web",
          participantKey: input.participantKey,
          operatorVoteOverride: null,
          ownerWeight,
        });
      }
      if (!proposal) throw new Error("Could not save idea");
      armAutoTriggerForRound(round.id, "proposal");

      db.exec("COMMIT");
      const loaded = loadRoundById(round.id);
      return (
        loaded?.proposals.find((item) => item.id === Number(proposal.id)) ||
        null
      );
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  });
}

export async function cancelWebProposal(ownerKey: string) {
  const round = await getOpenPromptRound();
  if (!round) return false;
  assertRoundAcceptingActivity(round);
  if (round.decisionMode === "voting")
    throw new Error(
      "Voting is open; submitted ideas are locked until this decision resolves.",
    );
  return dbMeasure.measureSync("Cancel persistent web proposal", () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const proposal =
        db.raw<any>(
          `SELECT id FROM proposals WHERE roundId = ? AND source = 'web' AND sourceId = ? AND status = 'open' LIMIT 1`,
          round.id,
          ownerKey,
        )[0] || null;
      if (!proposal) {
        db.exec("COMMIT");
        return false;
      }
      db.exec(`DELETE FROM proposalVotes WHERE proposalId = ?`, proposal.id);
      db.exec(`DELETE FROM proposals WHERE id = ?`, proposal.id);
      clearAutoTriggerIfBoardEmpty(round.id);
      db.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  });
}

export async function attachWebWallet(input: {
  ownerKey: string;
  walletAddress: string;
  weight: number;
  participantKey: string;
}) {
  const round = await getOpenPromptRound();
  if (!round) return null;
  const weight = clampWeight(input.weight);
  const walletKey = `wallet:${input.walletAddress}`;
  return dbMeasure.measureSync(
    {
      start: () =>
        `Attach wallet ${input.walletAddress.slice(0, 5)}…${input.walletAddress.slice(-4)}`,
      end: (value) => ({ proposals: value?.proposals.length ?? 0, weight }),
    },
    () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const anonymousProposal =
          db.raw<any>(
            `SELECT * FROM proposals WHERE roundId = ? AND source = 'web' AND sourceId = ? AND status = 'open' LIMIT 1`,
            round.id,
            input.ownerKey,
          )[0] || null;
        const walletProposal =
          db.raw<any>(
            `SELECT * FROM proposals WHERE roundId = ? AND source = 'web' AND (sourceId = ? OR authorAddress = ?) AND status = 'open' ORDER BY id ASC LIMIT 1`,
            round.id,
            walletKey,
            input.walletAddress,
          )[0] || null;

        if (
          anonymousProposal &&
          walletProposal &&
          anonymousProposal.id !== walletProposal.id
        ) {
          // A wallet can own only one active idea across every browser/session.
          db.exec(
            `DELETE FROM proposalVotes WHERE proposalId = ?`,
            anonymousProposal.id,
          );
          db.exec(`DELETE FROM proposals WHERE id = ?`, anonymousProposal.id);
        } else if (anonymousProposal) {
          db.exec(
            `UPDATE proposals SET sourceId = ?, authorAddress = ?, ownerWeight = ?, participantKey = ? WHERE id = ?`,
            walletKey,
            input.walletAddress,
            weight,
            input.participantKey,
            anonymousProposal.id,
          );
        }

        db.exec(
          `UPDATE proposals SET sourceId = ?, authorAddress = ?, ownerWeight = ?, participantKey = ?
           WHERE roundId = ? AND source = 'web' AND (sourceId = ? OR authorAddress = ?) AND status = 'open'`,
          walletKey,
          input.walletAddress,
          weight,
          input.participantKey,
          round.id,
          walletKey,
          input.walletAddress,
        );

        // One connected wallet gets one vote, even across multiple browser tabs.
        db.exec(
          `DELETE FROM proposalVotes WHERE roundId = ? AND voterKey = ?`,
          round.id,
          walletKey,
        );
        db.exec(
          `UPDATE proposalVotes SET voterKey = ?, sourceId = ?, weight = ?, participantKey = ?
           WHERE roundId = ? AND voterKey = ?`,
          walletKey,
          input.walletAddress,
          weight,
          input.participantKey,
          round.id,
          input.ownerKey,
        );

        db.exec("COMMIT");
        return loadRoundById(round.id);
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },
  );
}

export async function castWebVote(input: {
  proposalId: number;
  voterKey: string;
  weight: number;
  walletAddress?: string | null;
  participantKey: string;
}) {
  const round = await getOpenPromptRound();
  if (!round) return null;
  assertRoundAcceptingActivity(round);
  const target = round.proposals.find((item) => item.id === input.proposalId);
  if (!target) throw new Error("Idea is no longer active");
  const ownedProposal =
    db.raw<any>(
      `SELECT id FROM proposals
       WHERE roundId = ? AND status = 'open'
         AND (participantKey = ? OR (source = 'web' AND sourceId = ?))
       ORDER BY id ASC LIMIT 1`,
      round.id,
      input.participantKey,
      input.voterKey,
    )[0] || null;
  if (ownedProposal)
    throw new Error(
      "Your submitted idea already carries your score; you cannot cast a second vote in the same decision.",
    );
  if (round.decisionMode !== "voting")
    throw new Error("Voting opens when a second independent idea is submitted");
  const weight = clampWeight(input.weight);

  return dbMeasure.measureSync("Cast persistent web vote", () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        `DELETE FROM proposalVotes
         WHERE roundId = ? AND (voterKey = ? OR participantKey = ?)`,
        round.id,
        input.voterKey,
        input.participantKey,
      );
      db.proposalVotes.insert({
        roundId: round.id,
        proposalId: input.proposalId,
        voterKey: input.voterKey,
        voterHandle: null,
        source: "web",
        sourceId: input.walletAddress ?? input.voterKey,
        participantKey: input.participantKey,
        weight,
      });
      armAutoTriggerForRound(round.id, "vote");
      db.exec("COMMIT");
      return loadRoundById(round.id);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  });
}

export async function submitPumpfunProposal(input: {
  text: string;
  sourceId: string;
  author: string | null;
  authorAddress: string | null;
  sourceRoom: string | null;
  voterKey: string;
  voterHandle?: string | null;
  source?: DirectiveSource;
}) {
  const round = await roundForNewSuggestion();
  assertRoundAcceptingActivity(round);
  return dbMeasure.measureSync("Submit proposal", () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      let proposal =
        db.raw<any>(
          `SELECT * FROM proposals WHERE roundId = ? AND normalizedText = ? AND status = 'open' LIMIT 1`,
          round.id,
          normalizeProposalText(input.text),
        )[0] || null;
      if (!proposal) proposal = similarProposal(round.id, input.text);
      if (!proposal) {
        const count = Number(
          (
            db.raw<any>(
              `SELECT COUNT(*) AS count FROM proposals WHERE roundId = ?`,
              round.id,
            )[0] || {}
          ).count || 0,
        );
        if (count >= MAX_PROPOSALS_PER_ROUND) {
          db.exec("COMMIT");
          return null;
        }
        proposal = db.proposals.insert({
          roundId: round.id,
          text: input.text,
          normalizedText: normalizeProposalText(input.text),
          status: "open",
          source: input.source ?? "pumpfun",
          sourceId: input.sourceId,
          author: input.author,
          authorAddress: input.authorAddress,
          sourceRoom: input.sourceRoom,
          participantKey: input.authorAddress
            ? `wallet:${input.authorAddress}`
            : `pumpfun:${input.voterKey}`,
          operatorVoteOverride: null,
          ownerWeight: input.source === "web" ? 1 : 0,
        });
      }
      if (!proposal) throw new Error("Could not create proposal");
      db.exec(
        `DELETE FROM proposalVotes WHERE roundId = ? AND voterKey = ?`,
        round.id,
        input.voterKey,
      );
      db.proposalVotes.insert({
        roundId: round.id,
        proposalId: Number((proposal as any).id),
        voterKey: input.voterKey,
        voterHandle: input.voterHandle ?? null,
        source: input.source ?? "pumpfun",
        sourceId: input.sourceId,
        participantKey: input.authorAddress
          ? `wallet:${input.authorAddress}`
          : `pumpfun:${input.voterKey}`,
        weight: 1,
      });
      armAutoTriggerForRound(round.id, "proposal");
      db.exec("COMMIT");
      const loaded = loadRoundById(round.id);
      if (!loaded) throw new Error("Could not reload proposal round");
      return (
        loaded.proposals.find((p) => p.id === Number((proposal as any).id)) ||
        null
      );
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  });
}

export async function castPumpfunVote(input: {
  proposalId: number;
  voterKey: string;
  voterHandle?: string | null;
  sourceId: string;
  source?: DirectiveSource;
}) {
  const round = await getOpenPromptRound();
  if (!round) return null;
  assertRoundAcceptingActivity(round);
  if (!round.proposals.some((p) => p.id === input.proposalId)) return null;
  return dbMeasure.measureSync("Cast proposal vote", () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        `DELETE FROM proposalVotes WHERE roundId = ? AND voterKey = ?`,
        round.id,
        input.voterKey,
      );
      db.proposalVotes.insert({
        roundId: round.id,
        proposalId: input.proposalId,
        voterKey: input.voterKey,
        voterHandle: input.voterHandle ?? null,
        source: input.source ?? "pumpfun",
        sourceId: input.sourceId,
        participantKey: `pumpfun:${input.voterKey}`,
        weight: 1,
      });
      armAutoTriggerForRound(round.id, "vote");
      db.exec("COMMIT");
      return loadRoundById(round.id);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  });
}

export async function castPumpfunVoteByHandle(input: {
  handle: string;
  voterKey: string;
  voterHandle?: string | null;
  sourceId: string;
}) {
  const round = await getOpenPromptRound();
  if (!round) return null;
  const handle = normalizedHandle(input.handle);
  if (!handle) return null;

  // Resolve the handle to the suggestion they authored. If their suggestion was
  // merged into an earlier near-duplicate, resolve the proposal they voted for
  // when they submitted it. Chat never needs to know an internal proposal id.
  const proposal = dbMeasure.measureSync("Resolve proposal vote handle", () => {
    const authored =
      db.raw<any>(
        `SELECT * FROM proposals
       WHERE roundId = ? AND status = 'open' AND lower(ltrim(COALESCE(author, ''), '@')) = ?
       ORDER BY id DESC LIMIT 1`,
        round.id,
        handle,
      )[0] || null;
    if (authored) return authored;
    return (
      db.raw<any>(
        `SELECT p.* FROM proposalVotes v
       JOIN proposals p ON p.id = v.proposalId
       WHERE v.roundId = ? AND p.status = 'open' AND lower(ltrim(COALESCE(v.voterHandle, ''), '@')) = ?
       ORDER BY v.id DESC LIMIT 1`,
        round.id,
        handle,
      )[0] || null
    );
  });
  if (!proposal) return null;
  return castPumpfunVote({
    proposalId: Number(proposal.id),
    voterKey: input.voterKey,
    voterHandle: input.voterHandle ?? null,
    sourceId: input.sourceId,
  });
}

export async function setProposalVoteOverride(
  proposalId: number,
  value: number | null,
) {
  return dbMeasure.measureSync("Override proposal votes", () => {
    const proposal =
      db.raw<any>(
        `SELECT * FROM proposals WHERE id = ? LIMIT 1`,
        proposalId,
      )[0] || null;
    if (!proposal) throw new Error(`Proposal #${proposalId} not found`);
    db.exec(
      `UPDATE proposals SET operatorVoteOverride = ? WHERE id = ?`,
      value == null ? null : Math.max(0, Math.floor(value)),
      proposalId,
    );
    return loadRoundById(Number(proposal.roundId));
  });
}

function carryProposalBoardForward(input: {
  roundId: number;
  winnerProposalId: number;
  targetEpisode: number;
  now: number;
}) {
  const nextRound = db.promptRounds.insert({
    targetEpisode: input.targetEpisode,
    status: "open",
    openedAtMs: input.now,
    votingStartedAtMs: null,
    contestedAtMs: null,
    closesAtMs: 0,
    closedAtMs: null,
    winnerProposalId: null,
  });
  if (!nextRound) throw new Error("Could not open persistent proposal board");
  const nextRoundId = Number((nextRound as any).id);

  // Persistent means persistent: surviving ideas keep the same proposal id,
  // ownership, score and vote rows. Only their board/round membership advances.
  // The executed winner remains attached to the closed historical round.
  db.exec(
    `UPDATE proposals
     SET roundId = ?, status = 'open'
     WHERE roundId = ? AND id != ?`,
    nextRoundId,
    input.roundId,
    input.winnerProposalId,
  );
  db.exec(
    `UPDATE proposalVotes
     SET roundId = ?
     WHERE roundId = ? AND proposalId != ?`,
    nextRoundId,
    input.roundId,
    input.winnerProposalId,
  );

  armAutoTriggerForRound(nextRoundId, "carry", input.now);
  return nextRoundId;
}

type TriggerSelection = {
  proposalId?: number;
  text?: string;
  actor?: string;
};

export type TriggerResult = {
  directive: Directive;
  proposal: PromptProposal;
  rank: number;
  score: number;
  actor: string;
};

function cleanTriggerActor(value: string | undefined) {
  const actor = String(value || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return actor || "unknown";
}

function triggerDirectiveSourceId(
  actor: string,
  roundId: number,
  proposalId: number,
) {
  return `trigger:${cleanTriggerActor(actor)}:round:${roundId}:proposal:${proposalId}`;
}

export async function triggerNextProposal(
  selection: TriggerSelection = {},
): Promise<TriggerResult> {
  const actor = cleanTriggerActor(selection.actor);

  return dbMeasure.measureSync(
    {
      start: () => `Trigger proposal · ${actor}`,
      end: (result) => ({
        actor: result.actor,
        proposalId: result.proposal.id,
        rank: result.rank,
        score: result.score,
        directiveId: result.directive.id,
        text: result.proposal.text.slice(0, 100),
      }),
    },
    () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const pending =
          db.raw<any>(
            `SELECT id, text, status, sourceId
             FROM directives
             WHERE COALESCE(triggered, 0) = 1
               AND sourceId LIKE 'trigger:%'
               AND status IN ('generating', 'queued')
             ORDER BY CASE status WHEN 'generating' THEN 0 ELSE 1 END, id ASC
             LIMIT 1`,
          )[0] || null;
        if (pending) {
          throw new Error(
            `Next generation is already ${pending.status}: ${pending.text}`,
          );
        }

        const roundRow =
          db.raw<any>(
            `SELECT id FROM promptRounds
             WHERE status = 'open'
             ORDER BY id DESC
             LIMIT 1`,
          )[0] || null;
        if (!roundRow) throw new Error("There is no open proposal board");

        const round = loadRoundById(Number(roundRow.id));
        if (!round || !round.proposals.length)
          throw new Error("There are no active proposals to trigger");

        const generationEpisodeRow =
          db.raw<any>(`SELECT MAX(episode) AS latestEpisode FROM clips`)[0] ||
          null;
        const generationEpisode =
          generationEpisodeRow?.latestEpisode == null
            ? 0
            : Number(generationEpisodeRow.latestEpisode) + 1;
        if (generationEpisode === 0)
          throw new Error(
            "The opening episode must publish before proposals can be triggered",
          );

        const normalizedText = selection.text
          ?.replace(/\s+/g, " ")
          .trim()
          .toLowerCase();

        const selected =
          selection.proposalId !== undefined
            ? round.proposals.find(
                (proposal) => proposal.id === selection.proposalId,
              )
            : normalizedText
              ? round.proposals.find(
                  (proposal) =>
                    proposal.text.replace(/\s+/g, " ").trim().toLowerCase() ===
                    normalizedText,
                )
              : round.proposals[0];

        if (!selected) {
          if (selection.proposalId !== undefined)
            throw new Error(`Proposal #${selection.proposalId} is not active`);
          throw new Error(
            `No active proposal exactly matches: ${selection.text || ""}`,
          );
        }

        const rank =
          round.proposals.findIndex((proposal) => proposal.id === selected.id) +
          1;
        const score = Number(selected.voteCount || 0);
        const now = Date.now();

        const closed = db.raw<any>(
          `UPDATE promptRounds
           SET targetEpisode = ?, status = 'closed', closedAtMs = ?, winnerProposalId = ?
           WHERE id = ? AND status = 'open'
           RETURNING id`,
          generationEpisode,
          now,
          selected.id,
          round.id,
        );
        if (!closed?.length)
          throw new Error("Proposal board changed while triggering; try again");

        db.exec(
          `UPDATE proposals
           SET status = CASE WHEN id = ? THEN 'selected' ELSE 'lost' END
           WHERE roundId = ?`,
          selected.id,
          round.id,
        );

        const sourceId = triggerDirectiveSourceId(actor, round.id, selected.id);
        const directive = db.directives.insert({
          text: selected.text,
          status: "queued",
          usedEpisode: null,
          source: selected.source,
          sourceId,
          author: selected.author,
          authorAddress: selected.authorAddress,
          sourceRoom: selected.sourceRoom,
          proposalId: selected.id,
          triggered: true,
        });
        if (!directive) throw new Error("Could not create winning directive");

        carryProposalBoardForward({
          roundId: round.id,
          winnerProposalId: selected.id,
          targetEpisode: generationEpisode + 1,
          now,
        });

        db.exec("COMMIT");

        const hydrated = directiveWithVotesById(Number((directive as any).id));
        const finalDirective = hydrated
          ? toDirective(hydrated)
          : toDirective(directive);

        return {
          directive: finalDirective,
          proposal: selected,
          rank,
          score,
          actor,
        };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },
  );
}

// Compatibility wrapper for any old operator code. New CLI/API paths call
// triggerNextProposal() so selection, ranking and attribution are identical.
export async function triggerPromptRound(
  winnerProposalId?: number,
  actor = "legacy",
): Promise<Directive | null> {
  const result = await triggerNextProposal({
    proposalId: winnerProposalId,
    actor,
  });
  return result.directive;
}

export async function forceProposalAsNext(
  proposalId: number,
): Promise<Directive> {
  const proposal = dbMeasure.measureSync(
    "Load forced proposal",
    () =>
      db.raw<any>(
        `SELECT * FROM proposals WHERE id = ? LIMIT 1`,
        proposalId,
      )[0] || null,
  );
  if (!proposal) throw new Error(`Proposal #${proposalId} not found`);
  const round = loadRoundById(Number(proposal.roundId));
  if (!round) throw new Error(`Round for proposal #${proposalId} not found`);
  if (round.status === "open") {
    const result = await triggerNextProposal({
      proposalId,
      actor: "force",
    });
    return result.directive;
  }

  return dbMeasure.measureSync("Override locked proposal winner", () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing =
        db.raw<any>(
          `SELECT d.* FROM directives d JOIN proposals p ON p.id = d.proposalId WHERE p.roundId = ? ORDER BY d.id ASC LIMIT 1`,
          round.id,
        )[0] || null;
      if (existing && existing.status !== "queued")
        throw new Error(
          "The next episode is already generating or published; reset first to change it.",
        );
      db.exec(
        `UPDATE promptRounds SET winnerProposalId = ? WHERE id = ?`,
        proposalId,
        round.id,
      );
      db.exec(
        `UPDATE proposals SET status = CASE WHEN id = ? THEN 'selected' ELSE 'lost' END WHERE roundId = ?`,
        proposalId,
        round.id,
      );
      let directive = existing;
      if (directive) {
        db.exec(
          `UPDATE directives SET text = ?, sourceId = ?, author = ?, authorAddress = ?, sourceRoom = ?, proposalId = ?, triggered = 1 WHERE id = ?`,
          proposal.text,
          triggerDirectiveSourceId("force-override", round.id, proposalId),
          proposal.author ?? null,
          proposal.authorAddress ?? null,
          proposal.sourceRoom ?? null,
          proposalId,
          directive.id,
        );
        directive = db.raw<any>(
          `SELECT * FROM directives WHERE id = ? LIMIT 1`,
          directive.id,
        )[0];
      } else {
        directive = db.directives.insert({
          text: proposal.text,
          status: "queued",
          usedEpisode: null,
          source: proposal.source || "pumpfun",
          sourceId: triggerDirectiveSourceId(
            "force-override",
            round.id,
            proposalId,
          ),
          author: proposal.author ?? null,
          authorAddress: proposal.authorAddress ?? null,
          sourceRoom: proposal.sourceRoom ?? null,
          proposalId,
          triggered: true,
        });
      }
      if (!directive) throw new Error("Could not persist forced winner");
      db.exec("COMMIT");
      const hydrated = directiveWithVotesById(Number(directive.id));
      return hydrated ? toDirective(hydrated) : toDirective(directive);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  });
}

export async function autoTriggerNextProposalIfDue(now = Date.now()) {
  if (!AUTO_TRIGGER_ENABLED) return null;
  const due =
    db.raw<any>(
      `SELECT r.id, r.targetEpisode, r.closesAtMs,
              (SELECT COUNT(*) FROM proposals p WHERE p.roundId = r.id AND p.status = 'open') AS proposalCount
       FROM promptRounds r
       WHERE r.status = 'open'
         AND r.closesAtMs > 0
         AND r.closesAtMs <= ?
       ORDER BY r.id DESC
       LIMIT 1`,
      now,
    )[0] || null;
  if (!due || Number(due.proposalCount || 0) <= 0) return null;

  try {
    return await triggerNextProposal({ actor: "auto" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Manual/API trigger can win the race with this worker tick. That is a
    // successful outcome, not a worker failure.
    if (
      /already (queued|generating)|already .*generation|no open proposal board|board changed/i.test(
        message,
      )
    ) {
      dbMeasure.measureSync("Auto-trigger race resolved", () => ({ message }));
      return null;
    }
    throw error;
  }
}

export async function closePromptRoundIfDue(now = Date.now()) {
  return autoTriggerNextProposalIfDue(now);
}

export async function operatorInjectProposal(text: string) {
  const round = await roundForNewSuggestion();
  const sourceId = `operator:${Date.now()}:${crypto.randomUUID()}`;

  return dbMeasure.measureSync("Inject operator proposal", () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      let proposal =
        db.raw<any>(
          `SELECT * FROM proposals WHERE roundId = ? AND normalizedText = ? AND status = 'open' LIMIT 1`,
          round.id,
          normalizeProposalText(text),
        )[0] || null;
      if (!proposal) proposal = similarProposal(round.id, text);

      if (!proposal) {
        const count = Number(
          (
            db.raw<any>(
              `SELECT COUNT(*) AS count FROM proposals WHERE roundId = ?`,
              round.id,
            )[0] || {}
          ).count || 0,
        );
        if (count >= MAX_PROPOSALS_PER_ROUND) {
          db.exec("COMMIT");
          return null;
        }

        proposal = db.proposals.insert({
          roundId: round.id,
          text,
          normalizedText: normalizeProposalText(text),
          status: "open",
          source: "pumpfun",
          sourceId,
          author: "operator",
          authorAddress: null,
          sourceRoom: "cli",
          participantKey: sourceId,
          operatorVoteOverride: null,
          ownerWeight: 0,
        });
      }

      if (!proposal) throw new Error("Could not inject operator proposal");

      // Operator injection is intentionally NOT a Pump.fun chat event:
      // it adds a candidate, but does not start the voting deadline and
      // does not create a queued generation directive. `control trigger`
      // is the explicit commit boundary.
      db.proposalVotes.insert({
        roundId: round.id,
        proposalId: Number((proposal as any).id),
        voterKey: sourceId,
        voterHandle: "operator",
        source: "pumpfun",
        sourceId,
        participantKey: sourceId,
        weight: 1,
      });
      armAutoTriggerForRound(round.id, "proposal");

      db.exec("COMMIT");
      const loaded = loadRoundById(round.id);
      if (!loaded) throw new Error("Could not reload operator proposal round");
      return (
        loaded.proposals.find((p) => p.id === Number((proposal as any).id)) ||
        null
      );
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  });
}

export async function operatorInjectAndForce(text: string) {
  const proposal = await operatorInjectProposal(text);
  if (!proposal) throw new Error("Could not inject operator proposal");
  const result = await triggerNextProposal({
    proposalId: proposal.id,
    actor: "inject-force",
  });
  return result.directive;
}

export async function claimQueuedDirective(episode: number) {
  const queued = await dbMeasure.measureSync(
    "Get explicitly triggered directive",
    () =>
      db.raw<any>(
        `SELECT * FROM directives
         WHERE status = 'queued'
           AND COALESCE(triggered, 0) = 1
           AND sourceId LIKE 'trigger:%'
         ORDER BY id ASC
         LIMIT 1`,
      )[0] || null,
  );
  if (!queued) return null;

  const claimed = await dbMeasure.measureSync("Claim directive", () =>
    db.directives
      .select()
      .where({ id: Number(queued.id), status: "queued" })
      .updateAll({ status: "generating", usedEpisode: episode }),
  );
  if (claimed === null) throw new Error("Could not claim directive");

  return toDirective({ ...queued, status: "generating", usedEpisode: episode });
}

export async function peekQueuedDirective(): Promise<Directive | null> {
  const row = await dbMeasure.measureSync(
    "Peek explicitly triggered directive",
    () =>
      db.raw<any>(
        `SELECT * FROM directives
         WHERE status = 'queued'
           AND COALESCE(triggered, 0) = 1
           AND sourceId LIKE 'trigger:%'
         ORDER BY id ASC
         LIMIT 1`,
      )[0] || null,
  );
  return row ? toDirective(row) : null;
}

export async function hasQueuedDirective() {
  const row = await dbMeasure.measureSync(
    "Check explicitly triggered directive",
    () =>
      db.raw<any>(
        `SELECT id FROM directives
         WHERE status = 'queued'
           AND COALESCE(triggered, 0) = 1
           AND sourceId LIKE 'trigger:%'
         ORDER BY id ASC
         LIMIT 1`,
      )[0] || null,
  );
  return Boolean(row);
}

export async function completeDirective(id: number) {
  return dbMeasure.measureSync("Complete directive", () =>
    db.directives.select().where({ id }).updateAll({ status: "used" }),
  );
}

export async function releaseDirective(id: number) {
  return dbMeasure.measureSync("Release directive", () =>
    db.directives
      .select()
      .where({ id })
      .updateAll({ status: "queued", usedEpisode: null }),
  );
}

export async function recoverGeneratingDirectives() {
  const rows = await dbMeasure.measureSync("Load abandoned directives", () =>
    db.directives.select().where({ status: "generating" }).all(),
  );

  for (const row of rows || []) {
    const directive = row as any;
    const clip = await dbMeasure.measureSync(
      "Check recovered directive clip",
      () => db.clips.select("id").where({ directiveId: directive.id }).first(),
    );

    await dbMeasure.measureSync("Recover abandoned directive", () =>
      db.directives
        .select()
        .where({ id: directive.id })
        .updateAll(
          clip ? { status: "used" } : { status: "queued", usedEpisode: null },
        ),
    );
  }
}

export async function recentStory(limit = 6) {
  const rows = await dbMeasure.measureSync(
    {
      start: () => "Load recent reconciled canon",
      end: (value) => ({ clips: Array.isArray(value) ? value.length : 0 }),
    },
    () =>
      db.raw<any>(
        `SELECT c.*, w.reconciliationJson
       FROM clips c
       LEFT JOIN worldStateSnapshots w ON w.clipId = c.id
       ORDER BY c.episode DESC
       LIMIT ?`,
        limit,
      ),
  );

  return (rows || []).reverse().map((row: any) => {
    let realitySummary: string | null = null;
    try {
      const audit = row.reconciliationJson
        ? JSON.parse(row.reconciliationJson)
        : null;
      if (audit?.summary) {
        const drift =
          Array.isArray(audit.drift) && audit.drift.length
            ? `; corrected drift: ${audit.drift.slice(0, 3).join("; ")}`
            : "";
        realitySummary = `Rendered reality (${audit.status || "unknown"}): ${audit.summary}${drift}`;
      }
    } catch {
      // Ignore malformed legacy reconciliation metadata.
    }

    if (row.showrunnerPlanJson) {
      try {
        const plan = JSON.parse(row.showrunnerPlanJson) as {
          premise?: string;
          action?: string;
          transition?: string;
          endingBeat?: string;
        };
        return [
          `Directive: ${row.directive}`,
          plan.premise ? `Premise: ${plan.premise}` : null,
          plan.action ? `Planned action: ${plan.action}` : null,
          plan.transition ? `Planned handoff: ${plan.transition}` : null,
          realitySummary,
          plan.endingBeat ? `Planned ending: ${plan.endingBeat}` : null,
        ]
          .filter(Boolean)
          .join(" | ");
      } catch {
        // Legacy/bad plan JSON falls through to durable prompt/directive canon.
      }
    }

    return realitySummary
      ? `Directive: ${row.directive} | ${realitySummary}`
      : row.h3Prompt
        ? `Directive: ${row.directive} | Generated shot: ${row.h3Prompt}`
        : String(row.directive);
  });
}

function parseWorldStateAudit(row: any): WorldStateAudit {
  let persisted: any = null;
  try {
    persisted = row.reconciliationJson
      ? JSON.parse(row.reconciliationJson)
      : null;
  } catch {
    persisted = null;
  }

  const status = persisted?.status;
  return {
    episode: Number(row.episode),
    status:
      status === "verified" ||
      status === "corrected" ||
      status === "fallback" ||
      status === "skipped"
        ? status
        : "skipped",
    model: row.reconcilerModel ?? persisted?.model ?? null,
    summary: typeof persisted?.summary === "string" ? persisted.summary : null,
    drift: Array.isArray(persisted?.drift)
      ? persisted.drift.map(String).slice(0, 8)
      : [],
    sampledFrameUrls: Array.isArray(persisted?.sampledFrameUrls)
      ? persisted.sampledFrameUrls.map(String).slice(0, 3)
      : [],
    inputTokens: row.reconcilerInputTokens ?? null,
    outputTokens: row.reconcilerOutputTokens ?? null,
    cost: row.reconcilerCost ?? null,
  };
}

export async function getLatestWorldState(): Promise<WorldState> {
  const row = await dbMeasure.measureSync(
    {
      start: () => "Load latest world state",
      end: (value) =>
        value
          ? { episode: Number(value.episode) + 1, clipId: value.clipId }
          : null,
    },
    () => db.worldStateSnapshots.select().orderBy("episode", "DESC").first(),
  );
  return row
    ? parseWorldStateJson((row as any).stateJson) || EMPTY_WORLD_STATE
    : EMPTY_WORLD_STATE;
}

export async function getWorldStateSnapshotForEpisode(
  episode: number,
): Promise<{
  worldState: WorldState;
  audit: WorldStateAudit;
} | null> {
  const row = await dbMeasure.measureSync(
    {
      start: () => `Load world state EP ${episode + 1}`,
      end: (value) =>
        value
          ? { episode: Number(value.episode) + 1, clipId: value.clipId }
          : null,
    },
    () =>
      db.worldStateSnapshots
        .select()
        .where({ episode })
        .orderBy("id", "DESC")
        .first(),
  );
  if (!row) return null;
  const worldState = parseWorldStateJson((row as any).stateJson);
  if (!worldState) return null;
  return { worldState, audit: parseWorldStateAudit(row as any) };
}

export async function getWorldStateForEpisode(
  episode: number,
): Promise<WorldState | null> {
  return (await getWorldStateSnapshotForEpisode(episode))?.worldState ?? null;
}

export async function nextEpisode() {
  const row = await dbMeasure.measureSync(
    {
      start: () => "Load latest episode",
      end: (value) =>
        value
          ? { latestEpisode: Number((value as any).episode) + 1 }
          : { latestEpisode: null },
    },
    () => db.clips.select("episode").orderBy("episode", "DESC").first(),
  );
  return row ? Number((row as any).episode) + 1 : 0;
}

type PersistedClipInput = Omit<
  Clip,
  | "id"
  | "directiveSource"
  | "directiveAuthor"
  | "directiveAuthorAddress"
  | "directiveProposalId"
  | "directiveVoteCount"
>;

type SnapshotMeta = {
  plannedWorldState?: WorldState | null;
  audit?: Omit<WorldStateAudit, "episode"> | null;
};

export class ClipCommitConflictError extends Error {}

function latestClipIdentity() {
  const row =
    db.raw<any>(
      `SELECT id, episode FROM clips ORDER BY episode DESC, id DESC LIMIT 1`,
    )[0] || null;
  return {
    id: row == null ? null : Number(row.id),
    episode: row == null ? null : Number(row.episode),
  };
}

function persistClipTransaction(
  input: PersistedClipInput,
  worldState: WorldState,
  snapshotMeta: SnapshotMeta | undefined,
  expected?: { episode: number; previousClipId: number | null },
) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (expected) {
      const latest = latestClipIdentity();
      const nextEpisode = latest.episode == null ? 0 : latest.episode + 1;
      if (
        nextEpisode !== expected.episode ||
        latest.id !== expected.previousClipId
      ) {
        throw new ClipCommitConflictError(
          `Clip continuity changed before commit: expected EP ${expected.episode + 1} after clip ${expected.previousClipId ?? "opening"}, now EP ${nextEpisode + 1} after clip ${latest.id ?? "opening"}.`,
        );
      }
    }

    const clipRow = db.clips.insert(input);
    if (!clipRow) throw new Error("Failed to persist generated clip");

    const audit = snapshotMeta?.audit ?? null;
    const snapshot = db.worldStateSnapshots.insert({
      episode: input.episode,
      clipId: Number((clipRow as any).id),
      stateJson: JSON.stringify(worldState),
      plannedStateJson: snapshotMeta?.plannedWorldState
        ? JSON.stringify(snapshotMeta.plannedWorldState)
        : null,
      showrunnerModel: input.showrunnerModel ?? null,
      reconciliationJson: audit
        ? JSON.stringify({
            status: audit.status,
            model: audit.model,
            summary: audit.summary,
            drift: audit.drift,
            sampledFrameUrls: audit.sampledFrameUrls,
          })
        : null,
      reconcilerModel: audit?.model ?? null,
      reconcilerInputTokens: audit?.inputTokens ?? null,
      reconcilerOutputTokens: audit?.outputTokens ?? null,
      reconcilerCost: audit?.cost ?? null,
    });
    if (!snapshot) throw new Error("Failed to persist world state snapshot");

    if (expected && input.directiveId != null) {
      const directive =
        db.raw<any>(
          `SELECT id, status, usedEpisode FROM directives WHERE id = ? LIMIT 1`,
          input.directiveId,
        )[0] || null;
      if (
        !directive ||
        directive.status !== "generating" ||
        Number(directive.usedEpisode) !== expected.episode
      ) {
        throw new ClipCommitConflictError(
          `Directive #${input.directiveId} is no longer the generating owner of EP ${expected.episode + 1}.`,
        );
      }
      db.exec(
        `UPDATE directives SET status = 'used' WHERE id = ?`,
        input.directiveId,
      );
    }

    db.exec("COMMIT");
    return clipRow;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

export async function saveClipWithWorldState(
  input: PersistedClipInput,
  worldState: WorldState,
  snapshotMeta?: SnapshotMeta,
) {
  const row = await dbMeasure.measureSync(
    "Persist generated scene + reconciled world state",
    () => persistClipTransaction(input, worldState, snapshotMeta),
  );
  return toClip(row);
}

export async function saveClipWithWorldStateIfCurrent(
  input: PersistedClipInput,
  worldState: WorldState,
  snapshotMeta: SnapshotMeta | undefined,
  expected: { episode: number; previousClipId: number | null },
) {
  const row = await dbMeasure.measureSync(
    {
      start: () => `Commit EP ${expected.episode + 1} if continuity matches`,
      end: (value) => ({
        clipId: Number((value as any).id),
        episode: expected.episode + 1,
      }),
    },
    () => persistClipTransaction(input, worldState, snapshotMeta, expected),
  );
  return toClip(row);
}

export async function getRecentGenerationTimings(
  limit = 16,
): Promise<GenerationTimingSample[]> {
  const rows = await dbMeasure.measureSync(
    {
      start: () => "Load generation timing window",
      end: (value) => ({ samples: Array.isArray(value) ? value.length : 0 }),
    },
    () => db.clips.select().orderBy("episode", "DESC").limit(limit).all(),
  );
  return (rows || []).map((row: any) => ({
    generationMode: row.generationMode || "full",
    showrunnerMs: row.showrunnerMs ?? null,
    h3Ms: row.h3Ms ?? null,
    frameSampleMs: row.frameSampleMs ?? null,
    visionMs: row.visionMs ?? null,
    totalGenerationMs: row.totalGenerationMs ?? null,
  }));
}

export async function getLatestClip(): Promise<Clip | null> {
  const row = await dbMeasure.measureSync(
    {
      start: () => "Load latest clip",
      end: (value) =>
        value
          ? {
              id: value.id,
              episode: Number(value.episode) + 1,
              startsAtMs: value.startsAtMs,
            }
          : null,
    },
    () => db.clips.select().orderBy("episode", "DESC").first(),
  );
  if (!row) return null;

  const clip = toClip(row);
  if (clip.startsAtMs > 0) return clip;

  const startsAtMs = Date.now() + 400;
  await dbMeasure.measureSync("Repair legacy clip schedule", () =>
    db.clips.select().where({ id: clip.id }).updateAll({ startsAtMs }),
  );
  return { ...clip, startsAtMs };
}

export async function getTimeline(
  limit = Number(process.env.PUMPTV_TIMELINE_WINDOW || 64),
): Promise<Clip[]> {
  const safeLimit = Math.max(8, Math.min(240, Math.floor(limit || 64)));
  const rows = await dbMeasure.measureSync(
    {
      start: () => "Load attributed timeline window",
      end: (value) => ({ clips: Array.isArray(value) ? value.length : 0 }),
    },
    () =>
      db.raw<any>(
        `SELECT c.*,
              d.source AS directiveSource,
              d.author AS directiveAuthor,
              d.authorAddress AS directiveAuthorAddress,
              d.proposalId AS directiveProposalId,
              CASE WHEN d.proposalId IS NULL THEN NULL
                   ELSE (SELECT COALESCE(p.operatorVoteOverride, (SELECT COALESCE(SUM(v.weight), 0) FROM proposalVotes v WHERE v.proposalId = d.proposalId) + COALESCE(p.ownerWeight, 1)) FROM proposals p WHERE p.id = d.proposalId)
              END AS directiveVoteCount
       FROM clips c
       LEFT JOIN directives d ON d.id = c.directiveId
       ORDER BY c.episode DESC
       LIMIT ?`,
        safeLimit,
      ),
  );
  return (rows || [])
    .reverse()
    .map(toClip)
    .filter((clip: Clip) => clip.startsAtMs > 0);
}

export async function getStreamState(): Promise<StreamState> {
  const serverNowMs = Date.now();
  const [roomRow, timeline, queuedCount, timings, promptRound] =
    await Promise.all([
      getRoomRow(),
      getTimeline(),
      dbMeasure.measureSync("Count triggered prompts", () => {
        const row =
          db.raw<any>(
            `SELECT COUNT(*) AS count FROM directives
             WHERE status = 'queued'
               AND COALESCE(triggered, 0) = 1
               AND sourceId LIKE 'trigger:%'`,
          )[0] || null;
        return Number(row?.count || 0);
      }),
      getRecentGenerationTimings(),
      getOpenPromptRound(),
    ]);

  const latestClip = timeline.length ? timeline[timeline.length - 1] : null;
  const currentClip =
    timeline.find(
      (clip) =>
        clip.startsAtMs <= serverNowMs &&
        serverNowMs < clip.startsAtMs + clip.durationSeconds * 1000,
    ) || null;
  const publishedLatest =
    [...timeline].reverse().find((clip) => clip.startsAtMs <= serverNowMs) ||
    null;
  const nextClip =
    timeline.find((clip) => clip.startsAtMs > serverNowMs) || null;
  const bufferedUntilMs = latestClip
    ? latestClip.startsAtMs + latestClip.durationSeconds * 1000
    : null;
  const buffer = evaluateBuffer({
    bufferMs: Math.max(0, (bufferedUntilMs || serverNowMs) - serverNowMs),
    samples: timings,
    activeMode:
      roomRow.workerState === "generating"
        ? ((roomRow.generationMode || "full") as GenerationMode)
        : undefined,
    hasClip: Boolean(latestClip),
  });

  const currentDirectiveRow = currentClip?.directiveId
    ? directiveWithVotesById(currentClip.directiveId)
    : null;
  const nextDirectiveRow = nextClip
    ? nextClip.directiveId
      ? directiveWithVotesById(nextClip.directiveId)
      : null
    : nextPendingDirectiveWithVotes();
  const nextDirective = nextDirectiveRow ? toDirective(nextDirectiveRow) : null;
  const decisionRound = nextDirective?.proposalId
    ? await getPromptRoundForProposal(nextDirective.proposalId)
    : null;
  const worldState = publishedLatest
    ? (await getWorldStateForEpisode(publishedLatest.episode)) ||
      EMPTY_WORLD_STATE
    : EMPTY_WORLD_STATE;
  const room = toRoom(roomRow, bufferedUntilMs, buffer);
  const program = deriveLiveProgramState({
    room,
    serverNowMs,
    publishedLatest,
    nextClip,
    nextDirective,
    promptRound,
    decisionRound,
  });

  return {
    serverNowMs,
    room,
    currentClip,
    nextClip,
    latestClip,
    currentDirective: currentDirectiveRow
      ? toDirective(currentDirectiveRow)
      : null,
    nextDirective,
    program,
    worldState,
    timeline,
    queuedCount: Number(queuedCount || 0),
  };
}
