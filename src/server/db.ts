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
          pumpChatState: z
            .enum(["disabled", "standby", "connecting", "live", "error"])
            .default("disabled"),
          pumpChatError: z.string().nullable().default(null),
          pumpChatLeaseOwner: z.string().nullable().default(null),
          pumpChatLeaseUntilMs: z.number().default(0),
          pumpChatHeartbeatAtMs: z.number().default(0),
        }),
        directives: z.object({
          text: z.string(),
          status: z.enum(["queued", "generating", "used"]).default("queued"),
          usedEpisode: z.number().nullable().default(null),
          source: z.enum(["web", "pumpfun"]).default("web"),
          sourceId: z.string().nullable().default(null),
          author: z.string().nullable().default(null),
          authorAddress: z.string().nullable().default(null),
          sourceRoom: z.string().nullable().default(null),
          proposalId: z.number().nullable().default(null),
        }),
        promptRounds: z.object({
          targetEpisode: z.number(),
          status: z.enum(["open", "closed"]).default("open"),
          openedAtMs: z.number(),
          closesAtMs: z.number(),
          closedAtMs: z.number().nullable().default(null),
          winnerProposalId: z.number().nullable().default(null),
        }),
        proposals: z.object({
          roundId: z.number(),
          text: z.string(),
          normalizedText: z.string(),
          status: z.enum(["open", "selected", "lost"]).default("open"),
          source: z.enum(["web", "pumpfun"]).default("web"),
          sourceId: z.string().nullable().default(null),
          author: z.string().nullable().default(null),
          authorAddress: z.string().nullable().default(null),
          sourceRoom: z.string().nullable().default(null),
        }),
        proposalVotes: z.object({
          roundId: z.number(),
          proposalId: z.number(),
          voterKey: z.string(),
          source: z.enum(["web", "pumpfun"]).default("web"),
          sourceId: z.string().nullable().default(null),
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

measureSync("Create directive source index", () =>
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS directives_source_source_id_unique
     ON directives(source, sourceId)
     WHERE sourceId IS NOT NULL`,
  ),
);

measureSync("Create one-open-round index", () =>
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS prompt_rounds_one_open_unique
     ON promptRounds(status)
     WHERE status = 'open'`,
  ),
);

measureSync("Create proposal merge index", () =>
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS proposals_round_text_unique
     ON proposals(roundId, normalizedText)`,
  ),
);

measureSync("Create proposal voter index", () =>
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS proposal_votes_round_voter_unique
     ON proposalVotes(roundId, voterKey)`,
  ),
);
