import {
  errorText,
  httpMeasure,
  measuredRoute,
} from "../../../src/server/observability.ts";
import {
  getRoomRow,
  normalizeResolution,
  updateRoomSettings,
} from "../../../src/server/repository.ts";

function authorized(request: Request) {
  const expected = (process.env.PUMPTV_ADMIN_TOKEN || "").trim();
  if (!expected) return false;
  return request.headers.get("x-pumptv-admin-token") === expected;
}

export function GET(request: Request) {
  return measuredRoute(request, async () => {
    const room = await httpMeasure.measure("Load room", () => getRoomRow());
    return Response.json({
      name: room.name,
      running: Boolean(room.running),
      resolution: room.resolution,
      workerState: room.workerState,
      lastError: room.lastError ?? null,
    });
  });
}

export function PATCH(request: Request) {
  return measuredRoute(request, async () => {
    if (!authorized(request))
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    try {
      const body = await httpMeasure.measure(
        "Parse room settings",
        async () => {
          const raw = await request.json();
          if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error("Invalid JSON body");
          return raw as Record<string, unknown>;
        },
      );
      const result = await httpMeasure.measure("Update room settings", () =>
        updateRoomSettings({
          running: typeof body.running === "boolean" ? body.running : undefined,
          resolution:
            body.resolution === undefined
              ? undefined
              : normalizeResolution(body.resolution),
        }),
      );
      return Response.json({
        name: result.name,
        running: Boolean(result.running),
        resolution: result.resolution,
        workerState: result.workerState,
        lastError: result.lastError ?? null,
      });
    } catch (error) {
      return Response.json({ error: errorText(error) }, { status: 400 });
    }
  });
}
