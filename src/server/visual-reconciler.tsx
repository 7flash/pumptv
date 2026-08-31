/** @jsxImportSource jsx-ai */
import { fal } from "@fal-ai/client";
import { render } from "jsx-ai";
import { z } from "sqlite-zod-orm";
import type { ShotPlan } from "./prompt.ts";
import type { WorldState, WorldStateAudit } from "../shared/contracts.ts";
import { reconcileMeasure } from "./observability.ts";
import {
  WorldStateSchema,
  normalizeReconciledWorldState,
  worldStateForShowrunner,
} from "./world-state.ts";
import type { ClipFrameSample } from "./video-frames.ts";

const ENABLED = process.env.SLOP_RECONCILE_VISION !== "0";
const MODEL = process.env.SLOP_RECONCILER_MODEL || "google/gemini-2.5-flash";

const ReconciliationSchema = z.object({
  status: z.enum(["verified", "corrected"]),
  summary: z.string(),
  drift: z.array(z.string()),
  removedCharacterIds: z.array(z.string()),
  removedPropIds: z.array(z.string()),
  resolvedThreads: z.array(z.string()),
  worldState: WorldStateSchema,
});

type ParsedReconciliation = {
  status: "verified" | "corrected";
  summary: string;
  drift: string[];
  removedCharacterIds: string[];
  removedPropIds: string[];
  resolvedThreads: string[];
  worldState: WorldState;
};

export type VisualReconciliationResult = {
  worldState: WorldState;
  audit: Omit<WorldStateAudit, "episode">;
};

function ReconciliationPrompt(input: {
  directive: string;
  plan: ShotPlan;
  priorWorldState: WorldState;
  plannedWorldState: WorldState;
  frameLabels: string[];
}) {
  return (
    <>
      <system>{`You are the reality reconciler for an endless AI-generated video stream.
The showrunner planned a five-second shot and proposed the world state after that shot. You are inspecting actual sampled frames from the rendered video.

Your job is NOT to rewrite the story creatively. Your job is to reconcile durable canon with visible reality.

Rules:
- The supplied images are ground truth for facts that are visibly testable.
- Images are supplied in chronological order and their labels are given in the user message.
- Preserve planned/off-screen durable facts unless the rendered frames visibly contradict them or visibly establish that they changed.
- Never delete an established character or prop merely because it is temporarily off-camera. Put deliberate removals in removedCharacterIds / removedPropIds.
- Never resolve a plot thread merely because it is not visible. Put genuinely resolved threads in resolvedThreads.
- Correct identity drift, wardrobe drift, location drift, prop drift, spatial drift, and the actual final-frame state when the images contradict the plan.
- Keep stable IDs from the planned state whenever an entity is clearly the same entity.
- lastEndingBeat MUST describe the actual final sampled frame, not the intended ending.
- Use status "verified" only when there is no material canon mismatch. Use "corrected" when you changed any material visible fact.
- Return ONLY one strict JSON object, no markdown fences and no prose before or after it.

JSON shape:
{"status":"verified|corrected","summary":"short reality-check summary","drift":["material mismatch"],"removedCharacterIds":["id"],"removedPropIds":["id"],"resolvedThreads":["exact or close thread text"],"worldState":{"revision":number,"location":string,"locationDetails":string,"characters":[{"id":string,"name":string,"appearance":string,"wardrobe":string,"status":string,"position":string}],"props":[{"id":string,"name":string,"description":string,"status":string,"position":string}],"openThreads":string[],"motifs":string[],"visualRules":string[],"lastEndingBeat":string}}`}</system>
      <message role="user">{`FRAME ORDER: ${input.frameLabels.join(" → ")}

AUDIENCE DIRECTIVE:
${input.directive}

PLANNED SHOT:
${JSON.stringify(input.plan, null, 2)}

CANON BEFORE SHOT:
${worldStateForShowrunner(input.priorWorldState)}

SHOWRUNNER'S PROPOSED CANON AFTER SHOT:
${worldStateForShowrunner(input.plannedWorldState)}

Inspect the actual frames, reconcile only what reality requires, and emit the complete corrected canon JSON.`}</message>
    </>
  );
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map(messageText).filter(Boolean).join("\n");
  if (value && typeof value === "object" && "text" in value)
    return String((value as any).text || "");
  return String(value || "");
}

function extractJsonObject(text: string) {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first < 0 || last <= first)
    throw new Error("Vision reconciler returned no JSON object");
  return JSON.parse(trimmed.slice(first, last + 1));
}

function norm(value: string) {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function mergeById<T extends { id: string }>(
  planned: T[],
  observed: T[],
  removedIds: string[],
) {
  const removed = new Set(removedIds.map(norm));
  const observedIds = new Set(observed.map((item) => norm(item.id)));
  return [
    ...observed.filter((item) => !removed.has(norm(item.id))),
    ...planned.filter(
      (item) => !observedIds.has(norm(item.id)) && !removed.has(norm(item.id)),
    ),
  ];
}

function unionStrings(...lists: string[][]) {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const list of lists) {
    for (const item of list) {
      const key = norm(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      values.push(item);
    }
  }
  return values;
}

function reconcileState(parsed: ParsedReconciliation, planned: WorldState) {
  const observed = normalizeReconciledWorldState(parsed.worldState, planned);
  const resolved = parsed.resolvedThreads.map(norm);
  const remainingPlannedThreads = planned.openThreads.filter(
    (thread) =>
      !resolved.some(
        (done) =>
          done === norm(thread) ||
          norm(thread).includes(done) ||
          done.includes(norm(thread)),
      ),
  );

  const merged: WorldState = {
    ...observed,
    revision: planned.revision,
    characters: mergeById(
      planned.characters,
      observed.characters,
      parsed.removedCharacterIds,
    ),
    props: mergeById(planned.props, observed.props, parsed.removedPropIds),
    openThreads: unionStrings(
      remainingPlannedThreads,
      observed.openThreads,
    ).slice(0, 8),
    motifs: unionStrings(planned.motifs, observed.motifs).slice(0, 8),
    visualRules: unionStrings(planned.visualRules, observed.visualRules).slice(
      0,
      10,
    ),
  };

  return normalizeReconciledWorldState(merged, planned);
}

export async function reconcileRenderedClip(input: {
  episode: number;
  directive: string;
  plan: ShotPlan;
  priorWorldState: WorldState;
  plannedWorldState: WorldState;
  frames: ClipFrameSample;
  skipReason?: string | null;
}): Promise<VisualReconciliationResult> {
  const frameEntries = [
    ["START", input.frames.start],
    ["MIDDLE", input.frames.middle],
    ["END", input.frames.end],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  const baseAudit = {
    model: MODEL,
    summary: null,
    drift: [] as string[],
    sampledFrameUrls: frameEntries.map(([, url]) => url),
    inputTokens: null as number | null,
    outputTokens: null as number | null,
    cost: null as number | null,
  };

  if (input.skipReason) {
    return {
      worldState: input.plannedWorldState,
      audit: {
        ...baseAudit,
        status: "skipped",
        model: null,
        summary: input.skipReason,
      },
    };
  }

  if (!ENABLED) {
    return {
      worldState: input.plannedWorldState,
      audit: {
        ...baseAudit,
        status: "skipped",
        model: null,
        summary: "Visual reconciliation disabled.",
      },
    };
  }

  // A known anchor alone tells us nothing about what this newly rendered clip actually did.
  if (!input.frames.middle && !input.frames.end) {
    return {
      worldState: input.plannedWorldState,
      audit: {
        ...baseAudit,
        status: "fallback",
        summary:
          "No rendered middle/end frame was available for reality reconciliation.",
      },
    };
  }

  try {
    const tree = render(
      <ReconciliationPrompt
        directive={input.directive}
        plan={input.plan}
        priorWorldState={input.priorWorldState}
        plannedWorldState={input.plannedWorldState}
        frameLabels={frameEntries.map(([label]) => label)}
      />,
    );
    const prompt = tree.messages
      .map((message: any) => messageText(message.content))
      .filter(Boolean)
      .join("\n\n");

    const result = await reconcileMeasure.measure(
      {
        label: "Reconcile rendered canon",
        episode: input.episode,
        model: MODEL,
      },
      () =>
        fal.subscribe("openrouter/router/vision", {
          input: {
            image_urls: frameEntries.map(([, url]) => url),
            prompt,
            system_prompt: tree.system || undefined,
            model: MODEL,
            temperature: 0.1,
            max_tokens: 1800,
            reasoning: false,
          },
          logs: false,
        }),
    );
    if (!result) throw new Error("Vision reconciler returned no result");

    const data = result.data as {
      output?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        cost?: number;
      };
    };
    if (!data.output) throw new Error("Vision reconciler returned no output");

    const parsed = ReconciliationSchema.parse(
      extractJsonObject(data.output),
    ) as ParsedReconciliation;
    const worldState = reconcileState(parsed, input.plannedWorldState);
    const corrected = parsed.status === "corrected" || parsed.drift.length > 0;

    return {
      worldState,
      audit: {
        status: corrected ? "corrected" : "verified",
        model: MODEL,
        summary: parsed.summary.replace(/\s+/g, " ").trim().slice(0, 500),
        drift: parsed.drift
          .map((item) => item.replace(/\s+/g, " ").trim().slice(0, 320))
          .filter(Boolean)
          .slice(0, 8),
        sampledFrameUrls: frameEntries.map(([, url]) => url),
        inputTokens: data.usage?.prompt_tokens ?? null,
        outputTokens: data.usage?.completion_tokens ?? null,
        cost: data.usage?.cost ?? null,
      },
    };
  } catch (error) {
    console.error(
      "[reconciler] using planned canon after vision failure",
      error,
    );
    return {
      worldState: input.plannedWorldState,
      audit: {
        ...baseAudit,
        status: "fallback",
        summary:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Visual reconciliation failed.",
      },
    };
  }
}
