import { httpMeasure } from "../../../src/server/observability.ts";
import { getStreamState } from "../../../src/server/repository.ts";

export async function GET() {
  const state = await httpMeasure.measure("GET /api/state", () =>
    getStreamState(),
  );
  if (!state)
    return Response.json(
      { error: "Could not load stream state." },
      { status: 500 },
    );
  return Response.json(state);
}
