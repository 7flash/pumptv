import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { loadTomlEnvironment } from "../server/config-file.ts";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
await loadTomlEnvironment(PROJECT_ROOT, ".config.toml");

const rawArgs = process.argv.slice(2);
const localOnly = rawArgs.includes("--local");
const requeue = rawArgs.includes("--requeue");
const args = rawArgs.filter((arg) => arg !== "--local" && arg !== "--requeue");
const ADMIN_URL = (process.env.PUMPTV_ADMIN_URL || "")
  .trim()
  .replace(/\/+$/, "");
const ADMIN_TOKEN = (process.env.PUMPTV_ADMIN_TOKEN || "").trim();

function cleanEpisodeArg(value: string | undefined) {
  if (!value) return null;
  const normalized = value === "--from" ? null : value.replace(/^--from=/, "");
  if (!normalized) return null;
  const episode = Number(normalized);
  return Number.isInteger(episode) && episode >= 1 ? episode : null;
}

function headers(json = false) {
  const result: Record<string, string> = {};
  if (ADMIN_TOKEN) result["x-pumptv-admin-token"] = ADMIN_TOKEN;
  if (json) result["content-type"] = "application/json";
  return result;
}

async function remoteJson(path: string, init: RequestInit = {}) {
  const response = await fetch(`${ADMIN_URL}${path}`, init);
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: text || `HTTP ${response.status}` };
  }
  if (!response.ok)
    throw new Error(
      payload?.error || `Remote PumpTV returned HTTP ${response.status}`,
    );
  return payload;
}

let fromEpisode = cleanEpisodeArg(args[0]);
if (args[0] === "--from") fromEpisode = cleanEpisodeArg(args[1]);

const rl = createInterface({ input, output });
try {
  if (ADMIN_URL && !localOnly) {
    const info = await remoteJson("/api/admin/reset", { headers: headers() });
    const maxEpisode = Number(info.maxEpisode || 0);
    if (maxEpisode < 1) {
      console.log(`[reset] remote ${ADMIN_URL}`);
      console.log("[reset] no generated episodes exist; nothing to reset");
      process.exit(0);
    }

    if (fromEpisode == null) {
      const answer = await rl.question(
        `Reset remote ${ADMIN_URL} from episode [1-${maxEpisode}]: `,
      );
      fromEpisode = cleanEpisodeArg(answer.trim());
    }
    if (fromEpisode == null || fromEpisode > maxEpisode) {
      console.error(`[reset] choose an episode between 1 and ${maxEpisode}`);
      process.exitCode = 1;
    } else {
      const preview = await remoteJson(
        `/api/admin/reset?fromEpisode=${encodeURIComponent(String(fromEpisode))}&requeue=${requeue ? "1" : "0"}`,
        { headers: headers() },
      );
      if (!preview.canReset) {
        console.error(
          "[reset] generation is active; wait for it to finish, then run reset again",
        );
        process.exitCode = 2;
      } else {
        const answer = await rl.question(
          `Reset REMOTE ${ADMIN_URL} from EP ${fromEpisode}? ${preview.futureCount} episode${preview.futureCount === 1 ? "" : "s"} will be removed; triggered prompts will ${requeue ? "be re-queued" : "remain consumed"}. [y/N] `,
        );
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.log("[reset] cancelled");
        } else {
          const result = await remoteJson("/api/admin/reset", {
            method: "POST",
            headers: headers(true),
            body: JSON.stringify({ fromEpisode, requeue, confirm: true }),
          });
          console.log(`[reset] remote ${ADMIN_URL}`);
          console.log(
            `[reset] kept ${result.keptEpisodes} episode${result.keptEpisodes === 1 ? "" : "s"}; ${result.queuedTriggered} triggered prompt${result.queuedTriggered === 1 ? "" : "s"} queued`,
          );
          console.log(
            `[reset] next generated episode will be EP ${result.nextEpisode}`,
          );
        }
      }
    }
  } else {
    if (ADMIN_URL && localOnly)
      console.log(
        `[reset] explicit local mode; remote configured at ${ADMIN_URL}`,
      );
    const {
      previewResetRoom,
      resetRoomFromEpisode,
      currentMaxEpisode,
      dbPath,
    } = await import("../server/reset-room.ts");
    const maxEpisode = currentMaxEpisode();
    if (maxEpisode < 1) {
      console.log(`[reset] ${dbPath}`);
      console.log("[reset] no generated episodes exist; nothing to reset");
      process.exit(0);
    }
    if (fromEpisode == null) {
      const answer = await rl.question(
        `Reset from episode [1-${maxEpisode}]: `,
      );
      fromEpisode = cleanEpisodeArg(answer.trim());
    }
    if (fromEpisode == null || fromEpisode > maxEpisode) {
      console.error(`[reset] choose an episode between 1 and ${maxEpisode}`);
      process.exitCode = 1;
    } else {
      const preview = previewResetRoom(fromEpisode, requeue);
      if (!preview.canReset) {
        console.error(
          "[reset] generation is active; wait for it to finish, then run reset again",
        );
        process.exitCode = 2;
      } else {
        const answer = await rl.question(
          `Reset LOCAL from EP ${fromEpisode}? ${preview.futureCount} episode${preview.futureCount === 1 ? "" : "s"} will be removed; triggered prompts will ${requeue ? "be re-queued" : "remain consumed"}. [y/N] `,
        );
        if (!/^y(es)?$/i.test(answer.trim())) {
          console.log("[reset] cancelled");
        } else {
          const result = resetRoomFromEpisode({ fromEpisode, requeue });
          console.log(`[reset] db=${result.dbPath}`);
          console.log(
            `[reset] kept ${result.keptEpisodes} episode${result.keptEpisodes === 1 ? "" : "s"}; ${result.queuedTriggered} triggered prompt${result.queuedTriggered === 1 ? "" : "s"} queued`,
          );
          console.log(
            `[reset] next generated episode will be EP ${result.nextEpisode}`,
          );
        }
      }
    }
  }
} finally {
  rl.close();
}
