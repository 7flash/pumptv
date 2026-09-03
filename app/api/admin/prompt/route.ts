import { db } from "../../../../src/server/db.ts";
import { measuredRoute } from "../../../../src/server/observability.ts";

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

function episodeRow(value: string) {
  const target = value.trim() || "latest";
  if (target.toLowerCase() === "latest")
    return (
      db.raw<any>(`SELECT * FROM clips ORDER BY episode DESC LIMIT 1`)[0] ||
      null
    );

  const displayEpisode = Number(target.replace(/^ep/i, ""));
  if (!Number.isSafeInteger(displayEpisode) || displayEpisode < 1)
    throw new Error("episode must be a positive episode number or 'latest'");
  return (
    db.raw<any>(
      `SELECT * FROM clips WHERE episode = ? LIMIT 1`,
      displayEpisode - 1,
    )[0] || null
  );
}

function artifact(row: any) {
  let storedPlan: Record<string, unknown> | null = null;
  try {
    storedPlan = row.showrunnerPlanJson
      ? JSON.parse(String(row.showrunnerPlanJson))
      : null;
  } catch {}

  const references =
    storedPlan && "_references" in storedPlan
      ? (storedPlan._references ?? null)
      : null;
  const sanitizedH3Plan =
    storedPlan && "_sanitizedH3Plan" in storedPlan
      ? (storedPlan._sanitizedH3Plan ?? null)
      : null;
  const factOverlay =
    storedPlan && "_factOverlay" in storedPlan
      ? (storedPlan._factOverlay ?? null)
      : null;
  const factKeyframe =
    storedPlan && "_factKeyframe" in storedPlan
      ? (storedPlan._factKeyframe ?? null)
      : null;
  const showrunnerPlan = storedPlan
    ? Object.fromEntries(
        Object.entries(storedPlan).filter(
          ([key]) =>
            key !== "_references" &&
            key !== "_sanitizedH3Plan" &&
            key !== "_factOverlay" &&
            key !== "_factKeyframe",
        ),
      )
    : null;

  return {
    episode: Number(row.episode) + 1,
    clipId: Number(row.id),
    directiveId: row.directiveId == null ? null : Number(row.directiveId),
    proposal: String(row.directive || ""),
    references,
    factOverlay,
    factKeyframe,
    showrunner: {
      model: row.showrunnerModel ?? null,
      inputTokens: row.showrunnerInputTokens ?? null,
      outputTokens: row.showrunnerOutputTokens ?? null,
      ms: row.showrunnerMs ?? null,
      plan: showrunnerPlan,
      sanitizedH3Plan,
    },
    h3: {
      prompt: row.h3Prompt ?? null,
      expandedPrompt: row.expandedPrompt ?? null,
      ms: row.h3Ms ?? null,
      inferenceSeconds: row.inferenceSeconds ?? null,
      resolution: row.resolution ?? null,
    },
    generation: {
      mode: row.generationMode ?? null,
      totalMs: row.totalGenerationMs ?? null,
      requestId: row.requestId ?? null,
      videoUrl: row.videoUrl ?? null,
      anchorFrameUrl: row.anchorFrameUrl ?? null,
      startFrameUrl: row.startFrameUrl ?? null,
      endFrameUrl: row.endFrameUrl ?? null,
    },
  };
}

export function GET(request: Request) {
  return measuredRoute(request, async () => {
    const denied = authorize(request);
    if (denied) return denied;
    try {
      const value =
        new URL(request.url).searchParams.get("episode") || "latest";
      const row = episodeRow(value);
      if (!row)
        return Response.json(
          { error: `Episode ${value} not found` },
          { status: 404 },
        );
      return Response.json(artifact(row));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 },
      );
    }
  });
}
