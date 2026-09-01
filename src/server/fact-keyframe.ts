import { fal } from "@fal-ai/client";
import type { Resolution } from "../shared/contracts.ts";
import type { ShotPlan } from "./prompt.ts";
import { falMeasure } from "./observability.ts";

const DEFAULT_MODEL = "fal-ai/flux-2/edit";

export type FactKeyframe = {
  url: string;
  model: string;
  requestId: string | null;
  text: string;
};

function enabled() {
  const value = (process.env.PUMPTV_FACT_KEYFRAME || "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(value);
}

function clean(value: string, max: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function keyframePrompt(input: { text: string; plan: ShotPlan }) {
  const exact = clean(input.text, 96);
  return `Edit the supplied image into a plausible cinematic final frame about five seconds later, preserving the same location, visual identity, lighting, camera logic, character continuity, and physical geography.

Story action: ${clean(input.plan.action, 700)}
Ending beat: ${clean(input.plan.endingBeat, 500)}
Visual direction: ${clean(input.plan.visualDetails, 500)}

The ending must contain one naturally integrated physical display, monitor, register screen, phone screen, sign, or other story-appropriate surface that clearly and legibly shows EXACTLY this text, character-for-character:
"${exact}"

The exact text above is the only important readable typography. Spell every character and digit correctly. Do not mirror it. Do not substitute digits or words. Do not add subtitles, captions, watermarks, extra labels, extra prices, or other readable text. The text must exist physically inside the scene, not as a graphic overlay outside the world. Keep the rest photorealistic and consistent with the supplied frame.`;
}

export async function generateFactEndKeyframe(input: {
  anchorFrameUrl: string | null;
  factText: string | null;
  plan: ShotPlan;
  resolution: Resolution;
}): Promise<FactKeyframe | null> {
  if (!enabled() || !input.anchorFrameUrl || !input.factText) return null;

  const model = (
    process.env.PUMPTV_FACT_KEYFRAME_MODEL || DEFAULT_MODEL
  ).trim();
  try {
    const result = await falMeasure.measure(
      {
        start: () => `Fact end keyframe · ${model}`,
        end: (response) => ({
          requestId: response.requestId,
          hasImage: Boolean((response.data as any)?.images?.[0]?.url),
        }),
      },
      () =>
        fal.subscribe(model, {
          input: {
            prompt: keyframePrompt({ text: input.factText!, plan: input.plan }),
            image_urls: [input.anchorFrameUrl!],
            image_size: "landscape_16_9",
            num_images: 1,
            output_format: "png",
            enable_safety_checker: true,
            guidance_scale: 2.5,
            num_inference_steps: 28,
          } as any,
          logs: false,
        }),
    );

    const data = result.data as { images?: Array<{ url?: string }> };
    const url = data.images?.[0]?.url;
    if (!url) throw new Error("Fact keyframe model returned no image");
    return {
      url,
      model,
      requestId: result.requestId || null,
      text: input.factText,
    };
  } catch {
    // Exact fact remains available in the normal PumpTV factual caption. A
    // failed optional image edit must never prevent the episode from rendering.
    return null;
  }
}
