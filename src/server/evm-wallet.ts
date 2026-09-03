import {
  createPublicClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  isAddress,
  type Address,
} from "viem";
import { walletMeasure } from "./observability.ts";

export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

export const ROBINHOOD_CHAIN_ID = Math.max(
  1,
  Number(process.env.PUMPTV_ROBINHOOD_CHAIN_ID || ROBINHOOD_MAINNET_CHAIN_ID),
);

export const ROBINHOOD_RPC_URL = (
  process.env.PUMPTV_ROBINHOOD_RPC_URL ||
  (ROBINHOOD_CHAIN_ID === ROBINHOOD_TESTNET_CHAIN_ID
    ? "https://rpc.testnet.chain.robinhood.com"
    : "https://rpc.mainnet.chain.robinhood.com")
).trim();

export const ROBINHOOD_EXPLORER_URL = (
  process.env.PUMPTV_ROBINHOOD_EXPLORER_URL ||
  (ROBINHOOD_CHAIN_ID === ROBINHOOD_TESTNET_CHAIN_ID
    ? "https://explorer.testnet.chain.robinhood.com"
    : "https://robinhoodchain.blockscout.com")
).replace(/\/+$/, "");

export function walletNetworkInfo() {
  return {
    chainId: ROBINHOOD_CHAIN_ID,
    chainHex: `0x${ROBINHOOD_CHAIN_ID.toString(16)}`,
    name:
      ROBINHOOD_CHAIN_ID === ROBINHOOD_TESTNET_CHAIN_ID
        ? "Robinhood Chain Testnet"
        : "Robinhood Chain",
    currency: "ETH" as const,
    rpcUrl: ROBINHOOD_RPC_URL,
    explorerUrl: ROBINHOOD_EXPLORER_URL,
  };
}

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name:
    ROBINHOOD_CHAIN_ID === ROBINHOOD_TESTNET_CHAIN_ID
      ? "Robinhood Chain Testnet"
      : "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [ROBINHOOD_RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: ROBINHOOD_EXPLORER_URL },
  },
});

const CACHE_MS = Math.max(
  1_000,
  Number(process.env.PUMPTV_WALLET_SCORE_CACHE_MS || 20_000),
);

type CachedWallet = {
  atMs: number;
  ethBalance: number;
};

const cache = new Map<string, CachedWallet>();
let publicClient: ReturnType<typeof createPublicClient> | null = null;

function rpc() {
  if (!publicClient)
    publicClient = createPublicClient({
      chain: robinhoodChain,
      transport: http(ROBINHOOD_RPC_URL, { timeout: 8_000 }),
    });
  return publicClient;
}

export function normalizeEvmAddress(value: unknown): Address | null {
  const text = String(value || "").trim();
  if (!text || !isAddress(text)) return null;
  return getAddress(text);
}

export function walletOwnerKey(address: string) {
  const normalized = normalizeEvmAddress(address);
  if (!normalized) throw new Error("Invalid EVM wallet");
  return `wallet:${normalized}`;
}

/**
 * MetaMask now supplies identity and reward routing. Voting is intentionally
 * one-wallet/one-vote until PumpTV has an explicit ERC-20 voting contract on
 * Robinhood Chain; native ETH balance never increases voting power.
 */
export async function walletVotingPower(
  walletAddress: string | null,
  options: { fresh?: boolean } = {},
) {
  const address = normalizeEvmAddress(walletAddress);
  if (!address)
    return {
      chainId: ROBINHOOD_CHAIN_ID,
      network: robinhoodChain.name,
      currency: "ETH" as const,
      ethBalance: 0,
      power: 1,
    };

  const key = address.toLowerCase();
  const cached = cache.get(key);
  if (!options.fresh && cached && Date.now() - cached.atMs < CACHE_MS)
    return {
      chainId: ROBINHOOD_CHAIN_ID,
      network: robinhoodChain.name,
      currency: "ETH" as const,
      ethBalance: cached.ethBalance,
      power: 1,
    };

  return walletMeasure.measure(
    {
      start: () =>
        `Read Robinhood ETH balance ${address.slice(0, 6)}…${address.slice(-4)}`,
      end: (value) => ({
        chainId: value.chainId,
        ethBalance: value.ethBalance,
        power: value.power,
      }),
    },
    async () => {
      const balanceWei = await rpc().getBalance({ address });
      const ethBalance = Number(formatEther(balanceWei));
      cache.set(key, { atMs: Date.now(), ethBalance });
      return {
        chainId: ROBINHOOD_CHAIN_ID,
        network: robinhoodChain.name,
        currency: "ETH" as const,
        ethBalance,
        power: 1,
      };
    },
  );
}
