export const OPENING =
  "Open on a rain-soaked neon convenience store at 2:13 AM. A nervous raccoon in a tiny delivery jacket discovers a mysterious glowing VHS tape behind the counter. Play it completely straight, cinematic live action.";

export const AUTOPILOT =
  "Continue the story naturally. Escalate one existing thread without changing the cast or world for no reason.";

export function sanitizeLine(value: string, max = 600) {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export type ShotPlan = {
  premise: string;
  action: string;
  continuity: string;
  camera: string;
  visualDetails: string;
  audio: string;
  dialogue: string;
  endingBeat: string;
};

export function renderH3Prompt(input: {
  plan: ShotPlan;
  episode: number;
  hasAnchor: boolean;
}) {
  const { plan } = input;
  return `Shot ${input.episode + 1} of one endless, continuous, interactive livestream.

CONTINUITY:
${input.hasAnchor ? "The supplied image is the exact first frame. Continue from it immediately; no reset, jump, title card, establishing reboot, or unexplained wardrobe/location change." : "This is the opening shot. Establish the world and protagonist clearly so later shots can continue them."}
${sanitizeLine(plan.continuity, 700)}

SCENE INTENT:
${sanitizeLine(plan.premise, 500)}

ACTION — NEXT 5 SECONDS:
${sanitizeLine(plan.action, 900)}

CAMERA:
${sanitizeLine(plan.camera, 500)}

VISUAL DETAILS:
${sanitizeLine(plan.visualDetails, 700)}

AUDIO:
${sanitizeLine(plan.audio, 600)}
${plan.dialogue ? `Dialogue: ${sanitizeLine(plan.dialogue, 400)}` : "No forced dialogue."}

ENDING BEAT:
${sanitizeLine(plan.endingBeat, 600)}

Preserve established characters, wardrobe, props, architecture, lighting logic, geography, and prior events as canon. Favor one readable causal action. Do not repeat completed beats. No credits, subtitles, logos, montage resets, scene-ending fades, or disconnected cutaways. End on an active visual state another five-second shot can continue directly.`;
}
