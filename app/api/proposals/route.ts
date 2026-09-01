import { httpMeasure } from "../../../src/server/observability.ts";
import { sanitizeLine } from "../../../src/server/prompt.ts";
import {
  cancelWebProposal,
  upsertWebProposal,
} from "../../../src/server/repository.ts";
import {
  normalizeSolanaAddress,
  walletVotingPower,
} from "../../../src/server/wallet-score.ts";

function ownerKey(value: unknown) {
  const id = sanitizeLine(String(value || ""), 160);
  if (!id) throw new Error("Missing viewer id");
  return `web:${id}`;
}

export async function POST(request: Request) {
  const result = await httpMeasure.measure("POST /api/proposals", async (m) => {
    const raw = await m("Parse request", () => request.json());
    if (!raw || typeof raw !== "object") throw new Error("Invalid JSON body");
    const body = raw as Record<string, unknown>;
    const text = sanitizeLine(String(body.text || ""), 500);
    if (!text) throw new Error("Idea cannot be empty");
    const walletAddress = normalizeSolanaAddress(body.walletAddress);
    const { power } = await walletVotingPower(walletAddress);

    return upsertWebProposal({
      text,
      ownerKey: ownerKey(body.viewerId),
      walletAddress,
      ownerWeight: power,
    });
  });

  if (!result)
    return Response.json({ error: "Could not save idea." }, { status: 400 });
  return Response.json(result, { status: 201 });
}

export async function DELETE(request: Request) {
  const result = await httpMeasure.measure(
    "DELETE /api/proposals",
    async (m) => {
      const raw = await m("Parse request", () => request.json());
      if (!raw || typeof raw !== "object") throw new Error("Invalid JSON body");
      const body = raw as Record<string, unknown>;
      return cancelWebProposal(ownerKey(body.viewerId));
    },
  );

  if (result == null)
    return Response.json({ error: "Could not cancel idea." }, { status: 400 });
  return Response.json({ ok: true, removed: Boolean(result) });
}
