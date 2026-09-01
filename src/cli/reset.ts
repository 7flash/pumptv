import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { loadTomlEnvironment } from "../server/config-file.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
await loadTomlEnvironment(PROJECT_ROOT, ".config.toml");

function cleanEpisodeArg(value: string | undefined) {
  if (!value) return null;
  const normalized = value === "--from" ? null : value.replace(/^--from=/, "");
  if (!normalized) return null;
  const episode = Number(normalized);
  return Number.isInteger(episode) && episode >= 1 ? episode : null;
}

const { db, dbPath } = await import("../server/db.ts");
const { ROOM_NAME } = await import("../server/lease.ts");

const args = process.argv.slice(2);
const requeue = args.includes("--requeue");
let fromEpisode = cleanEpisodeArg(args[0]);
if (args[0] === "--from") fromEpisode = cleanEpisodeArg(args[1]);

const maxRow =
  db.raw<any>("SELECT MAX(episode) AS maxEpisode FROM clips")[0] || null;
const maxInternal = maxRow?.maxEpisode == null ? -1 : Number(maxRow.maxEpisode);
const maxEpisode = maxInternal + 1;

if (maxEpisode < 1) {
  console.log(`[reset] ${dbPath}`);
  console.log("[reset] no generated episodes exist; nothing to reset");
  process.exit(0);
}

const rl = createInterface({ input, output });
try {
  if (fromEpisode == null) {
    const answer = await rl.question(`Reset from episode [1-${maxEpisode}]: `);
    fromEpisode = cleanEpisodeArg(answer.trim());
  }

  if (fromEpisode == null || fromEpisode > maxEpisode) {
    console.error(`[reset] choose an episode between 1 and ${maxEpisode}`);
    process.exitCode = 1;
  } else {
    const fromInternal = fromEpisode - 1;
    const room =
      db.raw<any>("SELECT * FROM rooms WHERE name = ? LIMIT 1", ROOM_NAME)[0] ||
      null;
    if (room?.workerState === "generating") {
      console.error(
        "[reset] generation is active; wait for the current render to finish, then run reset again",
      );
      process.exitCode = 2;
    } else {
      const futureCount = Number(
        (
          db.raw<any>(
            "SELECT COUNT(*) AS count FROM clips WHERE episode >= ?",
            fromInternal,
          )[0] || {}
        ).count || 0,
      );
      const answer = await rl.question(
        `Reset from EP ${fromEpisode}? ${futureCount} episode${futureCount === 1 ? "" : "s"} will be removed; triggered prompts will ${requeue ? "be re-queued" : "remain consumed"}. [y/N] `,
      );

      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log("[reset] cancelled");
      } else {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (requeue) {
            // Explicit opt-in: replay the prompts that originally produced the removed episodes.
            db.exec(
              `UPDATE directives
               SET status = 'queued', usedEpisode = NULL, triggered = 1
               WHERE usedEpisode >= ${fromInternal}`,
            );
          } else {
            // Default reset is a clean rewind. Removed episodes do not silently create
            // a generation backlog; a fresh proposal trigger is required.
            db.exec(
              `UPDATE directives
               SET status = 'used', usedEpisode = NULL, triggered = 0
               WHERE usedEpisode >= ${fromInternal}`,
            );
          }

          db.exec(
            `DELETE FROM worldStateSnapshots WHERE episode >= ${fromInternal}`,
          );
          db.exec(`DELETE FROM clips WHERE episode >= ${fromInternal}`);

          const nextEpisode = Number(
            (
              db.raw<any>(
                "SELECT COALESCE(MAX(episode), -1) + 1 AS episode FROM clips",
              )[0] || {}
            ).episode || 0,
          );
          const pendingTriggered = Number(
            (
              db.raw<any>(
                "SELECT COUNT(*) AS count FROM directives WHERE triggered = 1 AND status IN ('queued','generating')",
              )[0] || {}
            ).count || 0,
          );
          db.exec(
            `UPDATE promptRounds SET targetEpisode = ${Math.max(1, nextEpisode + (pendingTriggered ? 1 : 0))} WHERE status = 'open'`,
          );
          const pendingRound =
            db.raw<any>(
              `SELECT p.roundId FROM directives d JOIN proposals p ON p.id = d.proposalId
             WHERE d.triggered = 1 AND d.status IN ('queued','generating')
             ORDER BY d.id ASC LIMIT 1`,
            )[0] || null;
          if (pendingRound)
            db.exec(
              `UPDATE promptRounds SET targetEpisode = ${Math.max(1, nextEpisode)} WHERE id = ${Number(pendingRound.roundId)}`,
            );

          db.exec(
            `UPDATE rooms SET
               workerState = 'idle',
               lastError = NULL,
               leaseOwner = NULL,
               leaseUntilMs = 0,
               generationMode = 'full',
               generationStage = 'idle',
               generationStartedAtMs = NULL,
               generationPauseKind = NULL,
               generationPauseReason = NULL,
               generationRetryAtMs = NULL,
               generationFailureCount = 0
             WHERE name = '${ROOM_NAME.replaceAll("'", "''")}'`,
          );

          db.exec("COMMIT");
        } catch (error) {
          try {
            db.exec("ROLLBACK");
          } catch {}
          throw error;
        }

        const remaining = Number(
          (db.raw<any>("SELECT COUNT(*) AS count FROM clips")[0] || {}).count ||
            0,
        );
        const queued = Number(
          (
            db.raw<any>(
              "SELECT COUNT(*) AS count FROM directives WHERE status = 'queued'",
            )[0] || {}
          ).count || 0,
        );
        console.log(`[reset] db=${dbPath}`);
        console.log(
          `[reset] kept ${remaining} episode${remaining === 1 ? "" : "s"}; ${queued} triggered prompt${queued === 1 ? "" : "s"} queued`,
        );
        console.log(`[reset] next generated episode will be EP ${fromEpisode}`);
      }
    }
  }
} finally {
  rl.close();
}
