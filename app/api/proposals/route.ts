import { httpMeasure } from "../../../src/server/observability.ts";
import { sanitizeLine } from "../../../src/server/prompt.ts";
import { submitPumpfunProposal } from "../../../src/server/repository.ts";

function walletAddress(value: unknown) {
  const address = sanitizeLine(String(value || ""), 64);
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))
    throw new Error("Connect a valid Solana wallet");
  return address;
}

export async function POST(request: Request) {
  const result = await httpMeasure.measure("POST /api/proposals", async (m) => {
    const raw = await m("Parse request", () => request.json());
    if (!raw || typeof raw !== "object") throw new Error("Invalid JSON body");
    const body = raw as Record<string, unknown>;
    const text = sanitizeLine(String(body.text || ""), 500);
    if (!text) throw new Error("Idea cannot be empty");
    const address = walletAddress(body.walletAddress);
    const sourceId = `web:${address}:${crypto.randomUUID()}`;

    return submitPumpfunProposal({
      text,
      sourceId,
      author: null,
      authorAddress: address,
      sourceRoom: "web",
      voterKey: `wallet:${address}`,
      voterHandle: null,
      source: "web",
    });
  });

  if (!result)
    return Response.json({ error: "Could not submit idea." }, { status: 400 });
  return Response.json(result, { status: 201 });
}
