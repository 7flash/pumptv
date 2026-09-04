import { describe, expect, test } from "bun:test";
import { winnerRewardStatusLabel, type WinnerReward } from "./participation.ts";

function reward(overrides: Partial<WinnerReward> = {}): WinnerReward {
  return {
    proposalId: 1,
    chainId: 4663,
    asset: "ETH",
    targetUsd: 1,
    amountEth: null,
    quotedEthUsd: null,
    status: "pending",
    transactionHash: null,
    explorerUrl: null,
    lastError: null,
    ...overrides,
  };
}

describe("winner reward presentation", () => {
  test("distinguishes queued, sending and confirmation", () => {
    expect(winnerRewardStatusLabel(null)).toBe("QUEUED");
    expect(winnerRewardStatusLabel(reward())).toBe("QUEUED");
    expect(winnerRewardStatusLabel(reward({ status: "sending" }))).toBe(
      "SENDING",
    );
    expect(
      winnerRewardStatusLabel(
        reward({ status: "sending", transactionHash: "0xabc" }),
      ),
    ).toBe("CONFIRMING");
  });

  test("does not pretend failures are still sending", () => {
    expect(
      winnerRewardStatusLabel(reward({ lastError: "wallet needs funding" })),
    ).toBe("PAYMENT DELAYED");
    expect(winnerRewardStatusLabel(reward({ status: "uncertain" }))).toBe(
      "PAYMENT NEEDS ATTENTION",
    );
    expect(winnerRewardStatusLabel(reward({ status: "skipped" }))).toBe(
      "PAYMENT NEEDS ATTENTION",
    );
    expect(winnerRewardStatusLabel(reward({ status: "sent" }))).toBe("SENT");
  });
});
