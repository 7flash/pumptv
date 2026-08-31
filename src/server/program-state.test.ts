import { describe, expect, test } from "bun:test";
import type { Directive, PromptRound, RoomState } from "../shared/contracts.ts";
import { deriveLiveProgramState } from "./program-state.ts";

const baseRoom = (): RoomState => ({
  name: "main",
  running: true,
  resolution: "480P",
  workerState: "idle",
  workerOnline: true,
  workerHeartbeatAtMs: 1,
  webOwnerPid: 1,
  webHeartbeatAtMs: 1,
  generationStage: "idle",
  generationStartedAtMs: null,
  lastError: null,
  bufferedUntilMs: null,
  buffer: {
    mode: "full",
    recommendedMode: "full",
    health: "empty",
    bufferMs: 0,
    targetBufferMs: 0,
    minimumBufferMs: 0,
    desiredClipsAhead: 0,
    adaptiveLeadMs: 0,
    sampleCount: 0,
    p50TotalMs: null,
    p90TotalMs: null,
    p50H3Ms: null,
  },
  pumpfun: {
    enabled: true,
    mint: "mint",
    prefix: "!next",
    state: "live",
    lastError: null,
  },
  generation: {
    paused: false,
    kind: null,
    reason: null,
    retryAtMs: null,
    failureCount: 0,
  },
  viewerCount: 1,
  voteWindowMs: 15_000,
  workerProcess: {
    name: "pumptv-worker",
    state: "running",
    pid: 2,
    error: null,
    checkedAtMs: 1,
  },
});

const round = (patch: Partial<PromptRound> = {}): PromptRound => ({
  id: 1,
  targetEpisode: 2,
  status: "open",
  openedAtMs: 100,
  votingStartedAtMs: 1_000,
  closesAtMs: 16_000,
  closedAtMs: null,
  winnerProposalId: null,
  proposals: [
    {
      id: 7,
      roundId: 1,
      text: "frog",
      status: "open",
      source: "pumpfun",
      sourceId: "x",
      author: "alice",
      authorAddress: "wallet",
      sourceRoom: "mint",
      voteCount: 3,
      realVoteCount: 3,
      operatorVoteOverride: null,
    },
  ],
  ...patch,
});

const directive: Directive = {
  id: 4,
  text: "frog",
  status: "queued",
  usedEpisode: 2,
  source: "pumpfun",
  sourceId: "x",
  author: "alice",
  authorAddress: "wallet",
  sourceRoom: "mint",
  proposalId: 7,
  voteCount: 3,
};

function derive(
  overrides: Partial<Parameters<typeof deriveLiveProgramState>[0]> = {},
) {
  return deriveLiveProgramState({
    room: baseRoom(),
    serverNowMs: 5_000,
    publishedLatest: null,
    nextClip: null,
    nextDirective: null,
    promptRound: null,
    decisionRound: null,
    ...overrides,
  });
}

describe("deriveLiveProgramState", () => {
  test("idle with no Pump.fun suggestions", () => {
    expect(derive().phase).toBe("idle");
  });

  test("voting once a proposal window is active", () => {
    const state = derive({ promptRound: round() });
    expect(state.phase).toBe("voting");
    expect(state.countdownEndsAtMs).toBe(16_000);
  });

  test("locked winner outranks the next future ballot", () => {
    const state = derive({
      nextDirective: directive,
      decisionRound: round({ status: "closed", winnerProposalId: 7 }),
      promptRound: round({ id: 2, targetEpisode: 3 }),
    });
    expect(state.phase).toBe("locked");
    expect(state.directive?.id).toBe(4);
    expect(state.votingRound?.targetEpisode).toBe(3);
  });

  test("generation stage is authoritative", () => {
    const room = baseRoom();
    room.workerState = "generating";
    room.generationStage = "rendering";
    room.generationStartedAtMs = 4_000;
    const state = derive({ room, nextDirective: directive });
    expect(state.phase).toBe("rendering");
    expect(state.generationStartedAtMs).toBe(4_000);
  });

  test("config pause is setup, not generic offline", () => {
    const room = baseRoom();
    room.generation = {
      paused: true,
      kind: "config",
      reason: "FAL_KEY is missing",
      retryAtMs: null,
      failureCount: 0,
    };
    expect(derive({ room }).phase).toBe("setup");
  });
});
