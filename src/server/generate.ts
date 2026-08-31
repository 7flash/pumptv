import { fal } from "@fal-ai/client";
import type { Clip, Resolution } from "../shared/contracts.ts";
import { falMeasure } from "./observability.ts";
import { AUTOPILOT, OPENING, renderH3Prompt } from "./prompt.ts";
import { planNextShot } from "./showrunner.tsx";
import { reconcileRenderedClip } from "./visual-reconciler.tsx";
import { extractVideoFrame, sampleClipFrames } from "./video-frames.ts";
import {
  claimQueuedDirective,
  completeDirective,
  nextEpisode,
  recentStory,
  releaseDirective,
  getLatestWorldState,
  saveClipWithWorldState,
} from "./repository.ts";

const CLIP_SECONDS = 5;

function configureFal() {
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY is not configured.");
  fal.config({ credentials: process.env.FAL_KEY });
}

async function continuityFrame(previousClip: Clip | null) {
  if (!previousClip) return null;
  if (previousClip.endFrameUrl) return previousClip.endFrameUrl;
  return extractVideoFrame(previousClip.videoUrl, "last");
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
    const [story, worldState] = await Promise.all([
      recentStory(),
      getLatestWorldState(),
    ]);
    const anchorFrameUrl = await continuityFrame(input.previousClip);

    const showrunner = await planNextShot({
      directive,
      recentStory: story,
      episode,
      hasAnchor: Boolean(anchorFrameUrl),
      worldState,
    });
    const prompt = renderH3Prompt({
      plan: showrunner.plan,
      episode,
      hasAnchor: Boolean(anchorFrameUrl),
      worldState,
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

    // Reality is sampled after render. Failure here must not throw away an already-paid-for video.
    const frames = await sampleClipFrames({
      videoUrl: data.video.url,
      knownStartUrl: anchorFrameUrl,
    });
    const reconciliation = await reconcileRenderedClip({
      episode,
      directive,
      plan: showrunner.plan,
      priorWorldState: worldState,
      plannedWorldState: showrunner.nextWorldState,
      frames,
    });

    const previousEndMs = input.previousClip
      ? input.previousClip.startsAtMs +
        input.previousClip.durationSeconds * 1000
      : 0;
    const startsAtMs = input.previousClip
      ? Math.max(previousEndMs, Date.now() + 250)
      : Date.now() + 350;

    const clip = await saveClipWithWorldState(
      {
        requestId: result.requestId,
        videoUrl: data.video.url,
        expandedPrompt: data.expanded_prompt ?? null,
        h3Prompt: prompt,
        inferenceSeconds: data.timings?.inference ?? null,
        directive,
        directiveId: claimed?.id ?? null,
        episode,
        anchorFrameUrl,
        startFrameUrl: frames.start,
        middleFrameUrl: frames.middle,
        endFrameUrl: frames.end,
        usedAnchorFrame: Boolean(anchorFrameUrl),
        resolution: input.resolution,
        startsAtMs,
        durationSeconds: CLIP_SECONDS,
        showrunnerModel: showrunner.model,
        showrunnerPlanJson: JSON.stringify(showrunner.plan),
        showrunnerInputTokens: showrunner.inputTokens,
        showrunnerOutputTokens: showrunner.outputTokens,
      },
      reconciliation.worldState,
      {
        plannedWorldState: showrunner.nextWorldState,
        audit: reconciliation.audit,
      },
    );

    if (claimed) await completeDirective(claimed.id);
    return clip;
  } catch (error) {
    if (claimed) await releaseDirective(claimed.id);
    throw error;
  }
}
