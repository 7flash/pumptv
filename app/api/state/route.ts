import { httpMeasure } from "../../../src/server/observability.ts";
import { getRuntimeStreamState } from "../../../src/server/runtime-state.ts";

export async function GET() {
  const state = await httpMeasure.measure("GET /api/state", () =>
    getRuntimeStreamState(),
  );
  if (!state)
    return Response.json(
      { error: "Could not load stream state." },
      { status: 500 },
    );
  return Response.json(state);
}
