import { describe, expect, test } from "bun:test";
import { participationCohortKey } from "./participant-identity.ts";

describe("participationCohortKey", () => {
  test("connected wallets remain independent behind the same IP", () => {
    expect(
      participationCohortKey({
        originIpHash: "same-ip",
        walletAddress: "wallet-a",
        subjectKey: "web:a",
      }),
    ).toBe("wallet:wallet-a");
    expect(
      participationCohortKey({
        originIpHash: "same-ip",
        walletAddress: "wallet-b",
        subjectKey: "web:b",
      }),
    ).toBe("wallet:wallet-b");
  });

  test("anonymous sessions on the same IP collapse into one cohort", () => {
    const first = participationCohortKey({
      originIpHash: "same-ip",
      walletAddress: null,
      subjectKey: "web:a",
    });
    const second = participationCohortKey({
      originIpHash: "same-ip",
      walletAddress: null,
      subjectKey: "web:b",
    });
    expect(first).toBe(second);
  });
});
