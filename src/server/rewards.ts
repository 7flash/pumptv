import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { db } from "./db.ts";
import {
  normalizeEvmAddress,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_EXPLORER_URL,
  ROBINHOOD_RPC_URL,
  robinhoodChain,
} from "./evm-wallet.ts";
import { dbMeasure, rewardMeasure } from "./observability.ts";
import { ethUsdToMicros, rewardWeiForUsdCents } from "./reward-amount.ts";

const PRICE_URL = (
  process.env.PUMPTV_REWARD_ETH_USD_URL ||
  "https://api.coinbase.com/v2/prices/ETH-USD/spot"
).trim();
const PRICE_CACHE_MS = Math.max(
  10_000,
  Number(process.env.PUMPTV_REWARD_PRICE_CACHE_MS || 60_000),
);
const PRICE_RETRY_MS = Math.max(
  5_000,
  Number(process.env.PUMPTV_REWARD_PRICE_RETRY_MS || 30_000),
);
const SENDING_STALE_MS = Math.max(
  30_000,
  Number(process.env.PUMPTV_REWARD_SENDING_STALE_MS || 180_000),
);

let sending: Promise<void> | null = null;
let quoteCache: { atMs: number; ethUsdMicros: number; source: string } | null = null;
let nextQuoteAttemptAtMs = 0;

class RewardDeferredError extends Error {}
class RewardSkippedError extends Error {}

function cleanError(error: unknown) {
  return (error instanceof Error ? error.message : String(error || "Unknown reward error"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

function rewardPrivateKey(): Hex {
  const raw = (process.env.PUMPTV_REWARD_PRIVATE_KEY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw))
    throw new Error(
      "PUMPTV_REWARD_PRIVATE_KEY must be a 32-byte 0x-prefixed EVM private key",
    );
  return raw as Hex;
}

function clients() {
  const account = privateKeyToAccount(rewardPrivateKey());
  const publicClient = createPublicClient({
    chain: robinhoodChain,
    transport: http(ROBINHOOD_RPC_URL, { timeout: 10_000 }),
  });
  const walletClient = createWalletClient({
    account,
    chain: robinhoodChain,
    transport: http(ROBINHOOD_RPC_URL, { timeout: 10_000 }),
  });
  return { account, publicClient, walletClient };
}

export async function rewardWalletInfo() {
  return rewardMeasure.measure(
    {
      start: () => "Inspect Robinhood reward wallet",
      end: (value) => ({
        address: value.address,
        chainId: value.chainId,
        balanceEth: value.balanceEth,
      }),
    },
    async () => {
      const { account, publicClient } = clients();
      const balanceWei = await publicClient.getBalance({ address: account.address });
      return {
        address: account.address,
        chainId: ROBINHOOD_CHAIN_ID,
        network: robinhoodChain.name,
        rpc: ROBINHOOD_RPC_URL,
        explorer: ROBINHOOD_EXPLORER_URL,
        balanceEth: Number(formatEther(balanceWei)),
      };
    },
  );
}

export function latestRewardForWallet(walletAddress: string) {
  const address = normalizeEvmAddress(walletAddress);
  if (!address) return null;
  return dbMeasure.measureSync("Load Robinhood wallet reward status", () => {
    const row =
      db.raw<any>(
        `SELECT id, roundId, proposalId, walletAddress, chainId, asset,
                targetUsdCents, amountWei, quotedEthUsdMicros, quoteSource,
                status, signature, lastError, claimedAtMs, sentAtMs,
                createdAt, updatedAt
         FROM ideaRewards
         WHERE lower(walletAddress) = lower(?) AND chainId = ? AND asset = 'ETH'
         ORDER BY id DESC LIMIT 1`,
        address,
        ROBINHOOD_CHAIN_ID,
      )[0] || null;
    if (!row) return null;
    const amountWei = row.amountWei == null ? null : BigInt(String(row.amountWei));
    return {
      id: Number(row.id),
      roundId: Number(row.roundId),
      proposalId: Number(row.proposalId),
      walletAddress: String(row.walletAddress),
      chainId: Number(row.chainId),
      asset: "ETH" as const,
      targetUsd: Number(row.targetUsdCents || 0) / 100,
      amountEth: amountWei == null ? null : Number(formatEther(amountWei)),
      quotedEthUsd:
        row.quotedEthUsdMicros == null
          ? null
          : Number(row.quotedEthUsdMicros) / 1_000_000,
      status: String(row.status),
      transactionHash: row.signature ?? null,
      explorerUrl: row.signature
        ? `${ROBINHOOD_EXPLORER_URL}/tx/${String(row.signature)}`
        : null,
      lastError: row.lastError ?? null,
      claimedAtMs: row.claimedAtMs == null ? null : Number(row.claimedAtMs),
      sentAtMs: row.sentAtMs == null ? null : Number(row.sentAtMs),
    };
  });
}

async function loadEthUsdQuote() {
  const now = Date.now();
  if (quoteCache && now - quoteCache.atMs < PRICE_CACHE_MS) return quoteCache;
  if (now < nextQuoteAttemptAtMs)
    throw new RewardDeferredError("Waiting before retrying ETH/USD quote");

  return rewardMeasure.measure(
    {
      start: () => "Quote ETH/USD for winner reward",
      end: (quote) => ({
        ethUsd: quote.ethUsdMicros / 1_000_000,
        source: quote.source,
      }),
    },
    async () => {
      try {
        const response = await fetch(PRICE_URL, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(6_000),
        });
        if (!response.ok)
          throw new Error(`ETH/USD quote HTTP ${response.status}`);
        const payload: any = await response.json();
        const raw =
          payload?.data?.amount ??
          payload?.ethereum?.usd ??
          payload?.price ??
          payload?.amount ??
          null;
        const ethUsdMicros = ethUsdToMicros(raw);
        const dollars = ethUsdMicros / 1_000_000;
        if (dollars < 100 || dollars > 1_000_000)
          throw new Error(`ETH/USD quote outside safety bounds: ${dollars}`);
        quoteCache = { atMs: Date.now(), ethUsdMicros, source: PRICE_URL };
        nextQuoteAttemptAtMs = 0;
        return quoteCache;
      } catch (error) {
        nextQuoteAttemptAtMs = Date.now() + PRICE_RETRY_MS;
        throw error;
      }
    },
  );
}

async function quoteOnePendingReward() {
  const row = dbMeasure.measureSync("Find unquoted winner reward", () =>
    db.raw<any>(
      `SELECT * FROM ideaRewards
       WHERE status = 'pending' AND chainId = ? AND asset = 'ETH'
         AND amountWei IS NULL
       ORDER BY id ASC LIMIT 1`,
      ROBINHOOD_CHAIN_ID,
    )[0] || null,
  );
  if (!row) return false;

  const quote = await loadEthUsdQuote();
  const targetUsdCents = Math.max(1, Number(row.targetUsdCents || 100));
  const amountWei = rewardWeiForUsdCents(targetUsdCents, quote.ethUsdMicros);
  if (amountWei <= 0n) throw new Error("Calculated reward is zero wei");

  dbMeasure.measureSync("Persist winner reward quote", () =>
    db.raw<any>(
      `UPDATE ideaRewards
       SET amountWei = ?, quotedEthUsdMicros = ?, quoteSource = ?, lastError = NULL
       WHERE id = ? AND status = 'pending' AND amountWei IS NULL
       RETURNING id`,
      amountWei.toString(),
      quote.ethUsdMicros,
      quote.source,
      row.id,
    ),
  );
  rewardMeasure.measureSync("Winner reward quoted", () => ({
    rewardId: Number(row.id),
    proposalId: Number(row.proposalId),
    targetUsd: targetUsdCents / 100,
    ethUsd: quote.ethUsdMicros / 1_000_000,
    amountEth: Number(formatEther(amountWei)),
  }));
  return true;
}

function claimPendingReward() {
  return dbMeasure.measureSync("Claim pending Robinhood winner reward", () => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const row =
        db.raw<any>(
          `SELECT * FROM ideaRewards
           WHERE status = 'pending' AND chainId = ? AND asset = 'ETH'
             AND amountWei IS NOT NULL
           ORDER BY id ASC LIMIT 1`,
          ROBINHOOD_CHAIN_ID,
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

function markSent(rewardId: number, hash: string) {
  dbMeasure.measureSync("Complete Robinhood winner reward", () =>
    db.raw<any>(
      `UPDATE ideaRewards
       SET status = 'sent', signature = ?, sentAtMs = ?, lastError = NULL
       WHERE id = ? AND status = 'sending'
       RETURNING id`,
      hash,
      Date.now(),
      rewardId,
    ),
  );
}

async function reconcileSendingRewards() {
  const rows = dbMeasure.measureSync("Load in-flight Robinhood rewards", () =>
    db.raw<any>(
      `SELECT * FROM ideaRewards
       WHERE status = 'sending' AND chainId = ? AND asset = 'ETH'
       ORDER BY id ASC`,
      ROBINHOOD_CHAIN_ID,
    ),
  );
  if (!rows.length) return;

  const { publicClient } = clients();
  for (const row of rows) {
    if (!row.signature) {
      if (
        row.claimedAtMs != null &&
        Number(row.claimedAtMs) <= Date.now() - SENDING_STALE_MS
      ) {
        dbMeasure.measureSync("Quarantine ambiguous Robinhood reward", () =>
          db.exec(
            `UPDATE ideaRewards
             SET status = 'uncertain', lastError = ?
             WHERE id = ? AND status = 'sending'`,
            "Reward worker stopped after broadcast may have begun but before a transaction hash was persisted; not retried automatically.",
            row.id,
          ),
        );
      }
      continue;
    }

    try {
      const receipt = await publicClient.getTransactionReceipt({
        hash: String(row.signature) as Hex,
      });
      if (receipt.status === "success") markSent(Number(row.id), String(row.signature));
      else
        dbMeasure.measureSync("Mark reverted Robinhood reward", () =>
          db.exec(
            `UPDATE ideaRewards SET status = 'skipped', lastError = ?
             WHERE id = ? AND status = 'sending'`,
            "Robinhood Chain reward transaction reverted.",
            row.id,
          ),
        );
    } catch {
      // Receipt not available yet. Keep the persisted transaction hash and let
      // the next worker tick reconcile it without ever broadcasting again.
    }
  }
}

async function preflightReward(row: any) {
  try {
    const { account, publicClient } = clients();
    const amountWei = BigInt(String(row.amountWei));
    const [balanceWei, fees] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.estimateFeesPerGas(),
    ]);
    const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    const reserveWei = maxFeePerGas * 30_000n;
    if (balanceWei < amountWei + reserveWei)
      throw new RewardDeferredError(
        `Reward wallet needs more ETH on Robinhood Chain (balance ${formatEther(balanceWei)} ETH).`,
      );
    return { amountWei, balanceWei, reserveWei };
  } catch (error) {
    if (error instanceof RewardDeferredError) throw error;
    // Nothing has been broadcast yet, so configuration/RPC failures are safe
    // to retry after the operator fixes the worker environment.
    throw new RewardDeferredError(cleanError(error));
  }
}

async function sendOneReward(row: any) {
  const amountWei = BigInt(String(row.amountWei));
  const address = normalizeEvmAddress(row.walletAddress);
  if (!address) throw new RewardSkippedError("Winner reward has an invalid EVM address");

  return rewardMeasure.measure(
    {
      start: () =>
        `Send winner reward #${Number(row.proposalId)} · ${Number(row.targetUsdCents || 0) / 100} USD in ETH`,
      end: (result) => ({
        rewardId: Number(row.id),
        proposalId: Number(row.proposalId),
        wallet: `${address.slice(0, 6)}…${address.slice(-4)}`,
        amountEth: Number(formatEther(amountWei)),
        transactionHash: result.transactionHash,
        confirmed: result.confirmed,
      }),
    },
    async () => {
      await preflightReward(row);
      const { walletClient, publicClient } = clients();

      let hash: Hex;
      try {
        hash = await walletClient.sendTransaction({
          to: address,
          value: amountWei,
        });
      } catch (error) {
        // No transaction hash was returned. The RPC could have accepted the
        // broadcast before the connection failed, so automatic retry is unsafe.
        throw error;
      }

      dbMeasure.measureSync("Persist Robinhood reward transaction hash", () =>
        db.exec(
          `UPDATE ideaRewards SET signature = ?, lastError = NULL
           WHERE id = ? AND status = 'sending'`,
          hash,
          row.id,
        ),
      );

      try {
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          timeout: 60_000,
        });
        if (receipt.status === "success") {
          markSent(Number(row.id), hash);
          return { transactionHash: hash, confirmed: true };
        }
        dbMeasure.measureSync("Mark reverted Robinhood reward", () =>
          db.exec(
            `UPDATE ideaRewards SET status = 'skipped', lastError = ?
             WHERE id = ? AND status = 'sending'`,
            "Robinhood Chain reward transaction reverted.",
            row.id,
          ),
        );
        return { transactionHash: hash, confirmed: false };
      } catch {
        // Hash is durable. Do not rebroadcast; reconciliation will finish this
        // row on a later worker tick when the receipt becomes available.
        return { transactionHash: hash, confirmed: false };
      }
    },
  );
}

async function drainRewards() {
  await reconcileSendingRewards();

  try {
    await quoteOnePendingReward();
  } catch (error) {
    if (!(error instanceof RewardDeferredError))
      rewardMeasure.measureSync("Winner reward quote deferred", () => ({
        error: cleanError(error),
        retryAfterMs: PRICE_RETRY_MS,
      }));
    return;
  }

  while (true) {
    const row = claimPendingReward();
    if (!row) return;
    try {
      await sendOneReward(row);
    } catch (error) {
      const message = cleanError(error);
      if (error instanceof RewardSkippedError) {
        dbMeasure.measureSync("Skip invalid Robinhood reward", () =>
          db.exec(
            `UPDATE ideaRewards
             SET status = 'skipped', lastError = ?
             WHERE id = ? AND status = 'sending' AND signature IS NULL`,
            message,
            row.id,
          ),
        );
        continue;
      }
      if (error instanceof RewardDeferredError) {
        dbMeasure.measureSync("Defer unfunded Robinhood reward", () =>
          db.exec(
            `UPDATE ideaRewards
             SET status = 'pending', claimedAtMs = NULL, lastError = ?
             WHERE id = ? AND status = 'sending' AND signature IS NULL`,
            message,
            row.id,
          ),
        );
        rewardMeasure.measureSync("Winner reward waiting for funding", () => ({
          rewardId: Number(row.id),
          proposalId: Number(row.proposalId),
          error: message,
        }));
        return;
      }

      dbMeasure.measureSync("Quarantine ambiguous Robinhood reward", () =>
        db.exec(
          `UPDATE ideaRewards SET status = 'uncertain', lastError = ?
           WHERE id = ? AND status = 'sending' AND signature IS NULL`,
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
