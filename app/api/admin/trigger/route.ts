import {
  errorText,
  httpMeasure,
  measuredRoute,
} from "../../../../src/server/observability.ts";
import {
  getOpenPromptRound,
  triggerPromptRound,
} from "../../../../src/server/repository.ts";

function adminToken(request: Request) {
  const direct = request.headers.get("x-pumptv-admin-token")?.trim();
  if (direct) return direct;
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function authorize(request: Request): Response | null {
  const expected = (process.env.PUMPTV_ADMIN_TOKEN || "").trim();
  if (!expected)
    return Response.json(
      { error: "PUMPTV_ADMIN_TOKEN is not configured." },
      { status: 503 },
    );
  if (adminToken(request) !== expected)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}

function boardPayload(round: Awaited<ReturnType<typeof getOpenPromptRound>>) {
  if (!round)
    return { targetEpisode: null, topProposalId: null, proposals: [] };
  return {
    targetEpisode: round.targetEpisode + 1,
    topProposalId: round.proposals[0]?.id ?? null,
    proposals: round.proposals.map((proposal, index) => ({
      rank: index + 1,
      id: proposal.id,
      score: proposal.voteCount,
      text: proposal.text,
      author: proposal.author,
      authorAddress: proposal.authorAddress,
      ownerScore: proposal.ownerWeight,
      voteScore: proposal.realVoteCount,
      voterCount: proposal.voterCount,
    })),
  };
}

export function GET(request: Request) {
  return measuredRoute(request, async () => {
    const denied = authorize(request);
    if (denied) return denied;
    const round = await httpMeasure.measure(
      {
        start: () => "Load ranked proposal board",
        end: (value) => ({ proposals: value?.proposals.length ?? 0 }),
      },
      () => getOpenPromptRound(),
    );
    return Response.json(boardPayload(round));
  });
}

export function POST(request: Request) {
  return measuredRoute(request, async () => {
    const denied = authorize(request);
    if (denied) return denied;
    try {
      const url = new URL(request.url);
      const body = await httpMeasure.measure(
        "Parse trigger request",
        async () => {
          const rawText = await request.text();
          if (!rawText.trim()) return {} as Record<string, unknown>;
          const parsed = JSON.parse(rawText);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("Invalid JSON body");
          return parsed as Record<string, unknown>;
        },
      );

      const rawProposalId =
        body.proposalId ?? url.searchParams.get("proposalId") ?? null;
      const rawText = String(
        body.text ?? url.searchParams.get("text") ?? "",
      ).trim();
      const proposalId =
        rawProposalId == null || rawProposalId === ""
          ? undefined
          : Number(rawProposalId);
      if (
        proposalId !== undefined &&
        (!Number.isSafeInteger(proposalId) || proposalId <= 0)
      )
        throw new Error("proposalId must be a positive integer");
      if (proposalId !== undefined && rawText)
        throw new Error("Use proposalId or text, not both");

      const before = await httpMeasure.measure("Load trigger candidates", () =>
        getOpenPromptRound(),
      );
      if (!before || !before.proposals.length)
        throw new Error("There are no active proposals to trigger");

      const normalizedText = rawText.replace(/\s+/g, " ").toLowerCase();
      const selected =
        proposalId !== undefined
          ? before.proposals.find((proposal) => proposal.id === proposalId)
          : normalizedText
            ? before.proposals.find(
                (proposal) =>
                  proposal.text.replace(/\s+/g, " ").trim().toLowerCase() ===
                  normalizedText,
              )
            : before.proposals[0];
      if (!selected)
        throw new Error(
          proposalId !== undefined
            ? `Proposal #${proposalId} is not active`
            : `No active proposal exactly matches: ${rawText}`,
        );

      const override = proposalId !== undefined || Boolean(normalizedText);
      const directive = await httpMeasure.measure(
        {
          start: () =>
            override
              ? `Trigger override #${selected.id}`
              : `Trigger highest score #${selected.id}`,
          end: (value) => ({
            directiveId: value?.id ?? null,
            text: value?.text ?? null,
          }),
        },
        () => triggerPromptRound(override ? selected.id : undefined),
      );
      if (!directive) throw new Error("Could not lock a proposal");

      return Response.json(
        {
          ok: true,
          selection: override ? "override" : "highest-score",
          proposal: {
            id: selected.id,
            score: selected.voteCount,
            text: selected.text,
            author: selected.author,
            authorAddress: selected.authorAddress,
          },
          directive,
        },
        { status: 202 },
      );
    } catch (error) {
      const message = errorText(error);
      const conflict =
        /already (queued|generating)|already queued|already generating/i.test(
          message,
        );
      return Response.json(
        { error: message },
        { status: conflict ? 409 : 400 },
      );
    }
  });
}
