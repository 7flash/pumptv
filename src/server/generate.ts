import { fal } from "@fal-ai/client";
import type { Clip, Resolution } from "../shared/contracts.ts";
import { falMeasure } from "./observability.ts";
import { AUTOPILOT, buildPrompt, OPENING } from "./prompt.ts";
import {
  claimQueuedDirective,
  completeDirective,
  nextEpisode,
  recentStory,
  releaseDirective,
  saveClip,
} from "./repository.ts";

const CLIP_SECONDS = 5;

function configureFal() {
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY is not configured.");
  fal.config({ credentials: process.env.FAL_KEY });
}

async function extractLastFrame(videoUrl: string) {
  const result = await falMeasure.measure("Extract continuity frame", () =>
    fal.subscribe("fal-ai/ffmpeg-api/extract-frame", {
      input: { video_url: videoUrl, frame_type: "last" },
      logs: false,
    }),
  );
  if (!result) throw new Error("Could not extract continuity frame");

  const data = result.data as { images?: Array<{ url?: string }> };
  const url = data.images?.[0]?.url;
  if (!url) throw new Error("Frame extractor returned no image");
  return url;
}

export async function generateNextClip(input: {
  previousClip: Clip | null;
  resolution: Resolution;
}): Promise<Clip> {
  configureFal();

  const episode = await nextEpisode();
  const claimed = await claimQueuedDirective(episode);
  const directive = claimed?.text || (episode === 0 ? OPENING : AUTOPILOT);

  try {
    const story = await recentStory();
    const anchorFrameUrl = input.previousClip
      ? await extractLastFrame(input.previousClip.videoUrl)
      : null;

    const prompt = buildPrompt({
      directive,
      recentStory: story,
      episode,
      hasAnchor: Boolean(anchorFrameUrl),
    });

    const endpoint = anchorFrameUrl
      ? "minimax/h3-max/image-to-video"
      : "minimax/h3-max/text-to-video";

    const requestInput = anchorFrameUrl
      ? {
          prompt,
          image_url: anchorFrameUrl,
          duration: CLIP_SECONDS,
          resolution: input.resolution,
          enable_safety_checker: true,
          prompt_expansion_mode: "balanced" as const,
        }
      : {
          prompt,
          duration: CLIP_SECONDS,
          resolution: input.resolution,
          aspect_ratio: "16:9" as const,
          enable_safety_checker: true,
          prompt_expansion_mode: "balanced" as const,
        };

    const result = await falMeasure.measure(
      { label: "Generate H3 Max clip", episode, endpoint },
      () =>
        fal.subscribe(endpoint, { input: requestInput as any, logs: false }),
    );
    if (!result) throw new Error("fal generation failed");

    const data = result.data as {
      video?: { url?: string };
      expanded_prompt?: string | null;
      timings?: { inference?: number | null };
    };
    if (!data.video?.url) throw new Error("fal returned no video URL");

    const previousEndMs = input.previousClip
      ? input.previousClip.startsAtMs +
        input.previousClip.durationSeconds * 1000
      : 0;
    const startsAtMs = input.previousClip
      ? Math.max(previousEndMs, Date.now() + 250)
      : Date.now() + 350;

    const clip = await saveClip({
      requestId: result.requestId,
      videoUrl: data.video.url,
      expandedPrompt: data.expanded_prompt ?? null,
      inferenceSeconds: data.timings?.inference ?? null,
      directive,
      directiveId: claimed?.id ?? null,
      episode,
      anchorFrameUrl,
      usedAnchorFrame: Boolean(anchorFrameUrl),
      resolution: input.resolution,
      startsAtMs,
      durationSeconds: CLIP_SECONDS,
    });

    if (claimed) await completeDirective(claimed.id);
    return clip;
  } catch (error) {
    if (claimed) await releaseDirective(claimed.id);
    throw error;
  }
}
