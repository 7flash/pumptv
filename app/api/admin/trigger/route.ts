import {
  errorText,
  httpMeasure,
  measuredRoute,
} from "../../../../src/server/observability.ts";
import {
  getOpenPromptRound,
  triggerNextProposal,
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
    return Response.json({
      ...boardPayload(round),
      readOnly: true,
      trigger: {
        method: "POST",
        default: "highest-score",
        override: "proposalId or exact text",
      },
    });
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

      const result = await httpMeasure.measure(
        {
          start: () =>
            proposalId !== undefined
              ? `Trigger override #${proposalId}`
              : rawText
                ? "Trigger override by exact text"
                : "Trigger highest score",
          end: (value) => ({
            proposalId: value.proposal.id,
            rank: value.rank,
            score: value.score,
            directiveId: value.directive.id,
            text: value.proposal.text.slice(0, 100),
          }),
        },
        () =>
          triggerNextProposal({
            proposalId,
            text: rawText || undefined,
            actor: "api",
          }),
      );

      return Response.json(
        {
          ok: true,
          selection:
            proposalId !== undefined || rawText ? "override" : "highest-score",
          proposal: {
            id: result.proposal.id,
            rank: result.rank,
            score: result.score,
            text: result.proposal.text,
            author: result.proposal.author,
            authorAddress: result.proposal.authorAddress,
          },
          directive: result.directive,
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
