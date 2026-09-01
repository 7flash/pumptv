import {
  errorText,
  httpMeasure,
  measuredRoute,
} from "../../../../src/server/observability.ts";
import { sanitizeLine } from "../../../../src/server/prompt.ts";
import { attachWebWallet } from "../../../../src/server/repository.ts";
import {
  normalizeSolanaAddress,
  walletVotingPower,
} from "../../../../src/server/wallet-score.ts";

function ownerKey(value: unknown) {
  const id = sanitizeLine(String(value || ""), 180);
  if (!id) throw new Error("Missing proposal owner id");
  return `web:${id}`;
}

export function POST(request: Request) {
  return measuredRoute(request, async () => {
    try {
      const body = await httpMeasure.measure(
        "Parse wallet request",
        async () => {
          const raw = await request.json();
          if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error("Invalid JSON body");
          return raw as Record<string, unknown>;
        },
      );
      const address = normalizeSolanaAddress(body.walletAddress);
      if (!address) throw new Error("Invalid Solana wallet");
      const score = await httpMeasure.measure(
        {
          start: () => "Read wallet token balance",
          end: (value) => value,
        },
        () => walletVotingPower(address),
      );
      await httpMeasure.measure("Apply wallet score", () =>
        attachWebWallet({
          ownerKey: ownerKey(body.ownerId ?? body.viewerId),
          walletAddress: address,
          weight: score.power,
        }),
      );
      return Response.json({ walletAddress: address, ...score });
    } catch (error) {
      return Response.json({ error: errorText(error) }, { status: 400 });
    }
  });
}
