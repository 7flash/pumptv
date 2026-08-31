import { measureSync } from "measure-fn";
import { db } from "./db.ts";

export const ROOM_NAME = process.env.PUMPTV_ROOM || "main";

type LeaseRow = {
  id: number;
  leaseOwner: string | null;
  leaseUntilMs: number;
};

export function acquireRoomLease(owner: string, ttlMs: number) {
  return (
    measureSync("Acquire room lease", () => {
      const now = Date.now();
      const until = now + ttlMs;

      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.raw<LeaseRow>(
          `SELECT id, leaseOwner, leaseUntilMs
           FROM rooms
           WHERE name = ?
           ORDER BY id ASC
           LIMIT 1`,
          ROOM_NAME,
        )[0];

        if (!row) {
          db.exec("COMMIT");
          return false;
        }

        if (
          row.leaseOwner &&
          row.leaseOwner !== owner &&
          Number(row.leaseUntilMs) > now
        ) {
          db.exec("COMMIT");
          return false;
        }

        db.exec(
          `UPDATE rooms
           SET leaseOwner = ?, leaseUntilMs = ?, heartbeatAtMs = ?
           WHERE id = ?`,
          owner,
          until,
          now,
          row.id,
        );
        db.exec("COMMIT");
        return true;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {}
        throw error;
      }
    }) ?? false
  );
}

export function renewRoomLease(owner: string, ttlMs: number) {
  return (
    measureSync("Renew room lease", () => {
      const now = Date.now();
      db.exec(
        `UPDATE rooms
         SET leaseUntilMs = ?, heartbeatAtMs = ?
         WHERE name = ? AND leaseOwner = ?`,
        now + ttlMs,
        now,
        ROOM_NAME,
        owner,
      );
      const row = db.raw<{ leaseOwner: string | null }>(
        `SELECT leaseOwner FROM rooms WHERE name = ? ORDER BY id ASC LIMIT 1`,
        ROOM_NAME,
      )[0];
      return row?.leaseOwner === owner;
    }) ?? false
  );
}

export function releaseRoomLease(owner: string) {
  measureSync("Release room lease", () => {
    db.exec(
      `UPDATE rooms
       SET leaseOwner = NULL, leaseUntilMs = 0, heartbeatAtMs = ?
       WHERE name = ? AND leaseOwner = ?`,
      Date.now(),
      ROOM_NAME,
      owner,
    );
  });
}
