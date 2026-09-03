import { fal } from "@fal-ai/client";
import type {
  Clip,
  Directive,
  GenerationMode,
  GenerationStage,
  Resolution,
  WorldState,
  WorldStateAudit,
} from "../shared/contracts.ts";
import { falMeasure, generationMeasure } from "./observability.ts";
import {
  OPENING,
  renderH3Prompt,
  sanitizeShotPlanForH3,
} from "./prompt.ts";
import { planNextShot } from "./showrunner.tsx";
import { resolveExternalReferences } from "./reference-tools.ts";
import type { ReferenceContext } from "./reference-tools.ts";
import { generateFactEndKeyframe } from "./fact-keyframe.ts";
import { extractVideoFrame, sampleClipFrames } from "./video-frames.ts";
import {
  claimQueuedDirective,
  getLatestClip,
  getLatestWorldState,
  nextEpisode,
  recentStory,
  releaseDirective,
  saveClipWithWorldState,
  saveClipWithWorldStateIfCurrent,
  ClipCommitConflictError,
  setGenerationStage,
} from "./repository.ts";

const CLIP_SECONDS = 5;

type ActiveGenerationStage = Exclude<GenerationStage, "idle">;
type StageObserver = (stage: ActiveGenerationStage) => void | Promise<void>;

type ClipPersistenceInput = Parameters<typeof saveClipWithWorldState>[0];
type DeferredClipFields = "directiveId" | "startsAtMs";

export type RenderedClipCandidate = {
  kind: "canonical" | "prewarm";
  episode: number;
  proposalId: number | null;
  previousClipId: number | null;
  renderedAtMs: number;
  clip: Omit<ClipPersistenceInput, DeferredClipFields>;
  nextWorldState: WorldState;
  audit: Omit<WorldStateAudit, "episode">;
};

export { ClipCommitConflictError as CandidateContinuityError } from "./repository.ts";

function configureFal() {
  if (!process.env.FAL_KEY) throw new Error("FAL_KEY is not configured.");
  fal.config({ credentials: process.env.FAL_KEY });
}

function elapsed(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function stage(observer: StageObserver | undefined, value: ActiveGenerationStage) {
  if (observer) await observer(value);
}

function factualOverlayText(
  directive: string,
  context: ReferenceContext | undefined,
): string | null {
  if (!context) return null;

  for (const fact of context.marketFacts || []) {
    const match = fact.match(
      /^([A-Z0-9]{2,10})\s+spot price:\s*(\$[0-9][0-9,]*(?:\.[0-9]+)?)/i,
    );
    if (match) return `${match[1].toUpperCase()} ${match[2]}`.slice(0, 96);
  }

  const symbol = /\b(bitcoin|btc)\b/i.test(directive)
    ? "BTC"
    : /\b(ethereum|ether|eth)\b/i.test(directive)
      ? "ETH"
      : /\b(solana|sol)\b/i.test(directive)
        ? "SOL"
        : /\b(dogecoin|doge)\b/i.test(directive)
          ? "DOGE"
          : null;
  if (!symbol) return null;

  for (const fact of context.facts || []) {
    const amount = fact.match(/\$[0-9][0-9,]*(?:\.[0-9]+)?/);
    if (amount) return `${symbol} ${amount[0]}`.slice(0, 96);
  }
  return null;
}

async function continuityFrame(previousClip: Clip | null) {
  if (!previousClip) return null;
  if (previousClip.endFrameUrl) return previousClip.endFrameUrl;
  return extractVideoFrame(previousClip.videoUrl, "last");
}

/**
 * Expensive but side-effect-light half of generation.
 *
 * It may call external models and read PumpTV canon, but it never claims a
 * directive, inserts a clip, advances world state, or closes a proposal round.
 * That separation is what makes speculative prewarming safe.
 */
export async function renderClipCandidate(input: {
  kind: "canonical" | "prewarm";
  episode: number;
  directive: string;
  proposalId?: number | null;
  previousClip: Clip | null;
  resolution: Resolution;
  mode?: GenerationMode;
  onStage?: StageObserver;
}): Promise<RenderedClipCandidate> {
  configureFal();

  const generationStartedAt = performance.now();
  const mode = input.mode || "full";

  return generationMeasure.measure(
    {
      start: () =>
        `${input.kind === "prewarm" ? "Pre-render" : "Render"} EP ${input.episode + 1} candidate`,
      end: (candidate) => ({
        kind: candidate.kind,
        episode: candidate.episode + 1,
        proposalId: candidate.proposalId,
        requestId: candidate.clip.requestId,
        totalMs: candidate.clip.totalGenerationMs,
      }),
    },
    async () => {
      const [story, worldState] = await Promise.all([
        recentStory(),
        getLatestWorldState(),
      ]);
      const anchorFrameUrl = await continuityFrame(input.previousClip);

      await stage(input.onStage, "planning");
      const referenceContext =
        input.episode === 0
          ? undefined
          : await resolveExternalReferences(input.directive, {
              knownTerms: [
                worldState.location,
                ...worldState.characters.map((character) => character.name),
                ...worldState.props.map((prop) => prop.name),
              ],
            });
      const factOverlayText = factualOverlayText(
        input.directive,
        referenceContext,
      );
      const showrunnerStartedAt = performance.now();
      const showrunner = await planNextShot({
        directive: input.directive,
        recentStory: story,
        episode: input.episode,
        hasAnchor: Boolean(anchorFrameUrl),
        worldState,
        generationMode: mode,
        referenceContext,
      });
      const showrunnerMs = elapsed(showrunnerStartedAt);

      const preKeyframePlan = sanitizeShotPlanForH3({
        plan: showrunner.plan,
        directive: input.directive,
        factOverlayText,
        factKeyframeProvided: false,
      });

      const factKeyframe = await generateFactEndKeyframe({
        anchorFrameUrl,
        factText: factOverlayText,
        plan: preKeyframePlan,
        resolution: input.resolution,
      });

      const h3Plan = sanitizeShotPlanForH3({
        plan: showrunner.plan,
        directive: input.directive,
        factOverlayText,
        factKeyframeProvided: Boolean(factKeyframe?.url),
      });

      const prompt = renderH3Prompt({
        plan: h3Plan,
        episode: input.episode,
        hasAnchor: Boolean(anchorFrameUrl),
        worldState,
        factOverlayText,
        factKeyframeProvided: Boolean(factKeyframe?.url),
      });

      const endpoint = anchorFrameUrl
        ? "minimax/h3-max/image-to-video"
        : "minimax/h3-max/text-to-video";

      const requestInput = anchorFrameUrl
        ? {
            prompt,
            image_url: anchorFrameUrl,
            ...(factKeyframe?.url ? { end_image_url: factKeyframe.url } : {}),
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

      await stage(input.onStage, "rendering");
      const h3StartedAt = performance.now();
      const result = await falMeasure.measure(
        {
          start: () =>
            `H3 Max EP ${input.episode + 1} · ${input.kind} · ${mode} · ${endpoint}`,
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

      await stage(input.onStage, "finalizing");
      const frameStartedAt = performance.now();
      const frames = await sampleClipFrames({
        videoUrl: data.video.url,
        knownStartUrl: anchorFrameUrl,
        mode: "continuity",
      });
      const frameSampleMs = elapsed(frameStartedAt);
      const totalGenerationMs = elapsed(generationStartedAt);

      return {
        kind: input.kind,
        episode: input.episode,
        proposalId: input.proposalId ?? null,
        previousClipId: input.previousClip?.id ?? null,
        renderedAtMs: Date.now(),
        clip: {
          requestId: result.requestId,
          videoUrl: data.video.url,
          expandedPrompt: data.expanded_prompt ?? null,
          h3Prompt: prompt,
          inferenceSeconds: data.timings?.inference ?? null,
          directive: input.directive,
          episode: input.episode,
          anchorFrameUrl,
          startFrameUrl: frames.start,
          middleFrameUrl: null,
          endFrameUrl: frames.end,
          usedAnchorFrame: Boolean(anchorFrameUrl),
          resolution: input.resolution,
          durationSeconds: CLIP_SECONDS,
          showrunnerModel: showrunner.model,
          showrunnerPlanJson: JSON.stringify({
            ...showrunner.plan,
            _references: showrunner.referenceContext || null,
            _sanitizedH3Plan: h3Plan,
            _factOverlay: factOverlayText,
            _factKeyframe: factKeyframe,
          }),
          showrunnerInputTokens: showrunner.inputTokens,
          showrunnerOutputTokens: showrunner.outputTokens,
          generationMode: mode,
          showrunnerMs,
          h3Ms,
          frameSampleMs,
          visionMs: 0,
          totalGenerationMs,
        },
        nextWorldState: showrunner.nextWorldState,
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
      };
    },
  );
}

/**
 * The only publish boundary for a rendered candidate.
 *
 * Continuity is rechecked at commit time because a prewarm can live for tens of
 * seconds while voting continues. If the live edge moved, the candidate is
 * rejected instead of silently corrupting canon.
 */
export async function commitRenderedClipCandidate(input: {
  candidate: RenderedClipCandidate;
  directive: Directive | null;
}): Promise<Clip> {
  const { candidate, directive } = input;

  return generationMeasure.measure(
    {
      start: () =>
        `${candidate.kind === "prewarm" ? "Promote" : "Commit"} EP ${candidate.episode + 1} candidate`,
      end: (clip) => ({
        clipId: clip.id,
        episode: clip.episode + 1,
        proposalId: candidate.proposalId,
        requestId: clip.requestId,
      }),
    },
    async () => {
      if (directive && candidate.proposalId !== directive.proposalId) {
        throw new ClipCommitConflictError(
          `Rendered proposal #${candidate.proposalId ?? "none"} does not match locked proposal #${directive.proposalId ?? "none"}.`,
        );
      }
      if (
        directive &&
        candidate.clip.directive.replace(/\s+/g, " ").trim() !==
          directive.text.replace(/\s+/g, " ").trim()
      ) {
        throw new ClipCommitConflictError(
          "The winning idea changed after this candidate started rendering.",
        );
      }

      const latest = await getLatestClip();
      const previousEndMs = latest
        ? latest.startsAtMs + latest.durationSeconds * 1000
        : 0;
      const startsAtMs = latest
        ? Math.max(previousEndMs, Date.now() + 75)
        : Date.now() + 650;

      return saveClipWithWorldStateIfCurrent(
        {
          ...candidate.clip,
          directiveId: directive?.id ?? null,
          startsAtMs,
        },
        candidate.nextWorldState,
        {
          plannedWorldState: candidate.nextWorldState,
          audit: candidate.audit,
        },
        {
          episode: candidate.episode,
          previousClipId: candidate.previousClipId,
        },
      );
    },
  );
}

/** Generate/commit when the worker already owns the directive claim. */
export async function generateClaimedClip(input: {
  previousClip: Clip | null;
  resolution: Resolution;
  mode?: GenerationMode;
  episode: number;
  directive: Directive | null;
}): Promise<Clip> {
  const directiveText = input.directive?.text || OPENING;
  try {
    const candidate = await renderClipCandidate({
      kind: "canonical",
      episode: input.episode,
      directive: directiveText,
      proposalId: input.directive?.proposalId ?? null,
      previousClip: input.previousClip,
      resolution: input.resolution,
      mode: input.mode,
      onStage: setGenerationStage,
    });
    const clip = await commitRenderedClipCandidate({
      candidate,
      directive: input.directive,
    });
    return clip;
  } catch (error) {
    if (input.directive) await releaseDirective(input.directive.id);
    throw error;
  }
}

/** Backward-compatible canonical entry point used outside the worker. */
export async function generateNextClip(input: {
  previousClip: Clip | null;
  resolution: Resolution;
  mode?: GenerationMode;
}): Promise<Clip> {
  const episode = await nextEpisode();
  const claimed = episode === 0 ? null : await claimQueuedDirective(episode);

  if (episode > 0 && !claimed) {
    throw new Error("No triggered proposal is queued for the next episode.");
  }

  return generateClaimedClip({
    ...input,
    episode,
    directive: claimed,
  });
}
