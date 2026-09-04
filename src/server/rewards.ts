import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  parseAbi,
  type Address,
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
import {
  rewardConfigIssue,
  WINNER_REWARD_ASSET,
  WINNER_REWARD_TOKEN_ADDRESS,
} from "./reward-config.ts";
import { formatTokenUnits, rewardTokenUnits } from "./reward-token.ts";

const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const SENDING_STALE_MS = Math.max(
  30_000,
  Number(process.env.PUMPTV_REWARD_SENDING_STALE_MS || 180_000),
);

let sending: Promise<void> | null = null;
let metadataCache: {
  address: Address;
  decimals: number;
  symbol: string;
  atMs: number;
} | null = null;

class RewardDeferredError extends Error {}
class RewardSkippedError extends Error {}

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

async function tokenMetadata() {
  const issue = rewardConfigIssue();
  if (issue) throw new RewardDeferredError(issue);
  const address = WINNER_REWARD_TOKEN_ADDRESS;
  if (!address)
    throw new RewardDeferredError("USDG reward token is not configured");
  if (
    metadataCache &&
    metadataCache.address.toLowerCase() === address.toLowerCase() &&
    Date.now() - metadataCache.atMs < 5 * 60_000
  )
    return metadataCache;

  return rewardMeasure.measure(
    {
      start: () =>
        `Inspect USDG reward token ${address.slice(0, 6)}…${address.slice(-4)}`,
      end: (value) => ({ symbol: value.symbol, decimals: value.decimals }),
    },
    async () => {
      const { publicClient } = clients();
      const [symbol, decimalsRaw] = await Promise.all([
        publicClient.readContract({
          address,
          abi: ERC20_ABI,
          functionName: "symbol",
        }),
        publicClient.readContract({
          address,
          abi: ERC20_ABI,
          functionName: "decimals",
        }),
      ]);
      const decimals = Number(decimalsRaw);
      if (String(symbol).toUpperCase() !== "USDG")
        throw new Error(
          `Configured reward token reports symbol '${String(symbol)}', expected USDG`,
        );
      if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36)
        throw new Error(
          `Configured USDG token has invalid decimals: ${decimals}`,
        );
      metadataCache = {
        address,
        decimals,
        symbol: String(symbol),
        atMs: Date.now(),
      };
      return metadataCache;
    },
  );
}

export async function rewardWalletInfo() {
  return rewardMeasure.measure(
    {
      start: () => "Inspect Robinhood USDG reward wallet",
      end: (value) => ({
        address: value.address,
        chainId: value.chainId,
        balanceUsdG: value.balanceUsdG,
        gasBalanceEth: value.gasBalanceEth,
      }),
    },
    async () => {
      const { account, publicClient } = clients();
      const metadata = await tokenMetadata();
      const [balanceAtomic, gasBalanceWei] = await Promise.all([
        publicClient.readContract({
          address: metadata.address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        }),
        publicClient.getBalance({ address: account.address }),
      ]);
      return {
        address: account.address,
        chainId: ROBINHOOD_CHAIN_ID,
        network: robinhoodChain.name,
        rpc: ROBINHOOD_RPC_URL,
        explorer: ROBINHOOD_EXPLORER_URL,
        asset: WINNER_REWARD_ASSET,
        tokenAddress: metadata.address,
        tokenDecimals: metadata.decimals,
        balanceUsdG: Number(formatUnits(balanceAtomic, metadata.decimals)),
        gasBalanceEth: Number(formatEther(gasBalanceWei)),
      };
    },
  );
}

export function latestRewardForWallet(walletAddress: string) {
  const address = normalizeEvmAddress(walletAddress);
  if (!address) return null;
  return dbMeasure.measureSync(
    "Load Robinhood USDG wallet reward status",
    () => {
      const row =
        db.raw<any>(
          `SELECT id, roundId, proposalId, walletAddress, chainId, asset,
                targetUsdCents, tokenAddress, tokenDecimals, amountAtomic,
                status, signature, lastError, claimedAtMs, sentAtMs,
                createdAt, updatedAt
         FROM ideaRewards
         WHERE lower(walletAddress) = lower(?) AND chainId = ? AND asset = ?
         ORDER BY id DESC LIMIT 1`,
          address,
          ROBINHOOD_CHAIN_ID,
          WINNER_REWARD_ASSET,
        )[0] || null;
      if (!row) return null;
      const atomic =
        row.amountAtomic == null ? null : BigInt(String(row.amountAtomic));
      const decimals =
        row.tokenDecimals == null ? null : Number(row.tokenDecimals);
      return {
        id: Number(row.id),
        roundId: Number(row.roundId),
        proposalId: Number(row.proposalId),
        walletAddress: String(row.walletAddress),
        chainId: Number(row.chainId),
        asset: WINNER_REWARD_ASSET,
        tokenAddress: row.tokenAddress ?? null,
        targetUsd: Number(row.targetUsdCents || 0) / 100,
        amountUsdG:
          atomic == null || decimals == null
            ? null
            : formatTokenUnits(atomic, decimals),
        status: String(row.status),
        transactionHash: row.signature ?? null,
        explorerUrl: row.signature
          ? `${ROBINHOOD_EXPLORER_URL}/tx/${String(row.signature)}`
          : null,
        lastError: row.lastError ?? null,
        claimedAtMs: row.claimedAtMs == null ? null : Number(row.claimedAtMs),
        sentAtMs: row.sentAtMs == null ? null : Number(row.sentAtMs),
      };
    },
  );
}

async function prepareOnePendingReward() {
  const row = dbMeasure.measureSync(
    "Find unprepared USDG winner reward",
    () =>
      db.raw<any>(
        `SELECT * FROM ideaRewards
       WHERE status = 'pending' AND chainId = ? AND asset = ?
         AND amountAtomic IS NULL
       ORDER BY id ASC LIMIT 1`,
        ROBINHOOD_CHAIN_ID,
        WINNER_REWARD_ASSET,
      )[0] || null,
  );
  if (!row) return false;

  const metadata = await tokenMetadata();
  if (
    row.tokenAddress &&
    String(row.tokenAddress).toLowerCase() !== metadata.address.toLowerCase()
  )
    throw new RewardDeferredError(
      `Reward row token ${row.tokenAddress} differs from configured USDG ${metadata.address}`,
    );

  const targetUsd = Math.max(0.01, Number(row.targetUsdCents || 100) / 100);
  const amountAtomic = rewardTokenUnits(targetUsd, metadata.decimals);
  if (amountAtomic <= 0n) throw new Error("Calculated USDG reward is zero");

  dbMeasure.measureSync("Persist USDG winner reward amount", () =>
    db.raw<any>(
      `UPDATE ideaRewards
       SET tokenAddress = ?, tokenDecimals = ?, amountAtomic = ?, lastError = NULL
       WHERE id = ? AND status = 'pending' AND amountAtomic IS NULL
       RETURNING id`,
      metadata.address,
      metadata.decimals,
      amountAtomic.toString(),
      row.id,
    ),
  );
  rewardMeasure.measureSync("Winner reward prepared", () => ({
    rewardId: Number(row.id),
    proposalId: Number(row.proposalId),
    amountUsdG: formatTokenUnits(amountAtomic, metadata.decimals),
    tokenAddress: metadata.address,
  }));
  return true;
}

function claimPendingReward() {
  return dbMeasure.measureSync(
    "Claim pending Robinhood USDG winner reward",
    () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row =
          db.raw<any>(
            `SELECT * FROM ideaRewards
           WHERE status = 'pending' AND chainId = ? AND asset = ?
             AND amountAtomic IS NOT NULL
           ORDER BY id ASC LIMIT 1`,
            ROBINHOOD_CHAIN_ID,
            WINNER_REWARD_ASSET,
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
    },
  );
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
       WHERE status = 'sending' AND chainId = ?
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
      if (receipt.status === "success")
        markSent(Number(row.id), String(row.signature));
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
      // Receipt not available yet. Keep the durable transaction hash and never
      // rebroadcast this reward.
    }
  }
}

async function preflightReward(row: any, recipient: Address) {
  try {
    const metadata = await tokenMetadata();
    if (
      !row.tokenAddress ||
      String(row.tokenAddress).toLowerCase() !== metadata.address.toLowerCase()
    )
      throw new RewardDeferredError(
        "Winner reward token does not match configured USDG",
      );

    const { account, publicClient } = clients();
    const amountAtomic = BigInt(String(row.amountAtomic));
    const [tokenBalance, gasBalanceWei, fees, estimatedGas] = await Promise.all(
      [
        publicClient.readContract({
          address: metadata.address,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        }),
        publicClient.getBalance({ address: account.address }),
        publicClient.estimateFeesPerGas(),
        publicClient.estimateContractGas({
          address: metadata.address,
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [recipient, amountAtomic],
          account: account.address,
        }),
      ],
    );

    if (tokenBalance < amountAtomic)
      throw new RewardDeferredError(
        `Reward wallet needs more USDG (balance ${formatUnits(tokenBalance, metadata.decimals)} USDG).`,
      );

    const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    const reserveWei = BigInt(estimatedGas) * BigInt(maxFeePerGas) * 2n;
    if (gasBalanceWei < reserveWei)
      throw new RewardDeferredError(
        `Reward wallet needs ETH for gas on Robinhood Chain (balance ${formatEther(gasBalanceWei)} ETH).`,
      );

    return { metadata, amountAtomic, tokenBalance, gasBalanceWei, reserveWei };
  } catch (error) {
    if (error instanceof RewardDeferredError) throw error;
    throw new RewardDeferredError(cleanError(error));
  }
}

async function sendOneReward(row: any) {
  const address = normalizeEvmAddress(row.walletAddress);
  if (!address)
    throw new RewardSkippedError("Winner reward has an invalid EVM address");
  const amountAtomic = BigInt(String(row.amountAtomic));
  const decimals = Number(row.tokenDecimals);

  return rewardMeasure.measure(
    {
      start: () =>
        `Send winner reward #${Number(row.proposalId)} · ${formatTokenUnits(amountAtomic, decimals)} USDG`,
      end: (result) => ({
        rewardId: Number(row.id),
        proposalId: Number(row.proposalId),
        wallet: `${address.slice(0, 6)}…${address.slice(-4)}`,
        amountUsdG: formatTokenUnits(amountAtomic, decimals),
        transactionHash: result.transactionHash,
        confirmed: result.confirmed,
      }),
    },
    async () => {
      const { metadata } = await preflightReward(row, address);
      const { walletClient, publicClient } = clients();

      let hash: Hex;
      try {
        hash = await walletClient.writeContract({
          address: metadata.address,
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [address, amountAtomic],
        });
      } catch (error) {
        // A transport error without a returned hash is ambiguous: the RPC may
        // have accepted the signed transaction. Do not automatically retry.
        throw error;
      }

      dbMeasure.measureSync(
        "Persist Robinhood USDG reward transaction hash",
        () =>
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
            "Robinhood Chain USDG reward transaction reverted.",
            row.id,
          ),
        );
        return { transactionHash: hash, confirmed: false };
      } catch {
        return { transactionHash: hash, confirmed: false };
      }
    },
  );
}

async function drainRewards() {
  await reconcileSendingRewards();

  try {
    await prepareOnePendingReward();
  } catch (error) {
    rewardMeasure.measureSync("Winner reward preparation deferred", () => ({
      error: cleanError(error),
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
