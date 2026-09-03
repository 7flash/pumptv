import { describe, expect, test } from "bun:test";
import { ethUsdToMicros, rewardWeiForUsdCents } from "./reward-amount.ts";

describe("Robinhood winner reward amount", () => {
  test("targets about one dollar in ETH", () => {
    const wei = rewardWeiForUsdCents(100, ethUsdToMicros(2500));
    expect(wei).toBe(400_000_000_000_000n); // 0.0004 ETH
  });

  test("uses integer arithmetic for fractional ETH prices", () => {
    const quote = ethUsdToMicros("2415.53");
    expect(quote).toBe(2_415_530_000);
    expect(rewardWeiForUsdCents(100, quote)).toBeGreaterThan(0n);
  });
});
