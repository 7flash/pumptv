import {
  errorText,
  httpMeasure,
  measuredRoute,
} from "../../../src/server/observability.ts";
import { sanitizeLine } from "../../../src/server/prompt.ts";
import {
  assertRequestAllowed,
  ModerationBlockedError,
  recordSubjectOrigin,
} from "../../../src/server/moderation.ts";
import { castWebVote } from "../../../src/server/repository.ts";
import {
  normalizeSolanaAddress,
  walletVotingPower,
} from "../../../src/server/wallet-score.ts";

function anonymousKey(value: unknown) {
  const id = sanitizeLine(String(value || ""), 180);
  if (!id) throw new Error("Missing voter id");
  return `web:${id}`;
}

function voterKey(value: unknown, walletAddress: string | null) {
  return walletAddress ? `wallet:${walletAddress}` : anonymousKey(value);
}

export function POST(request: Request) {
  return measuredRoute(request, async () => {
    try {
      const { originIpHash } = assertRequestAllowed(request);
      const body = await httpMeasure.measure("Parse vote request", async () => {
        const raw = await request.json();
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new Error("Invalid JSON body");
        return raw as Record<string, unknown>;
      });
      const proposalId = Number(body.proposalId);
      if (!Number.isSafeInteger(proposalId) || proposalId <= 0)
        throw new Error("Invalid proposal id");
      const walletAddress = normalizeSolanaAddress(body.walletAddress);
      const subjectKey = voterKey(body.ownerId ?? body.viewerId, walletAddress);
      const { power } = await httpMeasure.measure(
        {
          start: () => "Resolve vote score",
          end: (score) => score,
        },
        () => walletVotingPower(walletAddress),
      );
      const round = await httpMeasure.measure(
        {
          start: () => `Vote #${proposalId} with weight ${power}`,
          end: (value) => ({ proposals: value?.proposals.length ?? 0 }),
        },
        () =>
          castWebVote({
            proposalId,
            voterKey: subjectKey,
            weight: power,
            walletAddress,
          }),
      );
      if (!round)
        return Response.json({ error: "Could not vote." }, { status: 400 });
      recordSubjectOrigin(subjectKey, originIpHash);
      return Response.json(round);
    } catch (error) {
      return Response.json(
        { error: errorText(error) },
        { status: error instanceof ModerationBlockedError ? 403 : 400 },
      );
    }
  });
}
