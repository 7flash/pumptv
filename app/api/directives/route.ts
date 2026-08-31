import { httpMeasure } from "../../../src/server/observability.ts";
import { sanitizeLine } from "../../../src/server/prompt.ts";
import { enqueueDirective } from "../../../src/server/repository.ts";

export async function POST(request: Request) {
  const result = await httpMeasure.measure(
    "POST /api/directives",
    async (m) => {
      const raw = await m("Parse request", () => request.json());
      if (!raw || typeof raw !== "object") throw new Error("Invalid JSON body");

      const text = sanitizeLine(String((raw as any).text || ""), 500);
      if (!text) throw new Error("Directive cannot be empty");

      const row = await enqueueDirective(text);
      if (!row) throw new Error("Could not queue directive");
      return {
        id: row.id,
        text: row.text,
        status: row.status,
        usedEpisode: row.usedEpisode ?? null,
      };
    },
  );

  if (!result)
    return Response.json(
      { error: "Could not queue directive." },
      { status: 400 },
    );
  return Response.json(result, { status: 201 });
}
