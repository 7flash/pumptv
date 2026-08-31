export type Resolution = "480P" | "768P";
export type DirectiveStatus = "queued" | "generating" | "used";
export type DirectiveSource = "web" | "pumpfun";
export type WorkerState = "idle" | "generating" | "error";
export type GenerationStage = "idle" | "planning" | "rendering" | "finalizing";
export type GenerationMode = "full" | "fast" | "emergency";
export type BufferHealthState = "healthy" | "tight" | "critical" | "empty";
export type PumpChatState =
  "disabled" | "standby" | "connecting" | "live" | "error";
export type ProposalStatus = "open" | "selected" | "lost";
export type PromptRoundStatus = "open" | "closed";
export type ReconciliationStatus =
  "verified" | "corrected" | "fallback" | "skipped";
export type GenerationPauseKind =
  "config" | "cooldown" | "funds" | "rate_limit" | "provider";

export type Clip = {
  id: number;
  requestId: string;
  videoUrl: string;
  expandedPrompt: string | null;
  h3Prompt: string | null;
  inferenceSeconds: number | null;
  directive: string;
  directiveId: number | null;
  episode: number;
  anchorFrameUrl: string | null;
  startFrameUrl: string | null;
  middleFrameUrl: string | null;
  endFrameUrl: string | null;
  usedAnchorFrame: boolean;
  resolution: Resolution;
  startsAtMs: number;
  durationSeconds: number;
  showrunnerModel: string | null;
  showrunnerPlanJson: string | null;
  showrunnerInputTokens: number | null;
  showrunnerOutputTokens: number | null;
  generationMode: GenerationMode;
  showrunnerMs: number | null;
  h3Ms: number | null;
  frameSampleMs: number | null;
  visionMs: number | null;
  totalGenerationMs: number | null;
  directiveSource: DirectiveSource | null;
  directiveAuthor: string | null;
  directiveAuthorAddress: string | null;
  directiveProposalId: number | null;
  directiveVoteCount: number | null;
};

export type Directive = {
  id: number;
  text: string;
  status: DirectiveStatus;
  usedEpisode: number | null;
  source: DirectiveSource;
  sourceId: string | null;
  author: string | null;
  authorAddress: string | null;
  sourceRoom: string | null;
  proposalId: number | null;
  voteCount: number | null;
};

export type PromptProposal = {
  id: number;
  roundId: number;
  text: string;
  status: ProposalStatus;
  source: DirectiveSource;
  sourceId: string | null;
  author: string | null;
  authorAddress: string | null;
  sourceRoom: string | null;
  voteCount: number;
  realVoteCount: number;
  operatorVoteOverride: number | null;
};

export type PromptRound = {
  id: number;
  targetEpisode: number;
  status: PromptRoundStatus;
  openedAtMs: number;
  votingStartedAtMs: number | null;
  closesAtMs: number;
  closedAtMs: number | null;
  winnerProposalId: number | null;
  proposals: PromptProposal[];
};

export type WorldCharacter = {
  id: string;
  name: string;
  appearance: string;
  wardrobe: string;
  status: string;
  position: string;
};

export type WorldProp = {
  id: string;
  name: string;
  description: string;
  status: string;
  position: string;
};

export type WorldState = {
  revision: number;
  location: string;
  locationDetails: string;
  characters: WorldCharacter[];
  props: WorldProp[];
  openThreads: string[];
  motifs: string[];
  visualRules: string[];
  lastEndingBeat: string;
};

export type WorldStateAudit = {
  episode: number;
  status: ReconciliationStatus;
  model: string | null;
  summary: string | null;
  drift: string[];
  sampledFrameUrls: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number | null;
};

export type GenerationTimingSample = {
  generationMode: GenerationMode;
  showrunnerMs: number | null;
  h3Ms: number | null;
  frameSampleMs: number | null;
  visionMs: number | null;
  totalGenerationMs: number | null;
};

export type BufferHealth = {
  mode: GenerationMode;
  recommendedMode: GenerationMode;
  health: BufferHealthState;
  bufferMs: number;
  targetBufferMs: number;
  minimumBufferMs: number;
  desiredClipsAhead: number;
  adaptiveLeadMs: number;
  sampleCount: number;
  p50TotalMs: number | null;
  p90TotalMs: number | null;
  p50H3Ms: number | null;
};

export type GenerationAvailability = {
  paused: boolean;
  kind: GenerationPauseKind | null;
  reason: string | null;
  retryAtMs: number | null;
  failureCount: number;
};

export type PumpfunChatStatus = {
  enabled: boolean;
  mint: string | null;
  prefix: string | null;
  state: PumpChatState;
  lastError: string | null;
};

export type ManagedWorkerStatus = {
  name: string;
  state: "unknown" | "starting" | "running" | "error";
  pid: number | null;
  error: string | null;
  checkedAtMs: number;
};

export type RoomState = {
  name: string;
  running: boolean;
  resolution: Resolution;
  workerState: WorkerState;
  workerOnline: boolean;
  workerHeartbeatAtMs: number | null;
  webOwnerPid: number | null;
  webHeartbeatAtMs: number | null;
  generationStage: GenerationStage;
  generationStartedAtMs: number | null;
  lastError: string | null;
  bufferedUntilMs: number | null;
  buffer: BufferHealth;
  pumpfun: PumpfunChatStatus;
  generation: GenerationAvailability;
  viewerCount: number;
  voteWindowMs: number;
  workerProcess: ManagedWorkerStatus;
};

export type LiveProgramPhase =
  | "setup"
  | "starting"
  | "offline"
  | "paused"
  | "idle"
  | "voting"
  | "locked"
  | "planning"
  | "rendering"
  | "finalizing"
  | "ready";

export type LiveProgramState = {
  phase: LiveProgramPhase;
  liveEpisode: number | null;
  targetEpisode: number;
  reason: string | null;
  countdownEndsAtMs: number | null;
  generationStartedAtMs: number | null;
  directive: Directive | null;
  decisionRound: PromptRound | null;
  votingRound: PromptRound | null;
};

export type StreamState = {
  serverNowMs: number;
  room: RoomState;
  currentClip: Clip | null;
  nextClip: Clip | null;
  latestClip: Clip | null;
  currentDirective: Directive | null;
  nextDirective: Directive | null;
  program: LiveProgramState;
  worldState: WorldState;
  timeline: Clip[];
  queuedCount: number;
};
