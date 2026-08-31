import { z } from "sqlite-zod-orm";
import type {
  WorldCharacter,
  WorldProp,
  WorldState,
} from "../shared/contracts.ts";

function sanitizeLine(value: string, max = 600) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const WorldCharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  appearance: z.string(),
  wardrobe: z.string(),
  status: z.string(),
  position: z.string(),
});

const WorldPropSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.string(),
  position: z.string(),
});

export const WorldStateSchema = z.object({
  revision: z.number(),
  location: z.string(),
  locationDetails: z.string(),
  characters: z.array(WorldCharacterSchema),
  props: z.array(WorldPropSchema),
  openThreads: z.array(z.string()),
  motifs: z.array(z.string()),
  visualRules: z.array(z.string()),
  lastEndingBeat: z.string(),
});

export const EMPTY_WORLD_STATE: WorldState = {
  revision: 0,
  location: "Unestablished",
  locationDetails:
    "The opening shot has not established a durable location yet.",
  characters: [],
  props: [],
  openThreads: [],
  motifs: [],
  visualRules: [],
  lastEndingBeat: "No prior ending frame.",
};

function cleanList(values: string[], maxItems: number, maxChars: number) {
  return values
    .map((value) => sanitizeLine(value, maxChars))
    .filter(Boolean)
    .slice(0, maxItems);
}

export function normalizeWorldState(
  value: unknown,
  previous: WorldState = EMPTY_WORLD_STATE,
): WorldState {
  const parsed = WorldStateSchema.safeParse(value);
  if (!parsed.success) return previous;
  const next = parsed.data;

  return {
    revision: Math.max(
      previous.revision + 1,
      Math.floor(Number(next.revision || 0)),
    ),
    location: sanitizeLine(next.location, 120) || previous.location,
    locationDetails:
      sanitizeLine(next.locationDetails, 500) || previous.locationDetails,
    characters: next.characters
      .slice(0, 8)
      .map((character: WorldCharacter) => ({
        id: sanitizeLine(character.id, 80),
        name: sanitizeLine(character.name, 100),
        appearance: sanitizeLine(character.appearance, 280),
        wardrobe: sanitizeLine(character.wardrobe, 220),
        status: sanitizeLine(character.status, 220),
        position: sanitizeLine(character.position, 220),
      }))
      .filter((character: WorldCharacter) => character.id && character.name),
    props: next.props
      .slice(0, 10)
      .map((prop: WorldProp) => ({
        id: sanitizeLine(prop.id, 80),
        name: sanitizeLine(prop.name, 100),
        description: sanitizeLine(prop.description, 280),
        status: sanitizeLine(prop.status, 220),
        position: sanitizeLine(prop.position, 220),
      }))
      .filter((prop: WorldProp) => prop.id && prop.name),
    openThreads: cleanList(next.openThreads, 8, 260),
    motifs: cleanList(next.motifs, 8, 180),
    visualRules: cleanList(next.visualRules, 10, 240),
    lastEndingBeat:
      sanitizeLine(next.lastEndingBeat, 500) || previous.lastEndingBeat,
  };
}

export function parseWorldStateJson(
  value: string | null | undefined,
): WorldState | null {
  if (!value) return null;
  try {
    const parsed = WorldStateSchema.safeParse(JSON.parse(value));
    return parsed.success
      ? normalizeWorldState(parsed.data, {
          ...EMPTY_WORLD_STATE,
          revision: Math.max(0, parsed.data.revision - 1),
        })
      : null;
  } catch {
    return null;
  }
}

export function worldStateForShowrunner(state: WorldState) {
  return JSON.stringify(
    {
      revision: state.revision,
      location: state.location,
      locationDetails: state.locationDetails,
      characters: state.characters,
      props: state.props,
      openThreads: state.openThreads,
      motifs: state.motifs,
      visualRules: state.visualRules,
      lastEndingBeat: state.lastEndingBeat,
    },
    null,
    2,
  );
}

export function worldStateForH3(state: WorldState) {
  const characterLines = state.characters.map(
    (character) =>
      `${character.name}: ${character.appearance}; wardrobe ${character.wardrobe}; ${character.status}; position ${character.position}`,
  );
  const propLines = state.props.map(
    (prop) =>
      `${prop.name}: ${prop.description}; ${prop.status}; position ${prop.position}`,
  );

  return [
    `Location: ${state.location} — ${state.locationDetails}`,
    characterLines.length ? `Characters: ${characterLines.join(" | ")}` : null,
    propLines.length ? `Props: ${propLines.join(" | ")}` : null,
    state.visualRules.length
      ? `Visual invariants: ${state.visualRules.join(" | ")}`
      : null,
    state.motifs.length
      ? `Recurring motifs: ${state.motifs.join(" | ")}`
      : null,
    `Prior ending state: ${state.lastEndingBeat}`,
  ]
    .filter(Boolean)
    .join("\n");
}
