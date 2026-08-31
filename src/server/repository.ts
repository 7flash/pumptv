import type {
  Clip,
  Directive,
  Resolution,
  RoomState,
  StreamState,
  WorkerState,
} from "../shared/contracts.ts";
import { db } from "./db.ts";
import { ROOM_NAME } from "./lease.ts";
import { dbMeasure } from "./observability.ts";

function toClip(row: any): Clip {
  return {
    id: Number(row.id),
    requestId: row.requestId,
    videoUrl: row.videoUrl,
    expandedPrompt: row.expandedPrompt ?? null,
    inferenceSeconds: row.inferenceSeconds ?? null,
    directive: row.directive,
    directiveId: row.directiveId ?? null,
    episode: Number(row.episode),
    anchorFrameUrl: row.anchorFrameUrl ?? null,
    usedAnchorFrame: Boolean(row.usedAnchorFrame),
    resolution: row.resolution,
    startsAtMs: Number(row.startsAtMs || 0),
    durationSeconds: Number(row.durationSeconds || 5),
  };
}

function toDirective(row: any): Directive {
  return {
    id: Number(row.id),
    text: row.text,
    status: row.status,
    usedEpisode: row.usedEpisode ?? null,
  };
}

function toRoom(row: any, bufferedUntilMs: number | null = null): RoomState {
  return {
    name: row.name,
    running: Boolean(row.running),
    resolution: row.resolution,
    workerState: row.workerState,
    lastError: row.lastError ?? null,
    bufferedUntilMs,
  };
}

export function normalizeResolution(value: unknown): Resolution {
  return value === "480P" ? "480P" : "768P";
}

export async function getRoomRow() {
  let row = await dbMeasure.measure("Load room", () =>
    db.rooms.select().where({ name: ROOM_NAME }).orderBy("id", "ASC").first(),
  );

  if (!row) {
    row = await dbMeasure.measure("Create room", () =>
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

  await dbMeasure.measure("Update room settings", () =>
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
  return dbMeasure.measure("Set worker state", () =>
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

export async function enqueueDirective(text: string) {
  return dbMeasure.measure("Enqueue directive", () =>
    db.directives.insert({ text }),
  );
}

export async function claimQueuedDirective(episode: number) {
  const queued = await dbMeasure.measure("Get queued directive", () =>
    db.directives
      .select()
      .where({ status: "queued" })
      .orderBy("id", "ASC")
      .first(),
  );
  if (!queued) return null;

  const claimed = await dbMeasure.measure("Claim directive", () =>
    db.directives
      .select()
      .where({ id: (queued as any).id })
      .updateAll({ status: "generating", usedEpisode: episode }),
  );
  if (claimed === null) throw new Error("Could not claim directive");

  return toDirective({ ...queued, status: "generating", usedEpisode: episode });
}

export async function completeDirective(id: number) {
  return dbMeasure.measure("Complete directive", () =>
    db.directives.select().where({ id }).updateAll({ status: "used" }),
  );
}

export async function releaseDirective(id: number) {
  return dbMeasure.measure("Release directive", () =>
    db.directives
      .select()
      .where({ id })
      .updateAll({ status: "queued", usedEpisode: null }),
  );
}

export async function recoverGeneratingDirectives() {
  const rows = await dbMeasure.measure("Load abandoned directives", () =>
    db.directives.select().where({ status: "generating" }).all(),
  );

  for (const row of rows || []) {
    const directive = row as any;
    const clip = await dbMeasure.measure("Check recovered directive clip", () =>
      db.clips.select("id").where({ directiveId: directive.id }).first(),
    );

    await dbMeasure.measure("Recover abandoned directive", () =>
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
  const rows = await dbMeasure.measure("Load recent canon", () =>
    db.clips.select("directive").orderBy("episode", "DESC").limit(limit).all(),
  );
  return (rows || []).reverse().map((row: any) => row.directive as string);
}

export async function nextEpisode() {
  const row = await dbMeasure.measure("Load latest episode", () =>
    db.clips.select("episode").orderBy("episode", "DESC").first(),
  );
  return row ? Number((row as any).episode) + 1 : 0;
}

export async function saveClip(input: Omit<Clip, "id">) {
  const row = await dbMeasure.measure("Persist generated clip", () =>
    db.clips.insert(input),
  );
  if (!row) throw new Error("Failed to persist generated clip");
  return toClip(row);
}

export async function getLatestClip(): Promise<Clip | null> {
  const row = await dbMeasure.measure("Load latest clip", () =>
    db.clips.select().orderBy("episode", "DESC").first(),
  );
  if (!row) return null;

  const clip = toClip(row);
  if (clip.startsAtMs > 0) return clip;

  const startsAtMs = Date.now() + 400;
  await dbMeasure.measure("Repair legacy clip schedule", () =>
    db.clips.select().where({ id: clip.id }).updateAll({ startsAtMs }),
  );
  return { ...clip, startsAtMs };
}

export async function getTimeline(limit = 16): Promise<Clip[]> {
  const rows = await dbMeasure.measure("Load timeline window", () =>
    db.clips.select().orderBy("episode", "DESC").limit(limit).all(),
  );
  return (rows || [])
    .reverse()
    .map(toClip)
    .filter((clip) => clip.startsAtMs > 0);
}

export async function getStreamState(): Promise<StreamState> {
  const serverNowMs = Date.now();
  const [roomRow, timeline, directives, queuedCount] = await Promise.all([
    getRoomRow(),
    getTimeline(),
    dbMeasure.measure("Load recent directives", () =>
      db.directives.select().orderBy("id", "DESC").limit(16).all(),
    ),
    dbMeasure.measure("Count queued directives", () =>
      db.directives.select().where({ status: "queued" }).count(),
    ),
  ]);

  const latestClip = timeline.length ? timeline[timeline.length - 1] : null;
  const currentClip =
    timeline.find(
      (clip) =>
        clip.startsAtMs <= serverNowMs &&
        serverNowMs < clip.startsAtMs + clip.durationSeconds * 1000,
    ) || null;
  const bufferedUntilMs = latestClip
    ? latestClip.startsAtMs + latestClip.durationSeconds * 1000
    : null;

  return {
    serverNowMs,
    room: toRoom(roomRow, bufferedUntilMs),
    currentClip,
    latestClip,
    timeline,
    recentDirectives: (directives || []).reverse().map(toDirective),
    queuedCount: Number(queuedCount || 0),
  };
}
