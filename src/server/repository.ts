import type {
  Clip,
  Directive,
  GenerationMode,
  GenerationTimingSample,
  PumpChatState,
  Resolution,
  RoomState,
  StreamState,
  WorkerState,
  WorldState,
  WorldStateAudit,
} from "../shared/contracts.ts";
import { getPromptArena } from "./arbitration.ts";
import { evaluateBuffer } from "./adaptive-buffer.ts";
import { db } from "./db.ts";
import { ROOM_NAME } from "./lease.ts";
import { dbMeasure } from "./observability.ts";
import { EMPTY_WORLD_STATE, parseWorldStateJson } from "./world-state.ts";
import { getViewerCount } from "./presence.ts";

const PUMPFUN_MINT = (process.env.PUMPTV_PUMPFUN_MINT || "").trim();
const PUMPFUN_PREFIX = process.env.PUMPTV_PUMPFUN_PREFIX ?? "!next";
const PUMPFUN_VOTE_PREFIX = process.env.PUMPTV_PUMPFUN_VOTE_PREFIX ?? "!vote";

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
                   ELSE (SELECT COUNT(*) FROM proposalVotes v WHERE v.proposalId = d.proposalId)
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
                   ELSE (SELECT COUNT(*) FROM proposalVotes v WHERE v.proposalId = d.proposalId)
              END AS voteCount
       FROM directives d
       WHERE d.status IN ('generating', 'queued')
       ORDER BY CASE d.status WHEN 'generating' THEN 0 ELSE 1 END, d.id ASC
       LIMIT 1`,
      )[0] || null,
  );
}

function recentDirectivesWithVotes(limit: number) {
  return dbMeasure.measureSync("Load recent directives", () =>
    db.raw<any>(
      `SELECT d.*,
              CASE WHEN d.proposalId IS NULL THEN NULL
                   ELSE (SELECT COUNT(*) FROM proposalVotes v WHERE v.proposalId = d.proposalId)
              END AS voteCount
       FROM directives d
       ORDER BY d.id DESC
       LIMIT ?`,
      limit,
    ),
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
      votePrefix: PUMPFUN_VOTE_PREFIX || null,
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
  return value === "480P" ? "480P" : "768P";
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
                   ELSE (SELECT COUNT(*) FROM proposalVotes v WHERE v.proposalId = d.proposalId)
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
  const [roomRow, timeline, directives, queuedCount, arena, timings] =
    await Promise.all([
      getRoomRow(),
      getTimeline(),
      recentDirectivesWithVotes(12),
      dbMeasure.measureSync("Count queued directives", () =>
        db.directives.select().where({ status: "queued" }).count(),
      ),
      getPromptArena(),
      getRecentGenerationTimings(),
    ]);

  const latestClip = timeline.length ? timeline[timeline.length - 1] : null;
  const currentClip =
    timeline.find(
      (clip) =>
        clip.startsAtMs <= serverNowMs &&
        serverNowMs < clip.startsAtMs + clip.durationSeconds * 1000,
    ) || null;
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
  // Show canon only for reality the viewer has reached. Never leak a prebuffered future snapshot.
  const lastStartedClip =
    currentClip ||
    [...timeline].reverse().find((clip) => clip.startsAtMs <= serverNowMs) ||
    null;
  const worldStateEpisode = lastStartedClip?.episode ?? null;
  const worldSnapshot =
    worldStateEpisode == null
      ? null
      : await getWorldStateSnapshotForEpisode(worldStateEpisode);
  const worldState = worldSnapshot?.worldState ?? null;
  const worldStateAudit = worldSnapshot?.audit ?? null;

  return {
    serverNowMs,
    room: toRoom(roomRow, bufferedUntilMs, buffer),
    currentClip,
    nextClip,
    latestClip,
    currentDirective: currentDirectiveRow
      ? toDirective(currentDirectiveRow)
      : null,
    nextDirective: nextDirectiveRow ? toDirective(nextDirectiveRow) : null,
    timeline,
    recentDirectives: (directives || []).reverse().map(toDirective),
    arena,
    worldState,
    worldStateEpisode,
    worldStateAudit,
    queuedCount: Number(queuedCount || 0),
  };
}
