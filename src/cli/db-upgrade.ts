import { fileURLToPath } from "node:url";
import { loadTomlEnvironment } from "../server/config-file.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
await loadTomlEnvironment(PROJECT_ROOT, ".config.toml");

// Importing db.ts is intentionally the only schema step here. sqlite-zod-orm owns
// the declarative table/column shape from its Database schema. This command only
// installs PumpTV's raw SQLite indexes, safely retires incompatible legacy
// reward rows, and, when explicitly requested, performs broader legacy semantic
// data repair from pre-explicit-trigger builds.
const { db, dbPath } = await import("../server/db.ts");

const legacyRepair = process.argv.includes("--legacy-repair");
let legacyRewardPendingSkipped = 0;
let legacyRewardSendingQuarantined = 0;
let ethRewardPendingConverted = 0;
let ethRewardSendingQuarantined = 0;
const { WINNER_REWARD_TOKEN_ADDRESS } =
  await import("../server/reward-config.ts");
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
  `CREATE INDEX IF NOT EXISTS idea_rewards_chain_status_idx
   ON ideaRewards(chainId, asset, status, id)`,
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

  // v47-v50 paid winners in SOL. The v51 schema keeps those rows as
  // chainId=0 / asset=LEGACY so the Robinhood worker can never reinterpret a
  // historical Solana payout as an EVM transfer. Pending legacy payouts are
  // explicitly retired; in-flight legacy payouts are quarantined because
  // replaying them could pay a winner twice.
  legacyRewardPendingSkipped = Number(
    (
      db.raw<any>(
        `SELECT COUNT(*) AS count FROM ideaRewards
         WHERE chainId = 0 AND asset = 'LEGACY' AND status = 'pending'`,
      )[0] || {}
    ).count || 0,
  );
  legacyRewardSendingQuarantined = Number(
    (
      db.raw<any>(
        `SELECT COUNT(*) AS count FROM ideaRewards
         WHERE chainId = 0 AND asset = 'LEGACY' AND status = 'sending'`,
      )[0] || {}
    ).count || 0,
  );
  if (legacyRewardPendingSkipped > 0)
    db.exec(
      `UPDATE ideaRewards
       SET status = 'skipped',
           lastError = 'Legacy SOL reward retired during Robinhood Chain migration; it was never converted or replayed as a Robinhood Chain reward.'
       WHERE chainId = 0 AND asset = 'LEGACY' AND status = 'pending'`,
    );
  if (legacyRewardSendingQuarantined > 0)
    db.exec(
      `UPDATE ideaRewards
       SET status = 'uncertain',
           lastError = 'Legacy SOL reward was in-flight during Robinhood Chain migration; not replayed automatically because payout state is ambiguous.'
       WHERE chainId = 0 AND asset = 'LEGACY' AND status = 'sending'`,
    );

  // v51-v59 queued native-ETH rewards can be converted safely only before a
  // broadcast begins. Anything already claimed without a durable hash is
  // quarantined rather than replayed as USDG and risking a double payout.
  ethRewardPendingConverted = Number(
    (
      db.raw<any>(
        `SELECT COUNT(*) AS count FROM ideaRewards
         WHERE chainId = ? AND asset = 'ETH' AND status = 'pending'`,
        Number(process.env.PUMPTV_ROBINHOOD_CHAIN_ID || 4663),
      )[0] || {}
    ).count || 0,
  );
  ethRewardSendingQuarantined = Number(
    (
      db.raw<any>(
        `SELECT COUNT(*) AS count FROM ideaRewards
         WHERE chainId = ? AND asset = 'ETH' AND status = 'sending' AND signature IS NULL`,
        Number(process.env.PUMPTV_ROBINHOOD_CHAIN_ID || 4663),
      )[0] || {}
    ).count || 0,
  );
  if (ethRewardPendingConverted > 0) {
    if (!WINNER_REWARD_TOKEN_ADDRESS)
      throw new Error(
        "Cannot convert pending ETH rewards: USDG reward token is not configured",
      );
    db.exec(
      `UPDATE ideaRewards
       SET asset = 'USDG', tokenAddress = ?, tokenDecimals = NULL,
           amountAtomic = NULL, amountWei = NULL,
           quotedEthUsdMicros = NULL, quoteSource = NULL,
           lastError = 'Queued ETH reward converted to USDG before broadcast.'
       WHERE chainId = ? AND asset = 'ETH' AND status = 'pending'`,
      WINNER_REWARD_TOKEN_ADDRESS,
      Number(process.env.PUMPTV_ROBINHOOD_CHAIN_ID || 4663),
    );
  }
  if (ethRewardSendingQuarantined > 0)
    db.exec(
      `UPDATE ideaRewards
       SET status = 'uncertain',
           lastError = 'ETH reward was in-flight during USDG migration without a durable transaction hash; not replayed automatically.'
       WHERE chainId = ? AND asset = 'ETH' AND status = 'sending' AND signature IS NULL`,
      Number(process.env.PUMPTV_ROBINHOOD_CHAIN_ID || 4663),
    );

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
console.log(
  `[db-upgrade] legacy SOL rewards: ${legacyRewardPendingSkipped} pending retired, ${legacyRewardSendingQuarantined} in-flight quarantined`,
);
