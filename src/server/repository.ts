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
    "Load next pending directive",
    () =>
      db.raw<any>(
        `SELECT d.*,
              CASE WHEN d.proposalId IS NULL THEN NULL
                   ELSE (SELECT COALESCE(p.operatorVoteOverride, (SELECT COALESCE(SUM(v.weight), 0) FROM proposalVotes v WHERE v.proposalId = d.proposalId) + COALESCE(p.ownerWeight, 1)) FROM proposals p WHERE p.id = d.proposalId)
              END AS voteCount
       FROM directives d
       WHERE d.status IN ('generating', 'queued')
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
  let row = await dbMeasure.measureSync("Load room", () =>
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
    operatorVoteOverride: override,
    voteCount: override ?? ownerWeight + realVoteCount,
  };
}

function loadRoundById(id: number): PromptRound | null {
  const row =
    db.raw<any>(`SELECT * FROM promptRounds WHERE id = ? LIMIT 1`, id)[0] ||
    null;
  if (!row) return null;
  const proposals = db
    .raw<any>(
      `SELECT p.*, (SELECT COALESCE(SUM(v.weight), 0) FROM proposalVotes v WHERE v.proposalId = p.id) AS realVoteCount
     FROM proposals p WHERE p.roundId = ?
     ORDER BY COALESCE(p.operatorVoteOverride, COALESCE(p.ownerWeight, 1) + (SELECT COALESCE(SUM(v.weight), 0) FROM proposalVotes v WHERE v.proposalId = p.id)) DESC, p.id ASC`,
      id,
    )
    .map(proposalFromRow);
  return {
    id: Number(row.id),
    targetEpisode: Number(row.targetEpisode),
    status: row.status,
    openedAtMs: Number(row.openedAtMs),
    votingStartedAtMs:
      row.votingStartedAtMs == null ? null : Number(row.votingStartedAtMs),
    closesAtMs: Number(row.closesAtMs || 0),
    closedAtMs: row.closedAtMs == null ? null : Number(row.closedAtMs),
    winnerProposalId:
      row.winnerProposalId == null ? null : Number(row.winnerProposalId),
    proposals,
  };
}

export async function getOpenPromptRound(): Promise<PromptRound | null> {
  return dbMeasure.measureSync("Load open Pump.fun round", () => {
    const row =
      db.raw<any>(
        `SELECT id FROM promptRounds WHERE status = 'open' ORDER BY id DESC LIMIT 1`,
      )[0] || null;
    return row ? loadRoundById(Number(row.id)) : null;
  });
}

export async function getLatestPromptRound(): Promise<PromptRound | null> {
  return dbMeasure.measureSync("Load latest Pump.fun round", () => {
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

export async function ensureOpenPromptRound(
  targetEpisode?: number,
): Promise<PromptRound> {
  const existing = await getOpenPromptRound();
  if (existing) return existing;
  const next = targetEpisode ?? (await nextEpisode());
  return dbMeasure.measureSync.assert("Open Pump.fun prompt round", () => {
    const row = db.promptRounds.insert({
      targetEpisode: next,
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
  const open = await getOpenPromptRound();
  if (open) return open;
  const latest = await getLatestPromptRound();
  const base = await nextEpisode();
  const target =
    latest?.status === "closed"
      ? Math.max(base, latest.targetEpisode + 1)
      : base;
  return ensureOpenPromptRound(target);
}

function clampWeight(value: number) {
  return Math.max(1, Number.isFinite(value) ? value : 1);
}

export async function upsertWebProposal(input: {
  text: string;
  ownerKey: string;
  walletAddress?: string | null;
  ownerWeight?: number;
}) {
  const round = await roundForNewSuggestion();
  const text = input.text.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!text) throw new Error("Idea cannot be empty");
  const normalized = normalizeProposalText(text);
  const ownerWeight = clampWeight(input.ownerWeight ?? 1);

  return dbMeasure.measureSync.assert("Upsert persistent web proposal", () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const own =
        db.raw<any>(
          `SELECT * FROM proposals WHERE roundId = ? AND source = 'web' AND sourceId = ? AND status = 'open' LIMIT 1`,
          round.id,
          input.ownerKey,
        )[0] || null;
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
        db.exec(
          `UPDATE proposals SET text = ?, normalizedText = ?, authorAddress = ?, ownerWeight = ? WHERE id = ?`,
          text,
          normalized,
          input.walletAddress ?? null,
          ownerWeight,
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
          operatorVoteOverride: null,
          ownerWeight,
        });
      }
      if (!proposal) throw new Error("Could not save idea");

      const roundRow = db.raw<any>(
        `SELECT votingStartedAtMs FROM promptRounds WHERE id = ? LIMIT 1`,
        round.id,
      )[0];
      if (roundRow && !roundRow.votingStartedAtMs) {
        const now = Date.now();
        db.exec(
          `UPDATE promptRounds SET votingStartedAtMs = ?, closesAtMs = ? WHERE id = ?`,
          now,
          now + VOTE_WINDOW_MS,
          round.id,
        );
      }
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
  return dbMeasure.measureSync.assert("Cancel persistent web proposal", () => {
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
}) {
  const round = await getOpenPromptRound();
  if (!round) return null;
  const weight = clampWeight(input.weight);
  return dbMeasure.measureSync.assert("Apply wallet voting power", () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(
        `UPDATE proposals SET authorAddress = ?, ownerWeight = ? WHERE roundId = ? AND source = 'web' AND sourceId = ? AND status = 'open'`,
        input.walletAddress,
        weight,
        round.id,
        input.ownerKey,
      );
      db.exec(
        `UPDATE proposalVotes SET weight = ? WHERE roundId = ? AND voterKey = ?`,
        weight,
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
  });
}

export async function castWebVote(input: {
  proposalId: number;
  voterKey: string;
  weight: number;
  walletAddress?: string | null;
}) {
  const round = await getOpenPromptRound();
  if (!round) return null;
  const target = round.proposals.find((item) => item.id === input.proposalId);
  if (!target) throw new Error("Idea is no longer active");
  if (target.source === "web" && target.sourceId === input.voterKey)
    throw new Error("Your own idea already carries your score");
  const weight = clampWeight(input.weight);

  return dbMeasure.measureSync.assert("Cast persistent web vote", () => {
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
        voterHandle: null,
        source: "web",
        sourceId: input.walletAddress ?? input.voterKey,
        weight,
      });
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
  return dbMeasure.measureSync.assert("Submit Pump.fun proposal", () => {
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
        weight: 1,
      });
      const row = db.raw<any>(
        `SELECT * FROM promptRounds WHERE id = ? LIMIT 1`,
        round.id,
      )[0];
      if (row && !row.votingStartedAtMs) {
        const now = Date.now();
        db.exec(
          `UPDATE promptRounds SET votingStartedAtMs = ?, closesAtMs = ? WHERE id = ?`,
          now,
          now + VOTE_WINDOW_MS,
          round.id,
        );
      }
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
  if (!round.proposals.some((p) => p.id === input.proposalId)) return null;
  return dbMeasure.measureSync.assert("Cast Pump.fun vote", () => {
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
        weight: 1,
      });
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
  const proposal = dbMeasure.measureSync("Resolve Pump.fun vote handle", () => {
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
  return dbMeasure.measureSync.assert("Override proposal votes", () => {
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
  const survivors = db.raw<any>(
    `SELECT * FROM proposals WHERE roundId = ? AND id != ? ORDER BY id ASC`,
    input.roundId,
    input.winnerProposalId,
  );
  const nextRound = db.promptRounds.insert({
    targetEpisode: input.targetEpisode,
    status: "open",
    openedAtMs: input.now,
    votingStartedAtMs: survivors.length ? input.now : null,
    closesAtMs: survivors.length ? input.now + VOTE_WINDOW_MS : 0,
    closedAtMs: null,
    winnerProposalId: null,
  });
  if (!nextRound) throw new Error("Could not open persistent proposal board");
  const nextRoundId = Number((nextRound as any).id);

  for (const proposal of survivors) {
    const cloned = db.proposals.insert({
      roundId: nextRoundId,
      text: proposal.text,
      normalizedText: proposal.normalizedText,
      status: "open",
      source: proposal.source,
      sourceId: proposal.sourceId ?? null,
      author: proposal.author ?? null,
      authorAddress: proposal.authorAddress ?? null,
      sourceRoom: proposal.sourceRoom ?? null,
      operatorVoteOverride: proposal.operatorVoteOverride ?? null,
      ownerWeight: Math.max(0, Number(proposal.ownerWeight ?? 1)),
    });
    if (!cloned) throw new Error("Could not carry proposal forward");

    const votes = db.raw<any>(
      `SELECT * FROM proposalVotes WHERE roundId = ? AND proposalId = ? ORDER BY id ASC`,
      input.roundId,
      proposal.id,
    );
    for (const vote of votes) {
      db.proposalVotes.insert({
        roundId: nextRoundId,
        proposalId: Number((cloned as any).id),
        voterKey: vote.voterKey,
        voterHandle: vote.voterHandle ?? null,
        source: vote.source,
        sourceId: vote.sourceId ?? null,
        weight: Math.max(1, Number(vote.weight ?? 1)),
      });
    }
  }

  return nextRoundId;
}

export async function closePromptRound(
  winnerProposalId?: number,
): Promise<Directive | null> {
  const round = await getOpenPromptRound();
  if (!round || round.proposals.length === 0) return null;
  const nextTargetEpisode = Math.max(
    round.targetEpisode + 1,
    await nextEpisode(),
  );
  const winner =
    winnerProposalId == null
      ? round.proposals[0]
      : round.proposals.find((p) => p.id === winnerProposalId);
  if (!winner)
    throw new Error(`Proposal #${winnerProposalId} is not in the open round`);
  return dbMeasure.measureSync.assert("Close Pump.fun round", () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      db.exec(
        `UPDATE promptRounds SET status = 'closed', closedAtMs = ?, winnerProposalId = ? WHERE id = ? AND status = 'open'`,
        now,
        winner.id,
        round.id,
      );
      db.exec(
        `UPDATE proposals SET status = CASE WHEN id = ? THEN 'selected' ELSE 'lost' END WHERE roundId = ?`,
        winner.id,
        round.id,
      );
      let directive =
        db.raw<any>(
          `SELECT * FROM directives WHERE proposalId = ? LIMIT 1`,
          winner.id,
        )[0] || null;
      if (!directive) {
        directive = db.directives.insert({
          text: winner.text,
          status: "queued",
          usedEpisode: null,
          source: winner.source,
          sourceId: `round:${round.id}:proposal:${winner.id}`,
          author: winner.author,
          authorAddress: winner.authorAddress,
          sourceRoom: winner.sourceRoom,
          proposalId: winner.id,
        });
      }
      if (!directive) throw new Error("Could not create winning directive");
      carryProposalBoardForward({
        roundId: round.id,
        winnerProposalId: winner.id,
        targetEpisode: nextTargetEpisode,
        now,
      });
      db.exec("COMMIT");
      const hydrated = directiveWithVotesById(Number((directive as any).id));
      return hydrated ? toDirective(hydrated) : toDirective(directive);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  });
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
    const directive = await closePromptRound(proposalId);
    if (!directive) throw new Error("Could not close prompt round");
    return directive;
  }

  return dbMeasure.measureSync.assert("Override locked Pump.fun winner", () => {
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
          `UPDATE directives SET text = ?, sourceId = ?, author = ?, authorAddress = ?, sourceRoom = ?, proposalId = ? WHERE id = ?`,
          proposal.text,
          `round:${round.id}:proposal:${proposalId}`,
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
          sourceId: `round:${round.id}:proposal:${proposalId}`,
          author: proposal.author ?? null,
          authorAddress: proposal.authorAddress ?? null,
          sourceRoom: proposal.sourceRoom ?? null,
          proposalId,
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

export async function closePromptRoundIfDue(now = Date.now()) {
  const round = await getOpenPromptRound();
  if (
    !round ||
    !round.proposals.length ||
    !round.votingStartedAtMs ||
    round.closesAtMs > now
  )
    return null;
  return closePromptRound();
}

export async function operatorInjectProposal(text: string) {
  const round = await roundForNewSuggestion();
  const sourceId = `operator:${Date.now()}:${crypto.randomUUID()}`;

  return dbMeasure.measureSync.assert("Inject operator proposal", () => {
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
        weight: 1,
      });

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
  return closePromptRound(proposal.id);
}

export async function claimQueuedDirective(episode: number) {
  const queued = await dbMeasure.measureSync("Get queued directive", () =>
    db.directives
      .select()
      .where({ status: "queued" })
      .orderBy("id", "ASC")
      .first(),
  );
  if (!queued) return null;

  const claimed = await dbMeasure.measureSync("Claim directive", () =>
    db.directives
      .select()
      .where({ id: (queued as any).id })
      .updateAll({ status: "generating", usedEpisode: episode }),
  );
  if (claimed === null) throw new Error("Could not claim directive");

  return toDirective({ ...queued, status: "generating", usedEpisode: episode });
}

export async function hasQueuedDirective() {
  const row = await dbMeasure.measureSync("Check queued directive", () =>
    db.directives
      .select("id")
      .where({ status: "queued" })
      .orderBy("id", "ASC")
      .first(),
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
  const rows = await dbMeasure.measureSync("Load recent reconciled canon", () =>
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
  const row = await dbMeasure.measureSync("Load latest world state", () =>
    db.worldStateSnapshots.select().orderBy("episode", "DESC").first(),
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
  const row = await dbMeasure.measureSync("Load episode world state", () =>
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
  const row = await dbMeasure.measureSync("Load latest episode", () =>
    db.clips.select("episode").orderBy("episode", "DESC").first(),
  );
  return row ? Number((row as any).episode) + 1 : 0;
}

export async function saveClipWithWorldState(
  input: Omit<
    Clip,
    | "id"
    | "directiveSource"
    | "directiveAuthor"
    | "directiveAuthorAddress"
    | "directiveProposalId"
    | "directiveVoteCount"
  >,
  worldState: WorldState,
  snapshotMeta?: {
    plannedWorldState?: WorldState | null;
    audit?: Omit<WorldStateAudit, "episode"> | null;
  },
) {
  const row = await dbMeasure.measureSync.assert(
    "Persist generated scene + reconciled world state",
    () => {
      db.exec("BEGIN IMMEDIATE");
      try {
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
        if (!snapshot)
          throw new Error("Failed to persist world state snapshot");

        db.exec("COMMIT");
        return clipRow;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },
  );

  return toClip(row);
}

export async function getRecentGenerationTimings(
  limit = 16,
): Promise<GenerationTimingSample[]> {
  const rows = await dbMeasure.measureSync(
    "Load generation timing window",
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
  const row = await dbMeasure.measureSync("Load latest clip", () =>
    db.clips.select().orderBy("episode", "DESC").first(),
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
    "Load attributed timeline window",
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
      dbMeasure.measureSync("Count queued Pump.fun prompts", () =>
        db.directives.select().where({ status: "queued" }).count(),
      ),
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
