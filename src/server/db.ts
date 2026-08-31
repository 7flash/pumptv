import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database, z } from "sqlite-zod-orm";
import { measureSync } from "measure-fn";

export const dbPath = process.env.SLOP_DB_PATH || ".data/slopstream.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });

const defaultResolution =
  process.env.SLOP_RESOLUTION === "480P" ? "480P" : "768P";

const openedDb = measureSync(
  "Open slop database",
  () =>
    new Database(
      dbPath,
      {
        rooms: z.object({
          name: z.string(),
          running: z.boolean().default(true),
          resolution: z.enum(["480P", "768P"]).default(defaultResolution),
          workerState: z.enum(["idle", "generating", "error"]).default("idle"),
          lastError: z.string().nullable().default(null),
          leaseOwner: z.string().nullable().default(null),
          leaseUntilMs: z.number().default(0),
          heartbeatAtMs: z.number().default(0),
        }),
        directives: z.object({
          text: z.string(),
          status: z.enum(["queued", "generating", "used"]).default("queued"),
          usedEpisode: z.number().nullable().default(null),
        }),
        clips: z.object({
          requestId: z.string(),
          videoUrl: z.string(),
          expandedPrompt: z.string().nullable().default(null),
          inferenceSeconds: z.number().nullable().default(null),
          directive: z.string(),
          directiveId: z.number().nullable().default(null),
          episode: z.number(),
          anchorFrameUrl: z.string().nullable().default(null),
          usedAnchorFrame: z.boolean(),
          resolution: z.enum(["480P", "768P"]),
          startsAtMs: z.number().default(0),
          durationSeconds: z.number().default(5),
        }),
      },
      { timestamps: true },
    ),
);

if (!openedDb) throw new Error("Could not open SQLite database");
export const db = openedDb;
