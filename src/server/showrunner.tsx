/** @jsxImportSource jsx-ai */
import { callLLM } from "jsx-ai";
import { z } from "sqlite-zod-orm";
import { showrunnerMeasure } from "./observability.ts";
import { sanitizeLine, type ShotPlan } from "./prompt.ts";
import type {
  GenerationMode,
  WorldCharacter,
  WorldProp,
  WorldState,
} from "../shared/contracts.ts";
import { EMPTY_WORLD_STATE, normalizeWorldState } from "./world-state.ts";
import { PumpTVShowrunnerPrompt } from "./showrunner-prompt.tsx";
import type { ReferenceContext } from "./reference-tools.ts";

const MODEL = process.env.JSX_AI_MODEL || "runtime-default";

export type ShowrunnerResult = {
  plan: ShotPlan;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  nextWorldState: WorldState;
  referenceContext?: ReferenceContext;
};

const StageShotArgs = z.object({
  premise: z.string(),
  transition: z.string(),
  action: z.string(),
  continuity: z.string(),
  camera: z.string(),
  visual_details: z.string(),
  audio: z.string(),
  dialogue: z.string().optional(),
  ending_beat: z.string(),
});

const SetLocationArgs = z.object({ location: z.string(), details: z.string() });
const UpsertCharacterArgs = z.object({
  id: z.string(),
  name: z.string(),
  appearance: z.string(),
  wardrobe: z.string(),
  status: z.string(),
  position: z.string(),
});
const UpsertPropArgs = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.string(),
  position: z.string(),
});
const ThreadArgs = z.object({ thread: z.string() });
const MotifArgs = z.object({ motif: z.string() });
const VisualRuleArgs = z.object({ rule: z.string() });

type ToolCall = { name: string; args: Record<string, unknown> };

function clean(value: unknown, max: number) {
  return sanitizeLine(String(value ?? ""), max);
}

function deterministicEmergencyPlan(input: {
  directive: string;
  recentStory: string[];
  hasAnchor: boolean;
}): ShotPlan {
  const last = input.recentStory.at(-1) || "the established scene";
  return {
    premise: clean(input.directive, 500),
    action: `Continue directly from ${clean(last, 300)} and make the selected viewer idea happen through one clear physical action.`,
    transition:
      "Continue the exact visible pose, motion, eyelines and spatial relationships first, then introduce the new idea causally inside the same scene.",
    continuity: input.hasAnchor
      ? "Treat the anchor as exact visual truth; preserve identities, wardrobe, props, lighting and geography."
      : "Establish one stable protagonist and location for later continuation.",
    camera: "One coherent cinematic setup with restrained motivated movement.",
    visualDetails:
      "Readable foreground action, stable identities, grounded environmental motion.",
    audio: "Synchronized ambience and motivated foley.",
    dialogue: "",
    endingBeat:
      "End mid-consequence on a clear active state that can continue immediately.",
  };
}

function findById<T extends { id: string }>(items: T[], id: string) {
  return items.findIndex((item) => item.id === id);
}

function addUnique(list: string[], value: string, maxItems: number) {
  const normalized = clean(value, 260);
  if (!normalized) return list;
  if (list.some((item) => item.toLowerCase() === normalized.toLowerCase()))
    return list;
  return [...list, normalized].slice(-maxItems);
}

function resolveThread(list: string[], query: string) {
  const needle = clean(query, 260).toLowerCase();
  if (!needle) return list;
  return list.filter((item) => {
    const hay = item.toLowerCase();
    return !(hay === needle || hay.includes(needle) || needle.includes(hay));
  });
}

function applyCanonToolCalls(
  previous: WorldState,
  calls: ToolCall[],
  endingBeat: string,
): WorldState {
  const draft: WorldState = {
    ...previous,
    characters: previous.characters.map((item) => ({ ...item })),
    props: previous.props.map((item) => ({ ...item })),
    openThreads: [...previous.openThreads],
    motifs: [...previous.motifs],
    visualRules: [...previous.visualRules],
    lastEndingBeat: clean(endingBeat, 500) || previous.lastEndingBeat,
  };

  for (const call of calls) {
    if (call.name === "set_location") {
      const parsed = SetLocationArgs.safeParse(call.args);
      if (!parsed.success)
        throw new Error(
          `Invalid set_location tool call: ${String(parsed.error).slice(0, 500)}`,
        );
      draft.location = clean(parsed.data.location, 120) || draft.location;
      draft.locationDetails =
        clean(parsed.data.details, 500) || draft.locationDetails;
      continue;
    }

    if (call.name === "upsert_character") {
      const parsed = UpsertCharacterArgs.safeParse(call.args);
      if (!parsed.success)
        throw new Error(
          `Invalid upsert_character tool call: ${String(parsed.error).slice(0, 500)}`,
        );
      const character: WorldCharacter = {
        id: clean(parsed.data.id, 80),
        name: clean(parsed.data.name, 100),
        appearance: clean(parsed.data.appearance, 280),
        wardrobe: clean(parsed.data.wardrobe, 220),
        status: clean(parsed.data.status, 220),
        position: clean(parsed.data.position, 220),
      };
      const index = findById(draft.characters, character.id);
      if (index >= 0) draft.characters[index] = character;
      else draft.characters.push(character);
      draft.characters = draft.characters.slice(0, 8);
      continue;
    }

    if (call.name === "upsert_prop") {
      const parsed = UpsertPropArgs.safeParse(call.args);
      if (!parsed.success)
        throw new Error(
          `Invalid upsert_prop tool call: ${String(parsed.error).slice(0, 500)}`,
        );
      const prop: WorldProp = {
        id: clean(parsed.data.id, 80),
        name: clean(parsed.data.name, 100),
        description: clean(parsed.data.description, 280),
        status: clean(parsed.data.status, 220),
        position: clean(parsed.data.position, 220),
      };
      const index = findById(draft.props, prop.id);
      if (index >= 0) draft.props[index] = prop;
      else draft.props.push(prop);
      draft.props = draft.props.slice(0, 10);
      continue;
    }

    if (call.name === "open_thread") {
      const parsed = ThreadArgs.safeParse(call.args);
      if (!parsed.success)
        throw new Error(
          `Invalid open_thread tool call: ${String(parsed.error).slice(0, 500)}`,
        );
      draft.openThreads = addUnique(draft.openThreads, parsed.data.thread, 8);
      continue;
    }

    if (call.name === "resolve_thread") {
      const parsed = ThreadArgs.safeParse(call.args);
      if (!parsed.success)
        throw new Error(
          `Invalid resolve_thread tool call: ${String(parsed.error).slice(0, 500)}`,
        );
      draft.openThreads = resolveThread(draft.openThreads, parsed.data.thread);
      continue;
    }

    if (call.name === "remember_motif") {
      const parsed = MotifArgs.safeParse(call.args);
      if (!parsed.success)
        throw new Error(
          `Invalid remember_motif tool call: ${String(parsed.error).slice(0, 500)}`,
        );
      draft.motifs = addUnique(draft.motifs, parsed.data.motif, 8);
      continue;
    }

    if (call.name === "remember_visual_rule") {
      const parsed = VisualRuleArgs.safeParse(call.args);
      if (!parsed.success)
        throw new Error(
          `Invalid remember_visual_rule tool call: ${String(parsed.error).slice(0, 500)}`,
        );
      draft.visualRules = addUnique(draft.visualRules, parsed.data.rule, 10);
    }
  }

  return normalizeWorldState(
    { ...draft, revision: previous.revision + 1 },
    previous,
  );
}

function parseShowrunnerToolCalls(result: any): ToolCall[] {
  const calls = Array.isArray(result?.toolCalls) ? result.toolCalls : [];
  return calls
    .filter(
      (call: any) =>
        call &&
        typeof call.name === "string" &&
        call.args &&
        typeof call.args === "object",
    )
    .map((call: any) => ({
      name: String(call.name),
      args: call.args as Record<string, unknown>,
    }));
}

export async function planNextShot(input: {
  directive: string;
  recentStory: string[];
  episode: number;
  hasAnchor: boolean;
  worldState?: WorldState;
  generationMode?: GenerationMode;
  referenceContext?: ReferenceContext;
}): Promise<ShowrunnerResult> {
  const worldState = input.worldState || EMPTY_WORLD_STATE;
  const generationMode = input.generationMode || "full";

  if (generationMode === "emergency") {
    const plan = deterministicEmergencyPlan(input);
    return {
      plan,
      model: `${MODEL}:emergency`,
      inputTokens: null,
      outputTokens: null,
      nextWorldState: normalizeWorldState(
        {
          ...worldState,
          revision: worldState.revision + 1,
          lastEndingBeat: plan.endingBeat,
        },
        worldState,
      ),
    };
  }

  const result = await showrunnerMeasure.measure(
    {
      start: () => `Stage EP ${input.episode + 1} · ${MODEL}`,
      end: () => ({ model: MODEL }),
    },
    () =>
      callLLM(
        <PumpTVShowrunnerPrompt
          directive={input.directive}
          recentStory={input.recentStory}
          episode={input.episode}
          hasAnchor={input.hasAnchor}
          worldState={worldState}
          maxTokens={generationMode === "fast" ? 1800 : 2800}
          referenceContext={input.referenceContext}
        />,
      ),
  );

  const calls = parseShowrunnerToolCalls(result);
  const shotCalls = calls.filter((call) => call.name === "stage_shot");
  if (shotCalls.length !== 1) {
    throw new Error(
      `Showrunner must call stage_shot exactly once; received ${shotCalls.length}. Text: ${clean(result?.text, 600)}`,
    );
  }

  const shot = StageShotArgs.safeParse(shotCalls[0].args);
  if (!shot.success) {
    throw new Error(
      `Invalid stage_shot tool call: ${String(shot.error).slice(0, 900)}`,
    );
  }

  const plan: ShotPlan = {
    premise: clean(shot.data.premise, 500),
    transition: clean(shot.data.transition, 700),
    action: clean(shot.data.action, 900),
    continuity: clean(shot.data.continuity, 700),
    camera: clean(shot.data.camera, 500),
    visualDetails: clean(shot.data.visual_details, 700),
    audio: clean(shot.data.audio, 600),
    dialogue: clean(shot.data.dialogue || "", 400),
    endingBeat: clean(shot.data.ending_beat, 600),
  };

  const canonCalls = calls.filter((call) => call.name !== "stage_shot");
  const nextWorldState = applyCanonToolCalls(
    worldState,
    canonCalls,
    plan.endingBeat,
  );

  if (!input.hasAnchor && input.episode === 0) {
    if (
      nextWorldState.location === "Unestablished" ||
      nextWorldState.characters.length === 0
    ) {
      throw new Error(
        "Opening showrunner turn must establish a location and at least one persistent character through canon tools.",
      );
    }
  }

  showrunnerMeasure.measureSync(`EP ${input.episode + 1} staged`, () => ({
    calls: calls.length,
    runtime: process.env.JSX_AI_RUNTIME || "default",
    model: MODEL,
  }));

  return {
    plan,
    model: MODEL,
    inputTokens: result?.usage?.inputTokens ?? null,
    outputTokens: result?.usage?.outputTokens ?? null,
    nextWorldState,
    referenceContext: input.referenceContext,
  };
}
