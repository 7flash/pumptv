import { generateNextClip } from "../../../src/server/generate.ts";
import { httpMeasure } from "../../../src/server/observability.ts";
import { normalizeResolution } from "../../../src/server/repository.ts";

export async function POST(request: Request) {
  const result = await httpMeasure.measure("POST /api/generate", async (m) => {
    const raw = await m("Parse request", () => request.json());
    if (!raw || typeof raw !== "object") throw new Error("Invalid JSON body");

    const body = raw as Record<string, unknown>;
    const imageDataUrl =
      typeof body.imageDataUrl === "string" &&
      body.imageDataUrl.startsWith("data:image/")
        ? body.imageDataUrl
        : null;

    if (imageDataUrl && imageDataUrl.length > 4_000_000) {
      throw new Error("Continuity frame is too large");
    }

    return generateNextClip({
      imageDataUrl,
      resolution: normalizeResolution(body.resolution),
    });
  });

  if (!result)
    return Response.json({ error: "Generation failed." }, { status: 500 });
  return Response.json(result);
}
