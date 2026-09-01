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

export function GET(request: Request) {
  return measuredRoute(request, async () => {
    try {
      const url = new URL(request.url);
      const address = normalizeSolanaAddress(
        url.searchParams.get("walletAddress"),
      );
      if (!address) throw new Error("Invalid Solana wallet");
      const fresh = /^(1|true|yes)$/i.test(
        url.searchParams.get("refresh") || "",
      );
      const score = await httpMeasure.measure(
        {
          start: () =>
            `Inspect wallet score ${address.slice(0, 5)}…${address.slice(-4)}`,
          end: (value) => ({
            tokenBalance: "[omitted]",
            power: value.power,
            fresh,
          }),
        },
        () => walletVotingPower(address, { fresh }),
      );
      return Response.json({ walletAddress: address, ...score });
    } catch (error) {
      return Response.json({ error: errorText(error) }, { status: 400 });
    }
  });
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
          end: (value) => ({ tokenBalance: "[omitted]", power: value.power }),
        },
        () => walletVotingPower(address),
      );
      await httpMeasure.measure(
        {
          start: () => "Apply wallet score",
          end: (round) => ({
            roundId: round?.id ?? null,
            proposals: round?.proposals.length ?? 0,
            power: score.power,
          }),
        },
        () =>
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
