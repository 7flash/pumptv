import { walletMeasure } from "./observability.ts";

const MINT = (process.env.PUMPTV_TOKEN_MINT || "").trim();
const RPC_URL =
  (process.env.PUMPTV_SOLANA_RPC_URL || "").trim() ||
  "https://api.mainnet-beta.solana.com";
const CACHE_MS = Math.max(
  5_000,
  Number(process.env.PUMPTV_WALLET_SCORE_CACHE_MS || 20_000),
);

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

type BalanceSnapshot = {
  checkedAtMs: number;
  tokenBalance: number;
  tokenProgram: string;
  matchingAccounts: number;
};

const cache = new Map<string, BalanceSnapshot>();
let cachedMintProgram: string | null = null;

function requireMint() {
  if (!MINT) {
    throw new Error(
      "PUMPTV_TOKEN_MINT is not configured in the running web process. Put token_mint under [pumptv] in .config.toml and restart PumpTV",
    );
  }
  return MINT;
}

function finitePositive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function normalizeSolanaAddress(value: unknown) {
  const address = String(value || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? address : null;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`Solana RPC ${response.status}`);
  const payload = (await response.json()) as any;
  if (payload?.error)
    throw new Error(payload.error?.message || "Solana RPC error");
  return payload?.result as T;
}

async function tokenProgramForMint(options: { fresh?: boolean } = {}) {
  const mint = requireMint();
  if (!options.fresh && cachedMintProgram) return cachedMintProgram;

  const result = await walletMeasure.measure(
    {
      start: () => `Inspect token mint ${mint.slice(0, 5)}…${mint.slice(-4)}`,
      end: (value: any) => ({ owner: value?.value?.owner ?? null }),
    },
    () =>
      rpc<{ value: { owner?: string } | null }>("getAccountInfo", [
        mint,
        { encoding: "base64", commitment: "confirmed" },
      ]),
  );

  const owner = String(result?.value?.owner || "");
  if (!owner) throw new Error(`Configured token mint ${mint} does not exist`);
  if (owner !== TOKEN_PROGRAM && owner !== TOKEN_2022_PROGRAM) {
    throw new Error(
      `Configured token mint ${mint} is not an SPL token mint (owner ${owner})`,
    );
  }
  cachedMintProgram = owner;
  return owner;
}

async function readWalletBalance(
  address: string,
  options: { fresh?: boolean } = {},
): Promise<BalanceSnapshot> {
  const mint = requireMint();
  const cached = cache.get(address);
  if (!options.fresh && cached && Date.now() - cached.checkedAtMs < CACHE_MS)
    return cached;

  const tokenProgram = await tokenProgramForMint(options);
  const result = await walletMeasure.measure(
    {
      start: () => `Token balance ${address.slice(0, 5)}…${address.slice(-4)}`,
      end: (value: any) => ({ accounts: value?.value?.length ?? 0 }),
    },
    () =>
      rpc<{ value: any[] }>("getTokenAccountsByOwner", [
        address,
        { programId: tokenProgram },
        { encoding: "jsonParsed", commitment: "confirmed" },
      ]),
  );

  const accounts = Array.isArray(result?.value) ? result.value : [];
  const matching = accounts.filter(
    (item: any) => item?.account?.data?.parsed?.info?.mint === mint,
  );
  const tokenBalance = matching.reduce((sum: number, item: any) => {
    const amount =
      item?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString ??
      item?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ??
      0;
    return sum + finitePositive(amount);
  }, 0);

  const snapshot = {
    checkedAtMs: Date.now(),
    tokenBalance,
    tokenProgram,
    matchingAccounts: matching.length,
  };
  cache.set(address, snapshot);
  return snapshot;
}

export async function tokenBalanceForWallet(
  address: string,
  options: { fresh?: boolean } = {},
) {
  return (await readWalletBalance(address, options)).tokenBalance;
}

export async function walletVotingPower(
  address: string | null | undefined,
  options: { fresh?: boolean } = {},
) {
  if (!address) {
    return {
      tokenBalance: 0,
      power: 1,
      mint: MINT || null,
      tokenProgram: null,
      matchingAccounts: 0,
    };
  }
  const normalized = normalizeSolanaAddress(address);
  if (!normalized) throw new Error("Invalid Solana wallet");
  const snapshot = await readWalletBalance(normalized, options);
  return {
    tokenBalance: snapshot.tokenBalance,
    power: 1 + snapshot.tokenBalance,
    mint: requireMint(),
    tokenProgram: snapshot.tokenProgram,
    matchingAccounts: snapshot.matchingAccounts,
  };
}
