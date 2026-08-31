import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function flattenConfig(section: string, values: Record<string, unknown>) {
  const prefix = section.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  for (const [key, value] of Object.entries(values)) {
    if (value == null || typeof value === "object") continue;
    const envKey = `${prefix}_${key.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
    process.env[envKey] = String(value);
  }
}

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function loadRootConfig() {
  const configPath = resolve(PROJECT_ROOT, ".config.toml");
  if (!existsSync(configPath)) return;
  const parsed = Bun.TOML.parse(await Bun.file(configPath).text()) as Record<
    string,
    unknown
  >;
  for (const [section, value] of Object.entries(parsed)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenConfig(section, value as Record<string, unknown>);
    }
  }
}

function cleanEpisodeArg(value: string | undefined) {
  if (!value) return null;
  const normalized = value === "--from" ? null : value.replace(/^--from=/, "");
  if (!normalized) return null;
  const episode = Number(normalized);
  return Number.isInteger(episode) && episode >= 1 ? episode : null;
}

await loadRootConfig();

const { db, dbPath } = await import("../server/db.ts");
const { ROOM_NAME } = await import("../server/lease.ts");

const args = process.argv.slice(2);
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
        `Reset from EP ${fromEpisode}? ${futureCount} episode${futureCount === 1 ? "" : "s"} will be removed and their Pump.fun prompts re-queued. [y/N] `,
      );

      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log("[reset] cancelled");
      } else {
        db.exec("BEGIN IMMEDIATE");
        try {
          // Re-queue the chat messages that originally produced the removed episodes.
          db.exec(
            `UPDATE directives
             SET status = 'queued', usedEpisode = NULL
             WHERE source = 'pumpfun' AND usedEpisode >= ${fromInternal}`,
          );
          db.exec(
            `UPDATE directives
             SET status = 'queued', usedEpisode = NULL
             WHERE source = 'pumpfun' AND status = 'generating'`,
          );

          db.exec(
            `DELETE FROM worldStateSnapshots WHERE episode >= ${fromInternal}`,
          );
          db.exec(`DELETE FROM clips WHERE episode >= ${fromInternal}`);

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
              "SELECT COUNT(*) AS count FROM directives WHERE source = 'pumpfun' AND status = 'queued'",
            )[0] || {}
          ).count || 0,
        );
        console.log(`[reset] db=${dbPath}`);
        console.log(
          `[reset] kept ${remaining} episode${remaining === 1 ? "" : "s"}; ${queued} Pump.fun prompt${queued === 1 ? "" : "s"} queued`,
        );
        console.log(`[reset] next generated episode will be EP ${fromEpisode}`);
      }
    }
  }
} finally {
  rl.close();
}
