export function rewardTokenUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount < 0)
    throw new Error("Reward amount must be a finite non-negative number");
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36)
    throw new Error("Token decimals must be an integer between 0 and 36");

  const text = amount.toFixed(Math.min(decimals, 12));
  const [whole = "0", fraction = ""] = text.split(".");
  const padded = `${fraction}${"0".repeat(decimals)}`.slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}

export function formatTokenUnits(value: bigint, decimals: number): number {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36)
    throw new Error("Token decimals must be an integer between 0 and 36");
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = value % scale;
  return Number(whole) + Number(fraction) / Number(scale);
}
