import { describe, expect, test } from "bun:test";
import {
  normalizeEvmAddress,
  ROBINHOOD_MAINNET_CHAIN_ID,
} from "./evm-wallet.ts";

describe("Robinhood EVM wallet identity", () => {
  test("normalizes valid addresses", () => {
    expect(
      normalizeEvmAddress("0x000000000000000000000000000000000000dEaD"),
    ).toBe("0x000000000000000000000000000000000000dEaD");
  });

  test("rejects Solana/base58 addresses", () => {
    expect(
      normalizeEvmAddress("9xQeWvG816bUx9EPfEZ5Jt4C7X9uYH7QeVZLQzY"),
    ).toBeNull();
  });

  test("mainnet chain id is stable", () => {
    expect(ROBINHOOD_MAINNET_CHAIN_ID).toBe(4663);
  });
});
