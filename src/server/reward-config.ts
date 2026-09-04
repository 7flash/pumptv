import { getAddress, isAddress, type Address } from "viem";
import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_MAINNET_CHAIN_ID,
} from "./evm-wallet.ts";

export const ROBINHOOD_MAINNET_USDG_ADDRESS =
  "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

function configuredTokenAddress(): Address | null {
  const raw = (process.env.PUMPTV_REWARD_TOKEN_ADDRESS || "").trim();
  const candidate =
    raw ||
    (ROBINHOOD_CHAIN_ID === ROBINHOOD_MAINNET_CHAIN_ID
      ? ROBINHOOD_MAINNET_USDG_ADDRESS
      : "");
  if (!candidate || !isAddress(candidate)) return null;
  return getAddress(candidate);
}

export const WINNER_REWARD_CHAIN_ID = ROBINHOOD_CHAIN_ID;
export const WINNER_REWARD_ASSET = "USDG" as const;
export const WINNER_REWARD_TOKEN_ADDRESS = configuredTokenAddress();

const rewardText = (process.env.PUMPTV_WINNER_REWARD_USDG || "1.00").trim();
const rewardNumber = Number(rewardText);
export const WINNER_REWARD_USDG =
  Number.isFinite(rewardNumber) && rewardNumber >= 0 ? rewardNumber : 1;
export const WINNER_REWARD_USD_CENTS = Math.max(
  0,
  Math.round(WINNER_REWARD_USDG * 100),
);

export function rewardConfigIssue(): string | null {
  if (WINNER_REWARD_USDG <= 0) return null;
  if (!WINNER_REWARD_TOKEN_ADDRESS)
    return ROBINHOOD_CHAIN_ID === ROBINHOOD_MAINNET_CHAIN_ID
      ? "PUMPTV_REWARD_TOKEN_ADDRESS is invalid."
      : "PUMPTV_REWARD_TOKEN_ADDRESS is required outside Robinhood Chain mainnet.";
  return null;
}
