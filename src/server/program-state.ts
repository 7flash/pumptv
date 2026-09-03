import type {
  Clip,
  Directive,
  LiveProgramState,
  PromptRound,
  RoomState,
} from "../shared/contracts.ts";

export function deriveLiveProgramState(input: {
  room: RoomState;
  serverNowMs: number;
  publishedLatest: Clip | null;
  nextClip: Clip | null;
  nextDirective: Directive | null;
  promptRound: PromptRound | null;
  decisionRound: PromptRound | null;
}): LiveProgramState {
  const {
    room,
    serverNowMs,
    publishedLatest,
    nextClip,
    nextDirective,
    promptRound,
    decisionRound,
  } = input;

  const liveEpisode = publishedLatest?.episode ?? null;
  const targetEpisode =
    nextClip?.episode ??
    nextDirective?.usedEpisode ??
    decisionRound?.targetEpisode ??
    promptRound?.targetEpisode ??
    (publishedLatest ? publishedLatest.episode + 1 : 0);

  const votingRound = promptRound?.status === "open" ? promptRound : null;
  const countdownEndsAtMs =
    votingRound?.proposals.length &&
    votingRound.votingStartedAtMs &&
    votingRound.closesAtMs > serverNowMs
      ? votingRound.closesAtMs
      : null;

  let phase: LiveProgramState["phase"] = "idle";
  let reason: string | null = null;

  const prewarm = room.prewarm ?? {
    roundId: null,
    proposalId: null,
    stage: "idle" as const,
    startedAtMs: null,
  };
  const lockedPrewarmMatches = Boolean(
    nextDirective &&
    prewarm.proposalId != null &&
    nextDirective.proposalId === prewarm.proposalId &&
    prewarm.stage !== "idle",
  );

  if (!room.workerOnline) {
    phase = "offline";
    reason = "Generation worker offline";
  } else if (room.generation.paused) {
    phase = room.generation.kind === "config" ? "setup" : "paused";
    reason = room.generation.reason || "Generation paused";
  } else if (nextClip) {
    phase = "ready";
  } else if (countdownEndsAtMs) {
    // Speculative rendering is deliberately invisible to arbitration: the UI
    // stays in decision/voting mode until the server actually locks a winner.
    phase = votingRound?.decisionMode === "voting" ? "voting" : "deciding";
  } else if (room.workerState === "generating") {
    phase = room.generationStage === "idle" ? "planning" : room.generationStage;
  } else if (lockedPrewarmMatches) {
    phase = prewarm.stage === "ready" ? "finalizing" : prewarm.stage;
  } else if (nextDirective) {
    phase = "locked";
  } else {
    phase = "idle";
  }

  const effectiveGenerationStartedAtMs = lockedPrewarmMatches
    ? prewarm.startedAtMs
    : room.generationStartedAtMs;

  return {
    phase,
    liveEpisode,
    targetEpisode,
    reason,
    countdownEndsAtMs,
    generationStartedAtMs: effectiveGenerationStartedAtMs,
    directive: nextDirective,
    decisionRound,
    votingRound,
  };
}
