import { httpMeasure } from "../../../../src/server/observability.ts";
import { sanitizeLine } from "../../../../src/server/prompt.ts";
import { attachWebWallet } from "../../../../src/server/repository.ts";
import {
  normalizeSolanaAddress,
  walletVotingPower,
} from "../../../../src/server/wallet-score.ts";

function ownerKey(value: unknown) {
  const id = sanitizeLine(String(value || ""), 160);
  if (!id) throw new Error("Missing viewer id");
  return `web:${id}`;
}

export async function POST(request: Request) {
  const result = await httpMeasure.measure(
    "POST /api/wallet/score",
    async (m) => {
      const raw = await m("Parse request", () => request.json());
      if (!raw || typeof raw !== "object") throw new Error("Invalid JSON body");
      const body = raw as Record<string, unknown>;
      const address = normalizeSolanaAddress(body.walletAddress);
      if (!address) throw new Error("Invalid Solana wallet");
      const score = await walletVotingPower(address);
      await attachWebWallet({
        ownerKey: ownerKey(body.viewerId),
        walletAddress: address,
        weight: score.power,
      });
      return { walletAddress: address, ...score };
    },
  );

  if (!result)
    return Response.json(
      { error: "Could not read token balance." },
      { status: 400 },
    );
  return Response.json(result);
}
