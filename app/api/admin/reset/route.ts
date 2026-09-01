import {
  errorText,
  httpMeasure,
  measuredRoute,
} from "../../../../src/server/observability.ts";
import {
  currentMaxEpisode,
  previewResetRoom,
  resetRoomFromEpisode,
} from "../../../../src/server/reset-room.ts";

function adminToken(request: Request) {
  const direct = request.headers.get("x-pumptv-admin-token")?.trim();
  if (direct) return direct;
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function authorize(request: Request): Response | null {
  const expected = (process.env.PUMPTV_ADMIN_TOKEN || "").trim();
  if (!expected)
    return Response.json(
      { error: "PUMPTV_ADMIN_TOKEN is not configured." },
      { status: 503 },
    );
  if (adminToken(request) !== expected)
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}

function bool(value: unknown) {
  return value === true || value === 1 || value === "1" || value === "true";
}

export function GET(request: Request) {
  return measuredRoute(request, async () => {
    const denied = authorize(request);
    if (denied) return denied;
    try {
      const url = new URL(request.url);
      const fromEpisode = url.searchParams.get("fromEpisode");
      if (!fromEpisode)
        return Response.json({
          readOnly: true,
          method: "POST",
          maxEpisode: currentMaxEpisode(),
          hint: "Pass ?fromEpisode=N to preview a reset.",
        });
      const preview = await httpMeasure.measure("Preview episode reset", () =>
        previewResetRoom(fromEpisode, bool(url.searchParams.get("requeue"))),
      );
      return Response.json({ readOnly: true, ...preview });
    } catch (error) {
      return Response.json({ error: errorText(error) }, { status: 400 });
    }
  });
}

export function POST(request: Request) {
  return measuredRoute(request, async () => {
    const denied = authorize(request);
    if (denied) return denied;
    try {
      const body = await httpMeasure.measure(
        "Parse reset request",
        async () => {
          const raw = await request.json();
          if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error("Invalid JSON body");
          return raw as Record<string, unknown>;
        },
      );
      if (!bool(body.confirm))
        throw new Error("confirm=true is required for a destructive reset");
      const result = await httpMeasure.measure("Apply episode reset", () =>
        resetRoomFromEpisode({
          fromEpisode: Number(body.fromEpisode),
          requeue: bool(body.requeue),
        }),
      );
      return Response.json({ ok: true, ...result });
    } catch (error) {
      const message = errorText(error);
      return Response.json(
        { error: message },
        { status: /generation is active/i.test(message) ? 409 : 400 },
      );
    }
  });
}
