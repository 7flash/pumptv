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

  if (!room.workerOnline) {
    phase = "offline";
    reason = "Generation worker offline";
  } else if (room.generation.paused) {
    phase = room.generation.kind === "config" ? "setup" : "paused";
    reason = room.generation.reason || "Generation paused";
  } else if (nextClip) {
    phase = "ready";
  } else if (room.workerState === "generating") {
    phase = room.generationStage === "idle" ? "planning" : room.generationStage;
  } else if (nextDirective) {
    phase = "locked";
  } else if (countdownEndsAtMs) {
    phase = "voting";
  } else {
    phase = "idle";
  }

  return {
    phase,
    liveEpisode,
    targetEpisode,
    reason,
    countdownEndsAtMs,
    generationStartedAtMs: room.generationStartedAtMs,
    directive: nextDirective,
    decisionRound,
    votingRound,
  };
}
