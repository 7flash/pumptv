const WEI_PER_ETH = 1_000_000_000_000_000_000n;
const USD_MICROS_PER_DOLLAR = 1_000_000n;
const CENTS_PER_DOLLAR = 100n;

export function rewardWeiForUsdCents(
  targetUsdCents: number,
  ethUsdMicros: number,
) {
  if (!Number.isSafeInteger(targetUsdCents) || targetUsdCents <= 0)
    throw new Error("Reward USD cents must be a positive integer");
  if (!Number.isSafeInteger(ethUsdMicros) || ethUsdMicros <= 0)
    throw new Error("ETH/USD quote must be positive micro-dollars");

  return (
    (BigInt(targetUsdCents) * WEI_PER_ETH * USD_MICROS_PER_DOLLAR) /
    (CENTS_PER_DOLLAR * BigInt(ethUsdMicros))
  );
}

export function ethUsdToMicros(value: unknown) {
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0)
    throw new Error("Invalid ETH/USD quote");
  const micros = Math.round(price * 1_000_000);
  if (!Number.isSafeInteger(micros) || micros <= 0)
    throw new Error("ETH/USD quote is outside the supported range");
  return micros;
}
