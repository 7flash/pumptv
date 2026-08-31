export const OPENING =
  "Open on a rain-soaked neon convenience store at 2:13 AM. A nervous raccoon in a tiny delivery jacket discovers a mysterious glowing VHS tape behind the counter. Play it completely straight, cinematic live action.";

export const AUTOPILOT =
  "Continue the story naturally. Escalate one existing thread without changing the cast or world for no reason.";

export function sanitizeLine(value: string, max = 600) {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export function buildPrompt(input: {
  directive: string;
  recentStory: string[];
  episode: number;
  hasAnchor: boolean;
}) {
  const history = input.recentStory
    .slice(-6)
    .map((item, i) => `${i + 1}. ${sanitizeLine(item, 240)}`)
    .join("\n");

  return `You are generating shot ${input.episode + 1} of one endless, continuous, interactive livestream.

CONTINUITY RULES:
- ${input.hasAnchor ? "The provided image is the exact first frame. Continue directly from it with no reset, jump, title card, or establishing reboot." : "This is the opening shot. Establish a visually memorable world and protagonist that can continue indefinitely."}
- Preserve the same characters, wardrobe, props, architecture, lighting logic, and spatial relationships unless the story explicitly changes them.
- Treat prior events as canon. Do not repeat completed beats.
- Make the next 5 seconds feel causally connected to what just happened.
- End on an active, visually readable beat that another shot can continue from.
- Avoid credits, subtitles, logos, montage resets, or scene-ending fades.
- Generate natural synchronized audio: dialogue when appropriate, ambience, foley, and restrained music only when motivated.

RECENT CANON:
${history || "No prior canon yet."}

VIEWER DIRECTIVE FOR THIS SHOT:
${sanitizeLine(input.directive, 500)}

Create a coherent cinematic continuation. Favor one clear action over many unrelated events.`;
}
