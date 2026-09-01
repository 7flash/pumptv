import {
  errorText,
  httpMeasure,
  measuredRoute,
} from "../../../../src/server/observability.ts";
import { getLatestWorldState } from "../../../../src/server/repository.ts";
import { resolveExternalReferences } from "../../../../src/server/reference-tools.ts";

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

function flag(value: unknown) {
  if (value === true || value === 1) return true;
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

async function resolveForRequest(input: {
  text: string;
  refresh?: boolean;
  force?: boolean;
}) {
  const text = input.text.replace(/\s+/g, " ").trim();
  if (!text) throw new Error("text is required");
  if (text.length > 700) throw new Error("text must be 700 characters or less");

  const worldState = await httpMeasure.measure(
    {
      start: () => "Load canon terms for reference preflight",
      end: (state) => ({
        location: state.location,
        characters: state.characters.length,
        props: state.props.length,
      }),
    },
    () => getLatestWorldState(),
  );

  return httpMeasure.measure(
    {
      start: () => `Resolve reference preflight · ${text.slice(0, 72)}`,
      end: (context) => ({
        research: context.decision.research,
        reason: context.decision.reason,
        marketFacts: context.marketFacts.length,
        facts: context.facts.length,
        sources: context.sources.length,
      }),
    },
    () =>
      resolveExternalReferences(text, {
        bypassCache: Boolean(input.refresh),
        forceResearch: Boolean(input.force),
        knownTerms: [
          worldState.location,
          ...worldState.characters.map((character) => character.name),
          ...worldState.props.map((prop) => prop.name),
        ],
      }),
  );
}

export function GET(request: Request) {
  return measuredRoute(request, async () => {
    const denied = authorize(request);
    if (denied) return denied;
    const url = new URL(request.url);
    try {
      const context = await resolveForRequest({
        text: url.searchParams.get("text") || "",
        refresh: flag(url.searchParams.get("refresh")),
        force: flag(url.searchParams.get("force")),
      });
      return Response.json(context);
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
        "Parse reference preflight",
        async () => {
          const parsed = await request.json();
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("Invalid JSON body");
          return parsed as Record<string, unknown>;
        },
      );
      const context = await resolveForRequest({
        text: String(body.text ?? ""),
        refresh: flag(body.refresh),
        force: flag(body.force),
      });
      return Response.json(context);
    } catch (error) {
      return Response.json({ error: errorText(error) }, { status: 400 });
    }
  });
}
