import { describe, expect, test } from "bun:test";
import { formatTokenUnits, rewardTokenUnits } from "./reward-token.ts";

describe("USDG winner reward amount", () => {
  test("converts one dollar token amount using runtime decimals", () => {
    expect(rewardTokenUnits(1, 6)).toBe(1_000_000n);
    expect(formatTokenUnits(1_000_000n, 6)).toBe(1);
  });

  test("preserves fractional rewards", () => {
    expect(rewardTokenUnits(1.25, 6)).toBe(1_250_000n);
    expect(formatTokenUnits(1_250_000n, 6)).toBe(1.25);
  });
});
