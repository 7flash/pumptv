import { measuredRoute } from "../../../src/server/observability.ts";

// Direct rendering used to bypass the proposal/trigger gate. Keep the old URL
// explicit but inert so no stale client can accidentally start generation.
export function POST(request: Request) {
  return measuredRoute(request, () =>
    Response.json(
      {
        error: "Direct generation is disabled. Use POST /api/admin/trigger.",
      },
      { status: 410 },
    ),
  );
}
