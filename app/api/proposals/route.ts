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
  cancelWebProposal,
  DecisionWindowClosedError,
  upsertWebProposal,
} from "../../../src/server/repository.ts";
import {
  normalizeSolanaAddress,
  walletVotingPower,
} from "../../../src/server/wallet-score.ts";
import { participationCohortKey } from "../../../src/server/participant-identity.ts";

function anonymousKey(value: unknown) {
  const id = sanitizeLine(String(value || ""), 180);
  if (!id) throw new Error("Missing proposal owner id");
  return `web:${id}`;
}

function ownerKey(value: unknown, walletAddress: string | null) {
  return walletAddress ? `wallet:${walletAddress}` : anonymousKey(value);
}

export function POST(request: Request) {
  return measuredRoute(request, async () => {
    let participationSlot: number | null = null;
    try {
      const { originIpHash } = assertRequestAllowed(request);
      const body = await httpMeasure.measure(
        {
          start: () => "Parse proposal request",
          end: () => "ok",
        },
        async () => {
          const raw = await request.json();
          if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error("Invalid JSON body");
          return raw as Record<string, unknown>;
        },
      );

      const text = sanitizeLine(String(body.text || ""), 500);
      if (!text) throw new Error("Idea cannot be empty");
      const identity = body.ownerId ?? body.viewerId;
      const walletAddress = normalizeSolanaAddress(body.walletAddress);
      const subjectKey = ownerKey(identity, walletAddress);
      participationSlot = claimParticipationSlot({
        originIpHash,
        subjectKey,
        kind: "proposal",
      });
      const { power } = await httpMeasure.measure(
        {
          start: () => "Resolve proposal score",
          end: (score) => score,
        },
        () => walletVotingPower(walletAddress),
      );

      const proposal = await httpMeasure.measure(
        {
          start: () => "Save persistent proposal",
          end: (saved) =>
            saved
              ? { id: saved.id, score: saved.voteCount, text: saved.text }
              : null,
        },
        () =>
          upsertWebProposal({
            text,
            ownerKey: subjectKey,
            walletAddress,
            ownerWeight: power,
            participantKey: participationCohortKey({
              originIpHash,
              walletAddress,
              subjectKey,
            }),
          }),
      );

      if (!proposal) {
        releaseParticipationSlot(participationSlot);
        participationSlot = null;
        return Response.json(
          { error: "Could not save idea." },
          { status: 400 },
        );
      }
      recordSubjectOrigin(subjectKey, originIpHash);
      return Response.json(proposal, { status: 201 });
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

export function DELETE(request: Request) {
  return measuredRoute(request, async () => {
    try {
      const body = await httpMeasure.measure(
        "Parse proposal delete",
        async () => {
          const raw = await request.json();
          if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error("Invalid JSON body");
          return raw as Record<string, unknown>;
        },
      );
      const walletAddress = normalizeSolanaAddress(body.walletAddress);
      const identity = body.ownerId ?? body.viewerId;
      const removed = await httpMeasure.measure(
        "Cancel persistent proposal",
        () => cancelWebProposal(ownerKey(identity, walletAddress)),
      );
      return Response.json({ ok: true, removed: Boolean(removed) });
    } catch (error) {
      return Response.json({ error: errorText(error) }, { status: 400 });
    }
  });
}
