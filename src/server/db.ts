import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database, z } from "sqlite-zod-orm";
import { measureSync } from "measure-fn";

const path = process.env.SLOP_DB_PATH || ".data/slopstream.sqlite";
mkdirSync(dirname(path), { recursive: true });

export const db = measureSync(
  "Open slop database",
  () =>
    new Database(
      path,
      {
        directives: z.object({
          text: z.string(),
          status: z.enum(["queued", "used"]).default("queued"),
          usedEpisode: z.number().nullable().default(null),
        }),
        clips: z.object({
          requestId: z.string(),
          videoUrl: z.string(),
          expandedPrompt: z.string().nullable().default(null),
          inferenceSeconds: z.number().nullable().default(null),
          directive: z.string(),
          episode: z.number(),
          usedAnchorFrame: z.boolean(),
          resolution: z.enum(["480P", "768P"]),
        }),
      },
      { timestamps: true },
    ),
);

if (!db) throw new Error("Could not open SQLite database");
