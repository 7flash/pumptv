import type {
  Clip,
  Directive,
  PumpChatState,
  Resolution,
  RoomState,
  StreamState,
  WorkerState,
  WorldState,
} from "../shared/contracts.ts";
import { getPromptArena } from "./arbitration.ts";
import { db } from "./db.ts";
import { ROOM_NAME } from "./lease.ts";
import { dbMeasure } from "./observability.ts";
import { EMPTY_WORLD_STATE, parseWorldStateJson } from "./world-state.ts";

const PUMPFUN_MINT = (process.env.SLOP_PUMPFUN_MINT || "").trim();
const PUMPFUN_PREFIX = process.env.SLOP_PUMPFUN_PREFIX ?? "!next";
const PUMPFUN_VOTE_PREFIX = process.env.SLOP_PUMPFUN_VOTE_PREFIX ?? "!vote";

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
    usedAnchorFrame: Boolean(row.usedAnchorFrame),
    resolution: row.resolution,
    startsAtMs: Number(row.startsAtMs || 0),
    durationSeconds: Number(row.durationSeconds || 5),
    showrunnerModel: row.showrunnerModel ?? null,
    showrunnerPlanJson: row.showrunnerPlanJson ?? null,
    showrunnerInputTokens: row.showrunnerInputTokens ?? null,
    showrunnerOutputTokens: row.showrunnerOutputTokens ?? null,
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

function toRoom(row: any, bufferedUntilMs: number | null = null): RoomState {
  return {
    name: row.name,
    running: Boolean(row.running),
    resolution: row.resolution,
    workerState: row.workerState,
    lastError: row.lastError ?? null,
    bufferedUntilMs,
    pumpfun: {
      enabled: Boolean(PUMPFUN_MINT),
      mint: PUMPFUN_MINT || null,
      prefix: PUMPFUN_PREFIX || null,
      votePrefix: PUMPFUN_VOTE_PREFIX || null,
      state: PUMPFUN_MINT ? row.pumpChatState || "standby" : "disabled",
      lastError: row.pumpChatError ?? null,
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

export async function setWorkerState(
  state: WorkerState,
  error: string | null = null,
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
  const rows = await dbMeasure.measureSync("Load recent canon", () =>
    db.clips.select().orderBy("episode", "DESC").limit(limit).all(),
  );

  return (rows || []).reverse().map((row: any) => {
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
          plan.action ? `Action: ${plan.action}` : null,
          plan.transition ? `Handoff: ${plan.transition}` : null,
          plan.endingBeat ? `Ending: ${plan.endingBeat}` : null,
        ]
          .filter(Boolean)
          .join(" | ");
      } catch {
        // Legacy/bad plan JSON falls through to durable prompt/directive canon.
      }
    }

    return row.h3Prompt
      ? `Directive: ${row.directive} | Generated shot: ${row.h3Prompt}`
      : String(row.directive);
  });
}

export async function getLatestWorldState(): Promise<WorldState> {
  const row = await dbMeasure.measureSync("Load latest world state", () =>
    db.worldStateSnapshots.select().orderBy("episode", "DESC").first(),
  );
  return row
    ? parseWorldStateJson((row as any).stateJson) || EMPTY_WORLD_STATE
    : EMPTY_WORLD_STATE;
}

export async function getWorldStateForEpisode(
  episode: number,
): Promise<WorldState | null> {
  const row = await dbMeasure.measureSync("Load episode world state", () =>
    db.worldStateSnapshots
      .select()
      .where({ episode })
      .orderBy("id", "DESC")
      .first(),
  );
  return row ? parseWorldStateJson((row as any).stateJson) : null;
}

export async function nextEpisode() {
  const row = await dbMeasure.measureSync("Load latest episode", () =>
    db.clips.select("episode").orderBy("episode", "DESC").first(),
  );
  return row ? Number((row as any).episode) + 1 : 0;
}

export async function saveClipWithWorldState(
  input: Omit<Clip, "id">,
  worldState: WorldState,
) {
  const row = await dbMeasure.measureSync.assert(
    "Persist generated scene + world state",
    () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const clipRow = db.clips.insert(input);
        if (!clipRow) throw new Error("Failed to persist generated clip");

        const snapshot = db.worldStateSnapshots.insert({
          episode: input.episode,
          clipId: Number((clipRow as any).id),
          stateJson: JSON.stringify(worldState),
          showrunnerModel: input.showrunnerModel ?? null,
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

export async function getTimeline(limit = 16): Promise<Clip[]> {
  const rows = await dbMeasure.measureSync("Load timeline window", () =>
    db.clips.select().orderBy("episode", "DESC").limit(limit).all(),
  );
  return (rows || [])
    .reverse()
    .map(toClip)
    .filter((clip: Clip) => clip.startsAtMs > 0);
}

export async function getStreamState(): Promise<StreamState> {
  const serverNowMs = Date.now();
  const [roomRow, timeline, directives, queuedCount, arena] = await Promise.all(
    [
      getRoomRow(),
      getTimeline(),
      recentDirectivesWithVotes(12),
      dbMeasure.measureSync("Count queued directives", () =>
        db.directives.select().where({ status: "queued" }).count(),
      ),
      getPromptArena(),
    ],
  );

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
  const worldState =
    worldStateEpisode == null
      ? null
      : await getWorldStateForEpisode(worldStateEpisode);

  return {
    serverNowMs,
    room: toRoom(roomRow, bufferedUntilMs),
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
    queuedCount: Number(queuedCount || 0),
  };
}
