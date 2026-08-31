import { fal } from "@fal-ai/client";
import { falMeasure } from "./observability.ts";

export type VideoFrameType = "first" | "middle" | "last";
export type ClipFrameSample = {
  start: string | null;
  middle: string | null;
  end: string | null;
};

export async function extractVideoFrame(
  videoUrl: string,
  frameType: VideoFrameType,
): Promise<string> {
  const result = await falMeasure.measure(
    { label: "Extract video frame", frameType },
    () =>
      fal.subscribe("fal-ai/ffmpeg-api/extract-frame", {
        input: { video_url: videoUrl, frame_type: frameType },
        logs: false,
      }),
  );
  if (!result) throw new Error(`Could not extract ${frameType} frame`);

  const data = result.data as { images?: Array<{ url?: string }> };
  const url = data.images?.[0]?.url;
  if (!url) throw new Error(`Frame extractor returned no ${frameType} image`);
  return url;
}

async function safeExtract(videoUrl: string, frameType: VideoFrameType) {
  try {
    return await extractVideoFrame(videoUrl, frameType);
  } catch (error) {
    console.error(`[frames] ${frameType} extraction failed`, error);
    return null;
  }
}

export async function sampleClipFrames(input: {
  videoUrl: string;
  knownStartUrl?: string | null;
  mode?: "full" | "continuity";
}): Promise<ClipFrameSample> {
  const mode = input.mode || "full";
  if (mode === "continuity") {
    const [start, end] = await Promise.all([
      input.knownStartUrl
        ? Promise.resolve(input.knownStartUrl)
        : safeExtract(input.videoUrl, "first"),
      safeExtract(input.videoUrl, "last"),
    ]);
    return { start, middle: null, end };
  }

  const [start, middle, end] = await Promise.all([
    input.knownStartUrl
      ? Promise.resolve(input.knownStartUrl)
      : safeExtract(input.videoUrl, "first"),
    safeExtract(input.videoUrl, "middle"),
    safeExtract(input.videoUrl, "last"),
  ]);

  return { start, middle, end };
}
