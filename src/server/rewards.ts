import { Solard, sol } from "@solard/sdk";
import { db } from "./db.ts";
import { dbMeasure, rewardMeasure } from "./observability.ts";

const WALLET_NAME = (
  process.env.PUMPTV_REWARD_WALLET_NAME || "pumptv-winner-rewards"
).trim();
const SENDING_STALE_MS = Math.max(
  30_000,
  Number(process.env.PUMPTV_REWARD_SENDING_STALE_MS || 180_000),
);

let solard: Solard | null = null;
let sending: Promise<void> | null = null;

function cleanError(error: unknown) {
  return (
    error instanceof Error
      ? error.message
      : String(error || "Unknown reward error")
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

function sdk() {
  if (!solard) solard = new Solard();
  return solard;
}

function resolveRewardWallet(client: Solard): any {
  const wallets = (client.listWallets?.() || []) as any[];
  const existing = wallets.find((wallet) => {
    const values = [wallet?.name, wallet?.id, wallet?.label].map((value) =>
      String(value || "").trim(),
    );
    return values.includes(WALLET_NAME);
  });
  return existing || client.createWallet(WALLET_NAME);
}

export function rewardWalletInfo() {
  return rewardMeasure.measureSync("Resolve reward wallet", () => {
    const wallet = resolveRewardWallet(sdk());
    return {
      name: WALLET_NAME,
      address: String(wallet?.address || "") || null,
    };
  });
}

export function latestRewardForWallet(walletAddress: string) {
  return dbMeasure.measureSync("Load wallet reward status", () => {
    const row =
      db.raw<any>(
        `SELECT id, roundId, proposalId, walletAddress, amountLamports, status,
                signature, lastError, claimedAtMs, sentAtMs, createdAt, updatedAt
         FROM ideaRewards
         WHERE walletAddress = ?
         ORDER BY id DESC LIMIT 1`,
        walletAddress,
      )[0] || null;
    if (!row) return null;
    return {
      id: Number(row.id),
      roundId: Number(row.roundId),
      proposalId: Number(row.proposalId),
      amountLamports: Number(row.amountLamports),
      amountSol: Number(row.amountLamports) / 1_000_000_000,
      status: String(row.status),
      signature: row.signature ?? null,
      lastError: row.lastError ?? null,
      claimedAtMs: row.claimedAtMs == null ? null : Number(row.claimedAtMs),
      sentAtMs: row.sentAtMs == null ? null : Number(row.sentAtMs),
    };
  });
}

function markStaleSendingUncertain(now = Date.now()) {
  return dbMeasure.measureSync("Quarantine stale reward sends", () => {
    const rows = db.raw<any>(
      `SELECT id FROM ideaRewards
       WHERE status = 'sending' AND claimedAtMs IS NOT NULL AND claimedAtMs <= ?`,
      now - SENDING_STALE_MS,
    );
    for (const row of rows) {
      db.exec(
        `UPDATE ideaRewards
         SET status = 'uncertain', lastError = ?
         WHERE id = ? AND status = 'sending'`,
        "Reward worker restarted or timed out after send began; not retried automatically to prevent a duplicate SOL payment.",
        row.id,
      );
    }
    return { quarantined: rows.length };
  });
}

function claimPendingReward() {
  return dbMeasure.measureSync("Claim pending winner reward", () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row =
        db.raw<any>(
          `SELECT * FROM ideaRewards WHERE status = 'pending' ORDER BY id ASC LIMIT 1`,
        )[0] || null;
      if (!row) {
        db.exec("COMMIT");
        return null;
      }
      const claimedAtMs = Date.now();
      const updated = db.raw<any>(
        `UPDATE ideaRewards
         SET status = 'sending', claimedAtMs = ?, lastError = NULL
         WHERE id = ? AND status = 'pending'
         RETURNING *`,
        claimedAtMs,
        row.id,
      );
      db.exec("COMMIT");
      return updated?.[0] || null;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  });
}

function extractSignature(result: any) {
  const value =
    result?.signature ??
    result?.txid ??
    result?.transactionSignature ??
    result?.hash ??
    result?.context?.signature ??
    null;
  return value == null ? null : String(value);
}

async function sendOneReward(row: any) {
  const amountSol = Number(row.amountLamports) / 1_000_000_000;
  return rewardMeasure.measure(
    {
      start: () =>
        `Send winner reward #${Number(row.proposalId)} · ${amountSol.toFixed(3)} SOL`,
      end: (result) => ({
        rewardId: Number(row.id),
        proposalId: Number(row.proposalId),
        wallet: `${String(row.walletAddress).slice(0, 5)}…${String(row.walletAddress).slice(-4)}`,
        amountSol,
        signature: result.signature,
      }),
    },
    async () => {
      const client = sdk();
      const wallet = resolveRewardWallet(client);
      if (!wallet?.address)
        throw new Error("Solard reward wallet has no address");

      // Solard owns key custody/signing. PumpTV only requests the transfer.
      const result = await client
        .tx(String(wallet.address))
        .transferSol(String(row.walletAddress), sol(amountSol.toFixed(9)))
        .send();
      const signature = extractSignature(result);
      if (!signature)
        throw new Error("Solard returned no transaction signature");

      dbMeasure.measureSync("Complete winner reward", () =>
        db.raw<any>(
          `UPDATE ideaRewards
           SET status = 'sent', signature = ?, sentAtMs = ?, lastError = NULL
           WHERE id = ? AND status = 'sending'
           RETURNING id`,
          signature,
          Date.now(),
          row.id,
        ),
      );
      return { signature };
    },
  );
}

async function drainRewards() {
  markStaleSendingUncertain();
  while (true) {
    const row = claimPendingReward();
    if (!row) return;
    try {
      await sendOneReward(row);
    } catch (error) {
      // A transport error can occur after broadcast. Never automatically retry
      // an ambiguous SOL send: duplicate payout is worse than a reward that
      // needs operator reconciliation.
      const message = cleanError(error);
      dbMeasure.measureSync("Quarantine ambiguous winner reward", () =>
        db.exec(
          `UPDATE ideaRewards SET status = 'uncertain', lastError = ?
           WHERE id = ? AND status = 'sending'`,
          message,
          row.id,
        ),
      );
      rewardMeasure.measureSync("Winner reward needs reconciliation", () => ({
        rewardId: Number(row.id),
        proposalId: Number(row.proposalId),
        error: message,
      }));
    }
  }
}

export function kickRewardProcessor() {
  if (sending) return sending;
  sending = drainRewards().finally(() => {
    sending = null;
  });
  return sending;
}
