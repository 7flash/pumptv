import { describe, expect, test } from "bun:test";
import type { Clip } from "../shared/contracts.ts";
import {
  clipAfterFor,
  desiredClipFor,
  latestPublishedClipFor,
  publishedClips,
} from "./media-deck.ts";

function clip(id: number, startsAtMs: number): Clip {
  return {
    id,
    episode: id - 1,
    requestId: `req-${id}`,
    videoUrl: `https://example.invalid/${id}.mp4`,
    directive: `idea ${id}`,
    directiveId: id,
    anchorFrameUrl: null,
    startFrameUrl: null,
    middleFrameUrl: null,
    endFrameUrl: null,
    usedAnchorFrame: false,
    resolution: "480P",
    startsAtMs,
    durationSeconds: 5,
    generationMode: "full",
    expandedPrompt: null,
    h3Prompt: null,
    inferenceSeconds: null,
    showrunnerModel: null,
    showrunnerPlanJson: null,
    showrunnerInputTokens: null,
    showrunnerOutputTokens: null,
    showrunnerMs: null,
    h3Ms: null,
    frameSampleMs: null,
    visionMs: null,
    totalGenerationMs: null,
    directiveAuthor: null,
    directiveAuthorAddress: null,
  } as Clip;
}

describe("media clip selection", () => {
  const timeline = [clip(1, 1_000), clip(2, 2_000), clip(3, 3_000)];

  test("only publishes clips whose start time has arrived", () => {
    expect(publishedClips(timeline, 2_500).map((item) => item.id)).toEqual([
      1, 2,
    ]);
    expect(latestPublishedClipFor(timeline, 2_500)?.id).toBe(2);
  });

  test("live mode follows the latest published clip", () => {
    expect(
      desiredClipFor(
        {
          timeline,
          replayClipId: null,
          playbackPaused: false,
          pausedClipId: null,
        },
        2_500,
      )?.id,
    ).toBe(2);
  });

  test("replay selection overrides the live edge", () => {
    expect(
      desiredClipFor(
        {
          timeline,
          replayClipId: 1,
          playbackPaused: false,
          pausedClipId: null,
        },
        3_500,
      )?.id,
    ).toBe(1);
  });

  test("paused clip remains stable even when a newer clip publishes", () => {
    expect(
      desiredClipFor(
        {
          timeline,
          replayClipId: null,
          playbackPaused: true,
          pausedClipId: 1,
        },
        3_500,
      )?.id,
    ).toBe(1);
  });

  test("replay auto-advance never reaches an unpublished future clip", () => {
    expect(clipAfterFor(timeline, timeline[1], 2_500, true)).toBeNull();
    expect(clipAfterFor(timeline, timeline[1], 3_500, true)?.id).toBe(3);
  });
});
