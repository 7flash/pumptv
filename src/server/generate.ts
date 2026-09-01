import { fal } from "@fal-ai/client";
import type { Clip, GenerationMode, Resolution } from "../shared/contracts.ts";
import { falMeasure } from "./observability.ts";
import { OPENING, renderH3Prompt } from "./prompt.ts";
import { planNextShot } from "./showrunner.tsx";
import { extractVideoFrame, sampleClipFrames } from "./video-frames.ts";
import {
  claimQueuedDirective,
  completeDirective,
  getLatestWorldState,
  nextEpisode,
  recentStory,
  releaseDirective,
  saveClipWithWorldState,
  setGenerationStage,
} from "./repository.ts";

const CLIP_SECONDS = 5;

function configureFal() {
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY is not configured.");
  fal.config({ credentials: process.env.FAL_KEY });
}

function elapsed(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function continuityFrame(previousClip: Clip | null) {
  if (!previousClip) return null;
  if (previousClip.endFrameUrl) return previousClip.endFrameUrl;
  return extractVideoFrame(previousClip.videoUrl, "last");
}

export async function generateNextClip(input: {
  previousClip: Clip | null;
  resolution: Resolution;
  mode?: GenerationMode;
}): Promise<Clip> {
  configureFal();

  const generationStartedAt = performance.now();
  const mode = input.mode || "full";
  const episode = await nextEpisode();
  const claimed = episode === 0 ? null : await claimQueuedDirective(episode);

  if (episode > 0 && !claimed) {
    throw new Error("No Pump.fun prompt is queued for the next episode.");
  }

  const directive = claimed?.text || OPENING;

  try {
    const [story, worldState] = await Promise.all([
      recentStory(),
      getLatestWorldState(),
    ]);
    const anchorFrameUrl = await continuityFrame(input.previousClip);

    await setGenerationStage("planning");
    const showrunnerStartedAt = performance.now();
    const showrunner = await planNextShot({
      directive,
      recentStory: story,
      episode,
      hasAnchor: Boolean(anchorFrameUrl),
      worldState,
      generationMode: mode,
    });
    const showrunnerMs = elapsed(showrunnerStartedAt);

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

    await setGenerationStage("rendering");
    const h3StartedAt = performance.now();
    const result = await falMeasure.measure(
      {
        start: () => `H3 Max EP ${episode + 1} · ${mode} · ${endpoint}`,
        end: (response) => ({
          requestId: response.requestId,
          hasVideo: Boolean((response.data as any)?.video?.url),
        }),
      },
      () =>
        fal.subscribe(endpoint, { input: requestInput as any, logs: false }),
    );
    const h3Ms = elapsed(h3StartedAt);

    const data = result.data as {
      video?: { url?: string };
      expanded_prompt?: string | null;
      timings?: { inference?: number | null };
    };
    if (!data.video?.url) throw new Error("fal returned no video URL");

    // Vision/canon auditing is intentionally disabled for now. We only sample
    // the first/end frames needed for thumbnails and seamless I2V continuity.
    await setGenerationStage("finalizing");
    const frameStartedAt = performance.now();
    const frames = await sampleClipFrames({
      videoUrl: data.video.url,
      knownStartUrl: anchorFrameUrl,
      mode: "continuity",
    });
    const frameSampleMs = elapsed(frameStartedAt);

    const previousEndMs = input.previousClip
      ? input.previousClip.startsAtMs +
        input.previousClip.durationSeconds * 1000
      : 0;
    const startsAtMs = input.previousClip
      ? Math.max(previousEndMs, Date.now() + 75)
      : Date.now() + 650;
    const totalGenerationMs = elapsed(generationStartedAt);

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
        middleFrameUrl: null,
        endFrameUrl: frames.end,
        usedAnchorFrame: Boolean(anchorFrameUrl),
        resolution: input.resolution,
        startsAtMs,
        durationSeconds: CLIP_SECONDS,
        showrunnerModel: showrunner.model,
        showrunnerPlanJson: JSON.stringify(showrunner.plan),
        showrunnerInputTokens: showrunner.inputTokens,
        showrunnerOutputTokens: showrunner.outputTokens,
        generationMode: mode,
        showrunnerMs,
        h3Ms,
        frameSampleMs,
        visionMs: 0,
        totalGenerationMs,
      },
      showrunner.nextWorldState,
      {
        plannedWorldState: showrunner.nextWorldState,
        audit: {
          status: "skipped",
          model: null,
          summary: null,
          drift: [],
          sampledFrameUrls: [frames.start, frames.end].filter(
            (value): value is string => Boolean(value),
          ),
          inputTokens: null,
          outputTokens: null,
          cost: null,
        },
      },
    );

    if (claimed) await completeDirective(claimed.id);
    return clip;
  } catch (error) {
    if (claimed) await releaseDirective(claimed.id);
    throw error;
  }
}
