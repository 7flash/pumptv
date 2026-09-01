import { walletMeasure } from "./observability.ts";

const MINT = (process.env.PUMPTV_TOKEN_MINT || "").trim();
const RPC_URL =
  (process.env.PUMPTV_SOLANA_RPC_URL || "").trim() ||
  "https://api.mainnet-beta.solana.com";
const CACHE_MS = Math.max(
  5_000,
  Number(process.env.PUMPTV_WALLET_SCORE_CACHE_MS || 20_000),
);

type CacheEntry = { checkedAtMs: number; tokenBalance: number };
const cache = new Map<string, CacheEntry>();

function finitePositive(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

export function normalizeSolanaAddress(value: unknown) {
  const address = String(value || "").trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? address : null;
}

export async function tokenBalanceForWallet(
  address: string,
  options: { fresh?: boolean } = {},
) {
  if (!MINT) return 0;
  const cached = cache.get(address);
  if (!options.fresh && cached && Date.now() - cached.checkedAtMs < CACHE_MS)
    return cached.tokenBalance;

  const response = await walletMeasure.measure(
    {
      start: () => `Token balance ${address.slice(0, 5)}…${address.slice(-4)}`,
      end: (result) => ({ status: result.status }),
    },
    () =>
      fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenAccountsByOwner",
          params: [
            address,
            { mint: MINT },
            { encoding: "jsonParsed", commitment: "confirmed" },
          ],
        }),
      }),
  );
  if (!response.ok) throw new Error(`Solana RPC ${response.status}`);

  const payload = (await response.json()) as any;
  if (payload?.error)
    throw new Error(payload.error?.message || "Solana RPC error");

  const accounts = Array.isArray(payload?.result?.value)
    ? payload.result.value
    : [];
  const tokenBalance = accounts.reduce((sum: number, item: any) => {
    const amount =
      item?.account?.data?.parsed?.info?.tokenAmount?.uiAmountString ??
      item?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ??
      0;
    return sum + finitePositive(amount);
  }, 0);

  cache.set(address, { checkedAtMs: Date.now(), tokenBalance });
  return tokenBalance;
}

export async function walletVotingPower(
  address: string | null | undefined,
  options: { fresh?: boolean } = {},
) {
  if (!address) return { tokenBalance: 0, power: 1 };
  const normalized = normalizeSolanaAddress(address);
  if (!normalized) throw new Error("Invalid Solana wallet");
  const tokenBalance = await tokenBalanceForWallet(normalized, options);
  return { tokenBalance, power: 1 + tokenBalance };
}
