import { fal } from "@fal-ai/client";
import type { Clip, Resolution } from "../shared/contracts.ts";
import { falMeasure } from "./observability.ts";
import { AUTOPILOT, buildPrompt, OPENING } from "./prompt.ts";
import {
  getQueuedDirective,
  markDirectiveUsed,
  nextEpisode,
  recentStory,
  saveClip,
} from "./repository.ts";

export async function generateNextClip(input: {
  imageDataUrl: string | null;
  resolution: Resolution;
}): Promise<Clip> {
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY is not configured.");
  fal.config({ credentials: process.env.FAL_KEY });

  const episode = await nextEpisode();
  const queued = await getQueuedDirective();
  const directive = queued?.text || (episode === 0 ? OPENING : AUTOPILOT);
  const story = await recentStory();

  let imageUrl: string | undefined;
  if (input.imageDataUrl) {
    imageUrl =
      (await falMeasure.measure("Upload continuity frame", async () => {
        const blob = await fetch(input.imageDataUrl!).then((response) =>
          response.blob(),
        );
        return fal.storage.upload(blob, { lifecycle: { expiresIn: 3600 } });
      })) || undefined;
    if (!imageUrl) throw new Error("Could not upload continuity frame");
  }

  const prompt = buildPrompt({
    directive,
    recentStory: story,
    episode,
    hasAnchor: Boolean(imageUrl),
  });

  const endpoint = imageUrl
    ? "minimax/h3-max/image-to-video"
    : "minimax/h3-max/text-to-video";

  const requestInput = imageUrl
    ? {
        prompt,
        image_url: imageUrl,
        duration: 5,
        resolution: input.resolution,
        enable_safety_checker: true,
        prompt_expansion_mode: "balanced" as const,
      }
    : {
        prompt,
        duration: 5,
        resolution: input.resolution,
        aspect_ratio: "16:9" as const,
        enable_safety_checker: true,
        prompt_expansion_mode: "balanced" as const,
      };

  const result = await falMeasure.measure(
    { label: "Generate H3 Max clip", episode, endpoint },
    () => fal.subscribe(endpoint, { input: requestInput as any, logs: false }),
  );
  if (!result) throw new Error("fal generation failed");

  const data = result.data as {
    video?: { url?: string };
    expanded_prompt?: string | null;
    timings?: { inference?: number | null };
  };
  if (!data.video?.url) throw new Error("fal returned no video URL");

  const clip = await saveClip({
    requestId: result.requestId,
    videoUrl: data.video.url,
    expandedPrompt: data.expanded_prompt ?? null,
    inferenceSeconds: data.timings?.inference ?? null,
    directive,
    episode,
    usedAnchorFrame: Boolean(imageUrl),
    resolution: input.resolution,
  });

  if (queued) await markDirectiveUsed(queued.id, episode);
  return clip;
}
