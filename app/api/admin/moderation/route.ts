import {
  errorText,
  httpMeasure,
  measuredRoute,
} from "../../../../src/server/observability.ts";
import {
  banIp,
  banProposalIp,
  listBans,
  removeProposalById,
  unbanById,
} from "../../../../src/server/moderation.ts";

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

function positiveId(value: unknown, label: string) {
  const id = Number(String(value ?? "").replace(/^#/, ""));
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error(`${label} must be a positive integer`);
  return id;
}

export function GET(request: Request) {
  return measuredRoute(request, async () => {
    const denied = authorize(request);
    if (denied) return denied;
    return Response.json({ bans: listBans() });
  });
}

export function POST(request: Request) {
  return measuredRoute(request, async () => {
    const denied = authorize(request);
    if (denied) return denied;
    try {
      const body = await httpMeasure.measure(
        "Parse moderation request",
        async () => {
          const raw = await request.json();
          if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error("Invalid JSON body");
          return raw as Record<string, unknown>;
        },
      );
      const action = String(body.action || "")
        .trim()
        .toLowerCase();
      const reason =
        String(body.reason || "")
          .trim()
          .slice(0, 300) || null;

      if (action === "remove")
        return Response.json({
          ok: true,
          action,
          ...removeProposalById(positiveId(body.proposalId, "proposalId")),
        });
      if (action === "ban-proposal")
        return Response.json({
          ok: true,
          action,
          ...banProposalIp(positiveId(body.proposalId, "proposalId"), reason),
        });
      if (action === "ban-ip") {
        const ip = String(body.ip || "").trim();
        if (!ip) throw new Error("ip is required");
        return Response.json({ ok: true, action, ...banIp(ip, reason) });
      }
      if (action === "unban")
        return Response.json({
          ok: true,
          action,
          ...unbanById(positiveId(body.banId, "banId")),
        });
      throw new Error("action must be remove, ban-proposal, ban-ip, or unban");
    } catch (error) {
      return Response.json({ error: errorText(error) }, { status: 400 });
    }
  });
}
