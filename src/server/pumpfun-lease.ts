import { measureSync } from "measure-fn";
import { db } from "./db.ts";
import { ROOM_NAME } from "./lease.ts";

type PumpLeaseRow = {
  id: number;
  pumpChatLeaseOwner: string | null;
  pumpChatLeaseUntilMs: number;
};

export function acquirePumpChatLease(owner: string, ttlMs: number) {
  return (
    measureSync("Acquire Pump.fun chat lease", () => {
      const now = Date.now();
      const until = now + ttlMs;

      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.raw<PumpLeaseRow>(
          `SELECT id, pumpChatLeaseOwner, pumpChatLeaseUntilMs
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
          row.pumpChatLeaseOwner &&
          row.pumpChatLeaseOwner !== owner &&
          Number(row.pumpChatLeaseUntilMs) > now
        ) {
          db.exec("COMMIT");
          return false;
        }

        db.exec(
          `UPDATE rooms
           SET pumpChatLeaseOwner = ?, pumpChatLeaseUntilMs = ?, pumpChatHeartbeatAtMs = ?
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

export function renewPumpChatLease(owner: string, ttlMs: number) {
  return (
    measureSync("Renew Pump.fun chat lease", () => {
      const now = Date.now();
      db.exec(
        `UPDATE rooms
         SET pumpChatLeaseUntilMs = ?, pumpChatHeartbeatAtMs = ?
         WHERE name = ? AND pumpChatLeaseOwner = ?`,
        now + ttlMs,
        now,
        ROOM_NAME,
        owner,
      );
      const row = db.raw<{ pumpChatLeaseOwner: string | null }>(
        `SELECT pumpChatLeaseOwner FROM rooms WHERE name = ? ORDER BY id ASC LIMIT 1`,
        ROOM_NAME,
      )[0];
      return row?.pumpChatLeaseOwner === owner;
    }) ?? false
  );
}

export function setPumpChatLeaseState(
  owner: string,
  state: "standby" | "connecting" | "live" | "error",
  error: string | null = null,
) {
  measureSync("Set Pump.fun leased state", () => {
    db.exec(
      `UPDATE rooms
       SET pumpChatState = ?, pumpChatError = ?
       WHERE name = ? AND pumpChatLeaseOwner = ?`,
      state,
      error ? error.replace(/\s+/g, " ").trim().slice(0, 600) : null,
      ROOM_NAME,
      owner,
    );
  });
}

export function releasePumpChatLease(owner: string) {
  measureSync("Release Pump.fun chat lease", () => {
    db.exec(
      `UPDATE rooms
       SET pumpChatLeaseOwner = NULL,
           pumpChatLeaseUntilMs = 0,
           pumpChatHeartbeatAtMs = ?,
           pumpChatState = 'standby',
           pumpChatError = NULL
       WHERE name = ? AND pumpChatLeaseOwner = ?`,
      Date.now(),
      ROOM_NAME,
      owner,
    );
  });
}
