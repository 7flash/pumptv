import { describe, expect, test } from "bun:test";
import type { PromptRound } from "../shared/contracts.ts";
import { shouldStartPrewarm, speculativeDirectiveMatches } from "./prewarm-policy.ts";

function round(overrides: Partial<PromptRound> = {}): PromptRound {
  return {
    id: 1,
    targetEpisode: 4,
    status: "open",
    openedAtMs: 1_000,
    votingStartedAtMs: 1_000,
    contestedAtMs: null,
    decisionMode: "solo",
    participantCount: 1,
    closesAtMs: 21_000,
    closedAtMs: null,
    winnerProposalId: null,
    proposals: [
      {
        id: 7,
        roundId: 1,
        text: "raccoon opens the glowing door",
        status: "open",
        source: "web",
        sourceId: "web:a",
        author: null,
        authorAddress: null,
        sourceRoom: "web",
        ownerWeight: 1,
        voteCount: 1,
        realVoteCount: 0,
        voterCount: 0,
        operatorVoteOverride: null,
      },
    ],
    ...overrides,
  };
}

const policy = {
  enabled: true,
  soloImmediate: true,
  votingLeadMs: 12_000,
};

describe("prewarm policy", () => {
  test("solo first idea can start immediately", () => {
    expect(shouldStartPrewarm(round(), 1_100, policy)).toBe(true);
  });

  test("contested round waits until the configured lead window", () => {
    const contested = round({
      decisionMode: "voting",
      participantCount: 2,
      closesAtMs: 30_000,
    });
    expect(shouldStartPrewarm(contested, 10_000, policy)).toBe(false);
    expect(shouldStartPrewarm(contested, 18_000, policy)).toBe(true);
  });

  test("never starts after the authoritative deadline", () => {
    expect(shouldStartPrewarm(round(), 21_000, policy)).toBe(false);
  });

  test("promotion requires the exact proposal and exact submitted text", () => {
    const directive = {
      id: 9,
      text: "raccoon opens the glowing door",
      status: "queued" as const,
      usedEpisode: null,
      source: "web" as const,
      sourceId: "trigger:auto:round:1:proposal:7",
      author: null,
      authorAddress: null,
      sourceRoom: "web",
      proposalId: 7,
      voteCount: 1,
    };
    expect(
      speculativeDirectiveMatches({
        episode: 4,
        proposalId: 7,
        text: "raccoon   opens the glowing door",
        directive,
      }),
    ).toBe(true);
    expect(
      speculativeDirectiveMatches({
        episode: 4,
        proposalId: 7,
        text: "raccoon closes the glowing door",
        directive,
      }),
    ).toBe(false);
  });
});
