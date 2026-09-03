import {
  errorText,
  httpMeasure,
  measuredRoute,
} from "../../../src/server/observability.ts";
import { sanitizeLine } from "../../../src/server/prompt.ts";
import {
  assertRequestAllowed,
  claimParticipationSlot,
  ModerationBlockedError,
  ParticipationCooldownError,
  recordSubjectOrigin,
  releaseParticipationSlot,
} from "../../../src/server/moderation.ts";
import {
  castWebVote,
  DecisionWindowClosedError,
} from "../../../src/server/repository.ts";
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

function participantKey(
  originIpHash: string | null,
  walletAddress: string | null,
  subjectKey: string,
) {
  return originIpHash
    ? `ip:${originIpHash}`
    : walletAddress
      ? `wallet:${walletAddress}`
      : subjectKey;
}

export function POST(request: Request) {
  return measuredRoute(request, async () => {
    let participationSlot: number | null = null;
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
      participationSlot = claimParticipationSlot({
        originIpHash,
        subjectKey,
        kind: "vote",
      });
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
            participantKey: participantKey(
              originIpHash,
              walletAddress,
              subjectKey,
            ),
          }),
      );
      if (!round) {
        releaseParticipationSlot(participationSlot);
        participationSlot = null;
        return Response.json({ error: "Could not vote." }, { status: 400 });
      }
      recordSubjectOrigin(subjectKey, originIpHash);
      return Response.json(round);
    } catch (error) {
      releaseParticipationSlot(participationSlot);
      return Response.json(
        {
          error: errorText(error),
          ...(error instanceof ParticipationCooldownError
            ? { retryAfterMs: error.retryAfterMs }
            : {}),
        },
        {
          status:
            error instanceof ModerationBlockedError
              ? 403
              : error instanceof ParticipationCooldownError
                ? 429
                : error instanceof DecisionWindowClosedError
                  ? 409
                  : 400,
        },
      );
    }
  });
}
