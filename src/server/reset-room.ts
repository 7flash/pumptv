import { db, dbPath } from "./db.ts";
export { dbPath };
import { ROOM_NAME } from "./lease.ts";
import { dbMeasure } from "./observability.ts";

export type ResetPreview = {
  dbPath: string;
  room: string;
  fromEpisode: number;
  maxEpisode: number;
  futureCount: number;
  requeue: boolean;
  workerState: string;
  canReset: boolean;
};

function positiveEpisode(value: unknown) {
  const episode = Number(value);
  if (!Number.isSafeInteger(episode) || episode < 1)
    throw new Error("fromEpisode must be a positive episode number");
  return episode;
}

export function currentMaxEpisode() {
  const row =
    db.raw<any>("SELECT MAX(episode) AS maxEpisode FROM clips")[0] || null;
  const internal = row?.maxEpisode == null ? -1 : Number(row.maxEpisode);
  return internal + 1;
}

export function previewResetRoom(
  fromEpisodeValue: unknown,
  requeue = false,
): ResetPreview {
  const fromEpisode = positiveEpisode(fromEpisodeValue);
  return dbMeasure.measureSync(
    {
      start: () => `Preview reset from EP ${fromEpisode}`,
      end: (preview) => ({
        fromEpisode: preview.fromEpisode,
        maxEpisode: preview.maxEpisode,
        futureCount: preview.futureCount,
        workerState: preview.workerState,
      }),
    },
    () => {
      const max = currentMaxEpisode();
      if (max < 1) throw new Error("No generated episodes exist");
      if (fromEpisode > max)
        throw new Error(`Choose an episode between 1 and ${max}`);
      const fromInternal = fromEpisode - 1;
      const room =
        db.raw<any>(
          "SELECT * FROM rooms WHERE name = ? LIMIT 1",
          ROOM_NAME,
        )[0] || null;
      const futureCount = Number(
        (
          db.raw<any>(
            "SELECT COUNT(*) AS count FROM clips WHERE episode >= ?",
            fromInternal,
          )[0] || {}
        ).count || 0,
      );
      const workerState = String(room?.workerState || "unknown");
      return {
        dbPath,
        room: ROOM_NAME,
        fromEpisode,
        maxEpisode: max,
        futureCount,
        requeue,
        workerState,
        canReset: workerState !== "generating",
      };
    },
  );
}

export function resetRoomFromEpisode(input: {
  fromEpisode: number;
  requeue?: boolean;
}) {
  const preview = previewResetRoom(input.fromEpisode, Boolean(input.requeue));
  if (!preview.canReset)
    throw new Error(
      "Generation is active; wait for the current render to finish, then reset again",
    );

  return dbMeasure.measureSync(
    {
      start: () => `Reset room from EP ${preview.fromEpisode}`,
      end: (result) => ({
        keptEpisodes: result.keptEpisodes,
        queuedTriggered: result.queuedTriggered,
        nextEpisode: result.nextEpisode,
      }),
    },
    () => {
      const fromInternal = preview.fromEpisode - 1;
      db.exec("BEGIN IMMEDIATE");
      try {
        if (preview.requeue) {
          // Replay only directives that came through the explicit trigger path.
          db.exec(
            `UPDATE directives
             SET status = 'queued', usedEpisode = NULL, triggered = 1
             WHERE usedEpisode >= ? AND sourceId LIKE 'trigger:%'`,
            fromInternal,
          );
          // Legacy/non-explicit directives remain consumed and cannot become a
          // surprise generation backlog after a reset.
          db.exec(
            `UPDATE directives
             SET status = 'used', usedEpisode = NULL, triggered = 0
             WHERE usedEpisode >= ? AND (sourceId IS NULL OR sourceId NOT LIKE 'trigger:%')`,
            fromInternal,
          );
        } else {
          db.exec(
            `UPDATE directives
             SET status = 'used', usedEpisode = NULL, triggered = 0
             WHERE usedEpisode >= ?`,
            fromInternal,
          );
        }

        db.exec(
          "DELETE FROM worldStateSnapshots WHERE episode >= ?",
          fromInternal,
        );
        db.exec("DELETE FROM clips WHERE episode >= ?", fromInternal);

        const nextInternal = Number(
          (
            db.raw<any>(
              "SELECT COALESCE(MAX(episode), -1) + 1 AS episode FROM clips",
            )[0] || {}
          ).episode || 0,
        );
        const pendingTriggered = Number(
          (
            db.raw<any>(
              `SELECT COUNT(*) AS count FROM directives
               WHERE COALESCE(triggered, 0) = 1
                 AND sourceId LIKE 'trigger:%'
                 AND status IN ('queued','generating')`,
            )[0] || {}
          ).count || 0,
        );
        const boardTarget = Math.max(
          1,
          nextInternal + (pendingTriggered ? 1 : 0),
        );
        db.exec(
          "UPDATE promptRounds SET targetEpisode = ? WHERE status = 'open'",
          boardTarget,
        );

        const pendingRound =
          db.raw<any>(
            `SELECT p.roundId
             FROM directives d
             JOIN proposals p ON p.id = d.proposalId
             WHERE COALESCE(d.triggered, 0) = 1
               AND d.sourceId LIKE 'trigger:%'
               AND d.status IN ('queued','generating')
             ORDER BY d.id ASC LIMIT 1`,
          )[0] || null;
        if (pendingRound)
          db.exec(
            "UPDATE promptRounds SET targetEpisode = ? WHERE id = ?",
            Math.max(1, nextInternal),
            Number(pendingRound.roundId),
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
           WHERE name = ?`,
          ROOM_NAME,
        );

        db.exec("COMMIT");

        const keptEpisodes = Number(
          (db.raw<any>("SELECT COUNT(*) AS count FROM clips")[0] || {}).count ||
            0,
        );
        const queuedTriggered = Number(
          (
            db.raw<any>(
              `SELECT COUNT(*) AS count FROM directives
               WHERE COALESCE(triggered, 0) = 1
                 AND sourceId LIKE 'trigger:%'
                 AND status = 'queued'`,
            )[0] || {}
          ).count || 0,
        );
        return {
          ...preview,
          keptEpisodes,
          queuedTriggered,
          nextEpisode: nextInternal + 1,
        };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    },
  );
}
