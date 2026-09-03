import type { WorldState } from "../shared/contracts.ts";
import { worldStateForH3 } from "./world-state.ts";

export const OPENING =
  "Open on a rain-soaked neon convenience store at 2:13 AM. A nervous raccoon in a tiny delivery jacket discovers a mysterious glowing VHS tape behind the counter. Play it completely straight, cinematic live action.";

export function sanitizeLine(value: string, max = 600) {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export type ShotPlan = {
  premise: string;
  action: string;
  transition: string;
  continuity: string;
  camera: string;
  visualDetails: string;
  audio: string;
  dialogue: string;
  endingBeat: string;
};


function regexEscape(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactExactFact(value: string, factText: string | null | undefined) {
  let result = value;
  const fact = sanitizeLine(factText || "", 120);
  if (!fact) return result;
  const variants = new Set<string>([fact]);
  const numeric = fact.match(/[0-9][0-9,]*(?:\.[0-9]+)?/g) || [];
  for (const number of numeric) {
    variants.add(number);
    variants.add(number.replace(/,/g, ""));
    variants.add(`$${number}`);
    variants.add(`$${number.replace(/,/g, "")}`);
  }
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) {
    if (!variant) continue;
    result = result.replace(
      new RegExp(regexEscape(variant), "gi"),
      "the exact factual readout",
    );
  }
  return result;
}

function explicitTypographyRequest(directive: string) {
  return /\b(?:print|write|spell|caption|subtitle|label|sign\s+(?:says|reads)|display\s+(?:the\s+)?(?:word|name|text)|screen\s+(?:says|reads))\b/i.test(
    directive,
  );
}

function suppressIncidentalTypography(value: string) {
  return value
    .replace(
      /\b(?:display|screen|readout)\s+(?:shows?|displays?)\s+the exact factual readout\b/gi,
      "display remains abstract and unreadable",
    )
    .replace(
      /\b(?:display|screen|readout)\s+(?:of|with)\s+the exact factual readout\b/gi,
      "display with abstract unreadable segments",
    )
    .replace(
      /\b(?:reads?|reading|says?|showing|prints?|printing|spells?|spelling)\s+(?:["'][^"']{1,80}["']|[A-Z][A-Za-z0-9_-]{2,}|the exact factual readout)\b/g,
      "showing unreadable marks",
    );
}

export function sanitizeShotPlanForH3(input: {
  plan: ShotPlan;
  directive: string;
  factOverlayText?: string | null;
  factKeyframeProvided?: boolean;
}): ShotPlan {
  const preserveRequestedTypography = explicitTypographyRequest(input.directive);
  const cleanMotionField = (value: string) => {
    let next = redactExactFact(value, input.factOverlayText);
    if (!preserveRequestedTypography) next = suppressIncidentalTypography(next);
    return sanitizeLine(next, 900);
  };

  const sanitized: ShotPlan = {
    ...input.plan,
    action: cleanMotionField(input.plan.action),
    visualDetails: cleanMotionField(input.plan.visualDetails),
    dialogue: redactExactFact(input.plan.dialogue, input.factOverlayText),
    endingBeat: cleanMotionField(input.plan.endingBeat),
  };

  if (input.factOverlayText && input.factKeyframeProvided) {
    sanitized.action = sanitizeLine(
      `${sanitized.action} Keep any factual display unreadable until the camera reaches the supplied final frame.`,
      900,
    );
    sanitized.visualDetails = sanitizeLine(
      `${sanitized.visualDetails} During motion, use only abstract or obscured display segments; no stable readable digits or labels.`,
      700,
    );
    sanitized.endingBeat = sanitizeLine(
      `Settle into the supplied final keyframe, where the exact factual readout becomes readable. ${sanitized.endingBeat}`,
      600,
    );
  }

  return sanitized;
}

export function renderH3Prompt(input: {
  plan: ShotPlan;
  episode: number;
  hasAnchor: boolean;
  worldState: WorldState;
  factOverlayText?: string | null;
  factKeyframeProvided?: boolean;
}) {
  const { plan } = input;
  return `Shot ${input.episode + 1} of one endless, continuous, interactive livestream.

CONTINUITY:
${input.hasAnchor ? "The supplied image is the exact first frame. Continue from it immediately; no reset, jump, title card, establishing reboot, or unexplained wardrobe/location change." : "This is the opening shot. Establish the world and protagonist clearly so later shots can continue them."}
${sanitizeLine(plan.continuity, 700)}

PERSISTENT CANON — DO NOT SILENTLY MUTATE:
${worldStateForH3(input.worldState)}

SCENE INTENT:
${sanitizeLine(plan.premise, 500)}

SEAMLESS HANDOFF — FIRST 1–2 SECONDS:
${sanitizeLine(plan.transition, 700)}

ACTION — NEXT 5 SECONDS:
${sanitizeLine(plan.action, 900)}

CAMERA:
${sanitizeLine(plan.camera, 500)}

VISUAL DETAILS:
${sanitizeLine(plan.visualDetails, 700)}

TEXT / NUMBERS:
Do not invent readable words, names, labels, receipts, subtitles, prices, numbers, signage, UI text, or typography during the motion. Never satisfy a named person or character by printing their name on an object.
${input.factOverlayText && input.factKeyframeProvided ? `The supplied FINAL keyframe already contains the exact in-world factual readout ${sanitizeLine(input.factOverlayText, 120)}. Preserve that final keyframe faithfully. Let the display be obscured, abstract, or unreadable during the earlier motion rather than inventing alternate digits; the exact text should resolve only as the shot reaches the supplied final frame.` : input.factOverlayText ? `PumpTV will present this exact factual readout separately: ${sanitizeLine(input.factOverlayText, 120)}. Stage the physical reveal and character reaction, but DO NOT draw or spell that value in generated frames.` : "No exact factual readout is required for this shot."}

AUDIO:
${sanitizeLine(plan.audio, 600)}
${plan.dialogue ? `Dialogue: ${sanitizeLine(plan.dialogue, 400)}` : "No forced dialogue."}

ENDING BEAT:
${sanitizeLine(plan.endingBeat, 600)}

Preserve established characters, wardrobe, props, architecture, lighting logic, geography, and prior events as canon. The first moments must visibly inherit motion, eyelines, pose, screen direction and environmental state from the previous final frame before the new audience idea takes over. If the new idea is unrelated, introduce it through a causal arrival, reveal, transformation, reaction, object interaction, sound cue, or camera discovery inside the existing scene rather than teleporting or resetting. Favor one readable causal action. Do not repeat completed beats. No credits, subtitles, logos, montage resets, scene-ending fades, or disconnected cutaways. End on an active visual state another five-second shot can continue directly.`;
}