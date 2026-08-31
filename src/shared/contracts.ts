export type Resolution = "480P" | "768P";
export type DirectiveStatus = "queued" | "generating" | "used";
export type DirectiveSource = "web" | "pumpfun";
export type WorkerState = "idle" | "generating" | "error";
export type PumpChatState =
  "disabled" | "standby" | "connecting" | "live" | "error";
export type ProposalStatus = "open" | "selected" | "lost";
export type PromptRoundStatus = "open" | "closed";

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
  usedAnchorFrame: boolean;
  resolution: Resolution;
  startsAtMs: number;
  durationSeconds: number;
  showrunnerModel: string | null;
  showrunnerPlanJson: string | null;
  showrunnerInputTokens: number | null;
  showrunnerOutputTokens: number | null;
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
};

export type PromptRound = {
  id: number;
  targetEpisode: number;
  status: PromptRoundStatus;
  openedAtMs: number;
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

export type PumpfunChatStatus = {
  enabled: boolean;
  mint: string | null;
  prefix: string | null;
  votePrefix: string | null;
  state: PumpChatState;
  lastError: string | null;
};

export type RoomState = {
  name: string;
  running: boolean;
  resolution: Resolution;
  workerState: WorkerState;
  lastError: string | null;
  bufferedUntilMs: number | null;
  pumpfun: PumpfunChatStatus;
};

export type StreamState = {
  serverNowMs: number;
  room: RoomState;
  currentClip: Clip | null;
  nextClip: Clip | null;
  latestClip: Clip | null;
  currentDirective: Directive | null;
  nextDirective: Directive | null;
  timeline: Clip[];
  recentDirectives: Directive[];
  arena: PromptRound | null;
  worldState: WorldState | null;
  worldStateEpisode: number | null;
  queuedCount: number;
};
