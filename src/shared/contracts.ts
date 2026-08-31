export type Resolution = "480P" | "768P";

export type Clip = {
  id: number;
  requestId: string;
  videoUrl: string;
  expandedPrompt: string | null;
  inferenceSeconds: number | null;
  directive: string;
  episode: number;
  usedAnchorFrame: boolean;
  resolution: Resolution;
};

export type Directive = {
  id: number;
  text: string;
  status: "queued" | "used";
  usedEpisode: number | null;
};

export type StreamState = {
  latestClip: Clip | null;
  recentDirectives: Directive[];
  queuedCount: number;
};
