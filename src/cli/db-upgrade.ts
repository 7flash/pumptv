import { fileURLToPath } from "node:url";
import { loadTomlEnvironment } from "../server/config-file.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
await loadTomlEnvironment(PROJECT_ROOT, ".config.toml");

// Importing db.ts is intentionally the only schema step here. sqlite-zod-orm owns
// the declarative table/column shape from its Database schema. This command only
// installs PumpTV's raw SQLite indexes and, when explicitly requested, performs
// legacy semantic data repair from pre-explicit-trigger builds.
const { db, dbPath } = await import("../server/db.ts");

const legacyRepair = process.argv.includes("--legacy-repair");
const now = Date.now();
const room =
  db.raw<any>(
    "SELECT * FROM rooms WHERE name = ? LIMIT 1",
    process.env.PUMPTV_ROOM || "main",
  )[0] || null;
const workerFresh =
  Number(room?.heartbeatAtMs || 0) > 0 &&
  now - Number(room.heartbeatAtMs) < 10_000;
const webFresh =
  Number(room?.webHeartbeatAtMs || 0) > 0 &&
  now - Number(room.webHeartbeatAtMs) < 10_000;

if (workerFresh || webFresh) {
  throw new Error(
    "PumpTV appears to be running. Stop the web process and worker, wait ~10 seconds, then run db-upgrade again.",
  );
}

const indexes = [
  `CREATE UNIQUE INDEX IF NOT EXISTS directives_source_source_id_unique
   ON directives(source, sourceId)
   WHERE sourceId IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS prompt_rounds_one_open_unique
   ON promptRounds(status)
   WHERE status = 'open'`,
  `CREATE UNIQUE INDEX IF NOT EXISTS proposals_round_text_unique
   ON proposals(roundId, normalizedText)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS proposal_votes_round_voter_unique
   ON proposalVotes(roundId, voterKey)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idea_rewards_round_proposal_unique
   ON ideaRewards(roundId, proposalId)`,
  `CREATE INDEX IF NOT EXISTS idea_rewards_wallet_idx
   ON ideaRewards(walletAddress, id DESC)`,
  `CREATE INDEX IF NOT EXISTS idea_rewards_status_idx
   ON ideaRewards(status, id)`,
  `CREATE INDEX IF NOT EXISTS proposal_votes_round_handle_idx
   ON proposalVotes(roundId, voterHandle)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS proposals_round_web_owner_unique
   ON proposals(roundId, sourceId)
   WHERE source = 'web' AND sourceId IS NOT NULL AND status = 'open'`,
  `CREATE INDEX IF NOT EXISTS proposals_round_participant_idx
   ON proposals(roundId, participantKey)`,
  `CREATE INDEX IF NOT EXISTS proposal_votes_round_participant_idx
   ON proposalVotes(roundId, participantKey)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS world_state_snapshots_episode_unique
   ON worldStateSnapshots(episode)`,
];

// WAL is database-level operational setup, not an import-time side effect.
const journal = db.raw<any>("PRAGMA journal_mode = WAL")[0] || null;

db.exec("BEGIN IMMEDIATE");
try {
  for (const sql of indexes) db.exec(sql);

  if (legacyRepair) {
    // One-time compatibility repair for databases that lived through the old
    // timed-round / auto-generation behavior. Never run implicitly at startup.
    db.exec(
      `UPDATE promptRounds
       SET votingStartedAtMs = NULL, closesAtMs = 0
       WHERE status = 'open'`,
    );
    db.exec(
      `UPDATE directives
       SET status = 'used', usedEpisode = NULL, triggered = 0
       WHERE COALESCE(triggered, 0) = 0
         AND status IN ('queued', 'generating')`,
    );
    db.exec(
      `UPDATE promptRounds
       SET targetEpisode = MAX(
         1,
         (SELECT COALESCE(MAX(episode), -1) + 1 FROM clips) +
         CASE WHEN EXISTS (
           SELECT 1 FROM directives
           WHERE COALESCE(triggered, 0) = 1
             AND status IN ('queued', 'generating')
         ) THEN 1 ELSE 0 END
       )
       WHERE status = 'open'`,
    );
    db.exec(
      `UPDATE promptRounds
       SET targetEpisode = MAX(1, (SELECT COALESCE(MAX(episode), -1) + 1 FROM clips))
       WHERE id IN (
         SELECT p.roundId
         FROM directives d
         JOIN proposals p ON p.id = d.proposalId
         WHERE COALESCE(d.triggered, 0) = 1
           AND d.status IN ('queued', 'generating')
       )`,
    );
  }

  db.exec("COMMIT");
} catch (error) {
  try {
    db.exec("ROLLBACK");
  } catch {}
  throw error;
}

console.log(`[db-upgrade] ${dbPath}`);
console.log(
  `[db-upgrade] journal=${String(journal?.journal_mode || journal?.journalMode || "wal")}`,
);
console.log(`[db-upgrade] ensured ${indexes.length} PumpTV indexes`);
console.log(
  `[db-upgrade] legacy repair=${legacyRepair ? "applied" : "skipped"}`,
);
