import type {
  BufferHealth,
  GenerationMode,
  GenerationTimingSample,
} from "../shared/contracts.ts";

const CLIP_MS = 5_000;
const MIN_CLIPS_AHEAD = Math.max(
  2,
  Number(process.env.PUMPTV_MIN_CLIPS_AHEAD || 2),
);
const TARGET_CLIPS_AHEAD = Math.max(
  MIN_CLIPS_AHEAD,
  Math.min(3, Number(process.env.PUMPTV_TARGET_CLIPS_AHEAD || 3)),
);
const DEFAULT_LEAD_MS = Number(process.env.PUMPTV_GENERATION_LEAD_MS || 4_500);
const SAFETY_MARGIN_MS = Number(
  process.env.PUMPTV_BUFFER_SAFETY_MARGIN_MS || 1_000,
);

function finite(values: Array<number | null | undefined>) {
  return values.filter(
    (value): value is number => Number.isFinite(value) && Number(value) >= 0,
  );
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
}

export function summarizeGenerationTimings(samples: GenerationTimingSample[]) {
  const totals = finite(samples.map((sample) => sample.totalGenerationMs));
  const h3 = finite(samples.map((sample) => sample.h3Ms));
  const p50TotalMs = percentile(totals, 0.5);
  const p90TotalMs = percentile(totals, 0.9);
  const p50H3Ms = percentile(h3, 0.5);

  return {
    sampleCount: totals.length,
    p50TotalMs,
    p90TotalMs,
    p50H3Ms,
  };
}

export function evaluateBuffer(input: {
  bufferMs: number;
  samples: GenerationTimingSample[];
  activeMode?: GenerationMode;
  hasClip: boolean;
}): BufferHealth {
  const stats = summarizeGenerationTimings(input.samples);
  const predictedGenerationMs = stats.p90TotalMs ?? DEFAULT_LEAD_MS;
  const adaptiveLeadMs = Math.max(
    3_000,
    Math.min(12_000, Math.ceil(predictedGenerationMs + SAFETY_MARGIN_MS)),
  );
  const targetBufferMs = TARGET_CLIPS_AHEAD * CLIP_MS;
  const minimumBufferMs = MIN_CLIPS_AHEAD * CLIP_MS;

  let recommendedMode: GenerationMode = "full";
  if (input.hasClip) {
    if (input.bufferMs <= adaptiveLeadMs + 750) recommendedMode = "emergency";
    else if (input.bufferMs <= adaptiveLeadMs + CLIP_MS)
      recommendedMode = "fast";
  }

  const health =
    input.bufferMs <= 0
      ? "empty"
      : input.bufferMs < adaptiveLeadMs
        ? "critical"
        : input.bufferMs < minimumBufferMs
          ? "tight"
          : "healthy";

  return {
    mode: input.activeMode ?? recommendedMode,
    recommendedMode,
    health,
    bufferMs: Math.max(0, Math.round(input.bufferMs)),
    targetBufferMs,
    minimumBufferMs,
    desiredClipsAhead: TARGET_CLIPS_AHEAD,
    adaptiveLeadMs,
    sampleCount: stats.sampleCount,
    p50TotalMs: stats.p50TotalMs,
    p90TotalMs: stats.p90TotalMs,
    p50H3Ms: stats.p50H3Ms,
  };
}

export const BUFFER_CLIP_MS = CLIP_MS;
