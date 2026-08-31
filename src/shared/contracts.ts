export type Resolution = "480P" | "768P";
export type DirectiveStatus = "queued" | "generating" | "used";
export type WorkerState = "idle" | "generating" | "error";

export type Clip = {
  id: number;
  requestId: string;
  videoUrl: string;
  expandedPrompt: string | null;
  inferenceSeconds: number | null;
  directive: string;
  directiveId: number | null;
  episode: number;
  anchorFrameUrl: string | null;
  usedAnchorFrame: boolean;
  resolution: Resolution;
  startsAtMs: number;
  durationSeconds: number;
};

export type Directive = {
  id: number;
  text: string;
  status: DirectiveStatus;
  usedEpisode: number | null;
};

export type RoomState = {
  name: string;
  running: boolean;
  resolution: Resolution;
  workerState: WorkerState;
  lastError: string | null;
  bufferedUntilMs: number | null;
};

export type StreamState = {
  serverNowMs: number;
  room: RoomState;
  currentClip: Clip | null;
  latestClip: Clip | null;
  timeline: Clip[];
  recentDirectives: Directive[];
  queuedCount: number;
};
