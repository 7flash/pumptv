import { httpMeasure } from "../../../src/server/observability.ts";
import {
  getRoomRow,
  normalizeResolution,
  updateRoomSettings,
} from "../../../src/server/repository.ts";

function authorized(request: Request) {
  const expected = process.env.PUMPTV_ADMIN_TOKEN;
  if (!expected) return true;
  return request.headers.get("x-pumptv-admin-token") === expected;
}

export async function GET() {
  const room = await httpMeasure.measure("GET /api/room", () => getRoomRow());
  if (!room)
    return Response.json({ error: "Could not load room." }, { status: 500 });
  return Response.json({
    name: room.name,
    running: Boolean(room.running),
    resolution: room.resolution,
    workerState: room.workerState,
    lastError: room.lastError ?? null,
  });
}

export async function PATCH(request: Request) {
  if (!authorized(request))
    return Response.json({ error: "Unauthorized" }, { status: 401 });

  const result = await httpMeasure.measure("PATCH /api/room", async (m) => {
    const raw = await m("Parse request", () => request.json());
    if (!raw || typeof raw !== "object") throw new Error("Invalid JSON body");
    const body = raw as Record<string, unknown>;

    return updateRoomSettings({
      running: typeof body.running === "boolean" ? body.running : undefined,
      resolution:
        body.resolution === undefined
          ? undefined
          : normalizeResolution(body.resolution),
    });
  });

  if (!result)
    return Response.json({ error: "Could not update room." }, { status: 400 });
  return Response.json({
    name: result.name,
    running: Boolean(result.running),
    resolution: result.resolution,
    workerState: result.workerState,
    lastError: result.lastError ?? null,
  });
}
