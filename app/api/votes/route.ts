import { httpMeasure } from "../../../src/server/observability.ts";
import { sanitizeLine } from "../../../src/server/prompt.ts";
import { castWebVote } from "../../../src/server/repository.ts";
import {
  normalizeSolanaAddress,
  walletVotingPower,
} from "../../../src/server/wallet-score.ts";

function voterKey(value: unknown) {
  const id = sanitizeLine(String(value || ""), 160);
  if (!id) throw new Error("Missing viewer id");
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
    const walletAddress = normalizeSolanaAddress(body.walletAddress);
    const { power } = await walletVotingPower(walletAddress);

    return castWebVote({
      proposalId,
      voterKey: voterKey(body.viewerId),
      weight: power,
      walletAddress,
    });
  });

  if (!result)
    return Response.json({ error: "Could not vote." }, { status: 400 });
  return Response.json(result);
}
