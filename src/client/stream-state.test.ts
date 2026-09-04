import { describe, expect, test } from "bun:test";
import {
  initialCatchupReplayClipId,
  publishedClipsAt,
  streamSnapshotIsStale,
} from "./stream-state.ts";
import type { Clip } from "../shared/contracts.ts";

function clip(id: number, episode: number, startsAtMs = 0): Clip {
  return {
    id,
    requestId: `req-${id}`,
    videoUrl: `https://example.test/${id}.mp4`,
    directive: `clip ${id}`,
    directiveId: null,
    episode,
    anchorFrameUrl: null,
    startFrameUrl: null,
    middleFrameUrl: null,
    endFrameUrl: null,
    usedAnchorFrame: false,
    resolution: "480P",
    startsAtMs,
    durationSeconds: 5,
    expandedPrompt: null,
    h3Prompt: null,
    inferenceSeconds: null,
    showrunnerModel: null,
    showrunnerPlanJson: null,
    showrunnerInputTokens: null,
    showrunnerOutputTokens: null,
    generationMode: "full",
    showrunnerMs: null,
    h3Ms: null,
    frameSampleMs: null,
    visionMs: null,
    totalGenerationMs: null,
    directiveSource: null,
    directiveAuthor: null,
    directiveAuthorAddress: null,
    directiveProposalId: null,
    directiveVoteCount: null,
  };
}

describe("stream state helpers", () => {
  test("publishedClipsAt excludes future clips and orders by episode", () => {
    const timeline = [clip(3, 2, 300), clip(1, 0, 100), clip(2, 1, 200)];
    expect(publishedClipsAt(timeline, 250).map((item) => item.id)).toEqual([
      1, 2,
    ]);
  });

  test("new viewer catchup starts seven episodes behind the live edge", () => {
    const timeline = Array.from({ length: 12 }, (_, index) =>
      clip(index + 1, index),
    );
    expect(initialCatchupReplayClipId(timeline, 1_000, 7)).toBe(5);
  });

  test("catchup stays live when history is shorter than the requested offset", () => {
    const timeline = [clip(1, 0)];
    expect(initialCatchupReplayClipId(timeline, 1_000, 7)).toBeNull();
  });

  test("older server snapshots are rejected", () => {
    expect(streamSnapshotIsStale(999, 1_000)).toBe(true);
    expect(streamSnapshotIsStale(1_000, 1_000)).toBe(false);
    expect(streamSnapshotIsStale(1_001, 1_000)).toBe(false);
  });
});
