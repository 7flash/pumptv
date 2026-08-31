import {
  ensurePromptRound,
  submitPromptProposal,
} from "../../../src/server/arbitration.ts";
import { httpMeasure } from "../../../src/server/observability.ts";
import { sanitizeLine } from "../../../src/server/prompt.ts";
import { getLatestClip } from "../../../src/server/repository.ts";

function voterKey(value: unknown) {
  const id = sanitizeLine(String(value || ""), 120);
  if (!id) throw new Error("Missing voter id");
  return `web:${id}`;
}

export async function POST(request: Request) {
  const result = await httpMeasure.measure("POST /api/proposals", async (m) => {
    const raw = await m("Parse request", () => request.json());
    if (!raw || typeof raw !== "object") throw new Error("Invalid JSON body");
    const body = raw as Record<string, unknown>;

    const text = sanitizeLine(String(body.text || ""), 500);
    if (!text) throw new Error("Proposal cannot be empty");

    const latest = await getLatestClip();
    if (!latest)
      throw new Error("The opening clip is still booting; try the next ballot");

    const round = await ensurePromptRound(
      latest.episode + 1,
      latest.startsAtMs + latest.durationSeconds * 1000,
    );

    return submitPromptProposal({
      roundId: round.id,
      text,
      source: "web",
      voterKey: voterKey(body.voterId),
    });
  });

  if (!result)
    return Response.json(
      { error: "Could not submit proposal." },
      { status: 400 },
    );
  return Response.json(result, { status: 201 });
}
