import type {
  Clip,
  Directive,
  Resolution,
  StreamState,
} from "../shared/contracts.ts";
import { db } from "./db.ts";
import { dbMeasure } from "./observability.ts";

function toClip(row: any): Clip {
  return {
    id: row.id,
    requestId: row.requestId,
    videoUrl: row.videoUrl,
    expandedPrompt: row.expandedPrompt ?? null,
    inferenceSeconds: row.inferenceSeconds ?? null,
    directive: row.directive,
    episode: row.episode,
    usedAnchorFrame: Boolean(row.usedAnchorFrame),
    resolution: row.resolution,
  };
}

function toDirective(row: any): Directive {
  return {
    id: row.id,
    text: row.text,
    status: row.status,
    usedEpisode: row.usedEpisode ?? null,
  };
}

export async function enqueueDirective(text: string) {
  return dbMeasure.measure("Enqueue directive", () =>
    db.directives.insert({ text }),
  );
}

export async function getQueuedDirective() {
  return dbMeasure.measure("Get queued directive", () =>
    db.directives
      .select()
      .where({ status: "queued" })
      .orderBy("id", "ASC")
      .first(),
  );
}

export async function markDirectiveUsed(id: number, episode: number) {
  return dbMeasure.measure("Mark directive used", () =>
    db.directives
      .select()
      .where({ id })
      .updateAll({ status: "used", usedEpisode: episode }),
  );
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

export async function getStreamState(): Promise<StreamState> {
  const [latest, directives, queuedCount] = await Promise.all([
    dbMeasure.measure("Load latest clip", () =>
      db.clips.select().orderBy("episode", "DESC").first(),
    ),
    dbMeasure.measure("Load recent directives", () =>
      db.directives.select().orderBy("id", "DESC").limit(12).all(),
    ),
    dbMeasure.measure("Count queued directives", () =>
      db.directives.select().where({ status: "queued" }).count(),
    ),
  ]);

  return {
    latestClip: latest ? toClip(latest) : null,
    recentDirectives: (directives || []).reverse().map(toDirective),
    queuedCount: queuedCount || 0,
  };
}

export function normalizeResolution(value: unknown): Resolution {
  return value === "480P" ? "480P" : "768P";
}
