import {
  errorText,
  httpMeasure,
  measuredRoute,
} from "../../../../src/server/observability.ts";
import { sanitizeLine } from "../../../../src/server/prompt.ts";
import {
  assertRequestAllowed,
  ModerationBlockedError,
  recordSubjectOrigin,
} from "../../../../src/server/moderation.ts";
import { attachWebWallet } from "../../../../src/server/repository.ts";
import {
  normalizeEvmAddress,
  walletNetworkInfo,
  walletOwnerKey,
  walletVotingPower,
} from "../../../../src/server/evm-wallet.ts";

function ownerKey(value: unknown) {
  const id = sanitizeLine(String(value || ""), 180);
  if (!id) throw new Error("Missing proposal owner id");
  return `web:${id}`;
}

export function GET(request: Request) {
  return measuredRoute(request, async () => {
    try {
      const url = new URL(request.url);
      const rawAddress = url.searchParams.get("walletAddress");
      if (!rawAddress) return Response.json({ network: walletNetworkInfo() });
      const address = normalizeEvmAddress(rawAddress);
      if (!address) throw new Error("Invalid EVM wallet");
      const fresh = /^(1|true|yes)$/i.test(
        url.searchParams.get("refresh") || "",
      );
      const score = await httpMeasure.measure(
        {
          start: () =>
            `Inspect Robinhood wallet ${address.slice(0, 6)}…${address.slice(-4)}`,
          end: (value) => ({
            chainId: value.chainId,
            ethBalance: value.ethBalance,
            power: value.power,
            fresh,
          }),
        },
        () => walletVotingPower(address, { fresh }),
      );
      return Response.json({ walletAddress: address, ...score });
    } catch (error) {
      return Response.json(
        { error: errorText(error) },
        { status: error instanceof ModerationBlockedError ? 403 : 400 },
      );
    }
  });
}

export function POST(request: Request) {
  return measuredRoute(request, async () => {
    try {
      const { originIpHash } = assertRequestAllowed(request);
      const body = await httpMeasure.measure(
        "Parse MetaMask wallet request",
        async () => {
          const raw = await request.json();
          if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error("Invalid JSON body");
          return raw as Record<string, unknown>;
        },
      );
      const address = normalizeEvmAddress(body.walletAddress);
      if (!address) throw new Error("Invalid EVM wallet");
      const anonymousOwnerKey = ownerKey(body.ownerId ?? body.viewerId);
      const walletKey = walletOwnerKey(address);
      const score = await httpMeasure.measure(
        {
          start: () => "Read Robinhood wallet state",
          end: (value) => ({
            chainId: value.chainId,
            ethBalance: value.ethBalance,
            power: value.power,
          }),
        },
        () => walletVotingPower(address),
      );
      await httpMeasure.measure(
        {
          start: () => "Attach MetaMask wallet identity",
          end: (round) => ({
            roundId: round?.id ?? null,
            proposals: round?.proposals.length ?? 0,
            power: score.power,
          }),
        },
        () =>
          attachWebWallet({
            ownerKey: anonymousOwnerKey,
            walletAddress: address,
            weight: score.power,
            participantKey: walletKey,
          }),
      );
      recordSubjectOrigin(anonymousOwnerKey, originIpHash);
      recordSubjectOrigin(walletKey, originIpHash);
      return Response.json({ walletAddress: address, ...score });
    } catch (error) {
      return Response.json(
        { error: errorText(error) },
        { status: error instanceof ModerationBlockedError ? 403 : 400 },
      );
    }
  });
}
