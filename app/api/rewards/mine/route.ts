import {
  measuredRoute,
  errorText,
} from "../../../../src/server/observability.ts";
import { normalizeSolanaAddress } from "../../../../src/server/wallet-score.ts";
import { latestRewardForWallet } from "../../../../src/server/rewards.ts";

export function GET(request: Request) {
  return measuredRoute(request, () => {
    try {
      const walletAddress = normalizeSolanaAddress(
        new URL(request.url).searchParams.get("walletAddress"),
      );
      if (!walletAddress) throw new Error("Invalid Solana wallet");
      return Response.json({ reward: latestRewardForWallet(walletAddress) });
    } catch (error) {
      return Response.json({ error: errorText(error) }, { status: 400 });
    }
  });
}
