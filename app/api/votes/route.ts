import { httpMeasure } from "../../../src/server/observability.ts";
import { sanitizeLine } from "../../../src/server/prompt.ts";
import { castPumpfunVote } from "../../../src/server/repository.ts";

function walletAddress(value: unknown) {
  const address = sanitizeLine(String(value || ""), 64);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
    throw new Error("Connect a valid Solana wallet");
  return address;
}

export async function POST(request: Request) {
  const result = await httpMeasure.measure("POST /api/votes", async (m) => {
    const raw = await m("Parse request", () => request.json());
    if (!raw || typeof raw !== "object") throw new Error("Invalid JSON body");
    const body = raw as Record<string, unknown>;
    const proposalId = Number(body.proposalId);
    if (!Number.isSafeInteger(proposalId) || proposalId <= 0)
      throw new Error("Invalid proposal id");
    const address = walletAddress(body.walletAddress);

    return castPumpfunVote({
      proposalId,
      voterKey: `wallet:${address}`,
      voterHandle: null,
      sourceId: `web-vote:${address}:${crypto.randomUUID()}`,
      source: "web",
    });
  });

  if (!result)
    return Response.json({ error: "Could not vote." }, { status: 400 });
  return Response.json(result);
}
