import {
  castProposalVote,
  getOpenPromptRound,
} from "../../../src/server/arbitration.ts";
import { httpMeasure } from "../../../src/server/observability.ts";
import { sanitizeLine } from "../../../src/server/prompt.ts";

function voterKey(value: unknown) {
  const id = sanitizeLine(String(value || ""), 120);
  if (!id) throw new Error("Missing voter id");
  return `web:${id}`;
}

export async function POST(request: Request) {
  const result = await httpMeasure.measure("POST /api/votes", async (m) => {
    const raw = await m("Parse request", () => request.json());
    if (!raw || typeof raw !== "object") throw new Error("Invalid JSON body");
    const body = raw as Record<string, unknown>;
    const proposalId = Number(body.proposalId);
    if (!Number.isSafeInteger(proposalId) || proposalId <= 0)
      throw new Error("Invalid proposal id");

    const round = await getOpenPromptRound();
    if (!round) throw new Error("There is no open prompt round");

    return castProposalVote({
      roundId: round.id,
      proposalId,
      voterKey: voterKey(body.voterId),
      source: "web",
    });
  });

  if (!result)
    return Response.json({ error: "Could not cast vote." }, { status: 400 });
  return Response.json(result);
}
