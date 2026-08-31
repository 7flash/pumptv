import type { GenerationPauseKind } from "../shared/contracts.ts";

const FUNDS_RETRY_BASE_MS = Number(
  process.env.SLOP_FUNDS_RETRY_BASE_MS || 30_000,
);
const FUNDS_RETRY_MAX_MS = Number(
  process.env.SLOP_FUNDS_RETRY_MAX_MS || 15 * 60_000,
);
const PROVIDER_RETRY_BASE_MS = Number(
  process.env.SLOP_PROVIDER_RETRY_BASE_MS || 3_000,
);
const PROVIDER_RETRY_MAX_MS = Number(
  process.env.SLOP_PROVIDER_RETRY_MAX_MS || 60_000,
);

function errorParts(error: unknown, depth = 0): string[] {
  if (depth > 5 || error == null) return [];
  if (typeof error === "string") return [error];
  if (typeof error !== "object") return [String(error)];

  const value = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of [
    "message",
    "status",
    "statusCode",
    "code",
    "detail",
    "body",
    "response",
  ]) {
    const part = value[key];
    if (part == null) continue;
    if (typeof part === "string" || typeof part === "number")
      parts.push(`${key}:${part}`);
    else {
      try {
        parts.push(`${key}:${JSON.stringify(part)}`);
      } catch {}
    }
  }
  if ("cause" in value) parts.push(...errorParts(value.cause, depth + 1));
  return parts;
}

function retryDelay(base: number, max: number, failures: number) {
  const exponent = Math.max(0, Math.min(8, failures - 1));
  return Math.min(max, base * 2 ** exponent);
}

export function classifyGenerationFailure(
  error: unknown,
  failures: number,
): {
  kind: Exclude<GenerationPauseKind, "cooldown">;
  reason: string;
  retryAtMs: number;
} {
  const text = errorParts(error).join(" | ").replace(/\s+/g, " ").trim();
  const normalized = text.toLowerCase();
  const now = Date.now();

  if (
    /(^|\D)402(\D|$)|insufficient.{0,24}(credit|balance|fund)|credit.{0,24}(exhaust|insufficient|balance)|payment required|billing/.test(
      normalized,
    )
  ) {
    const delay = retryDelay(FUNDS_RETRY_BASE_MS, FUNDS_RETRY_MAX_MS, failures);
    return {
      kind: "funds",
      reason:
        "Generation paused because the fal credit balance appears insufficient. Existing episodes stay replayable and the worker will retry automatically after credits are restored.",
      retryAtMs: now + delay,
    };
  }

  if (/(^|\D)429(\D|$)|rate.?limit|too many requests|quota/.test(normalized)) {
    const delay = retryDelay(
      PROVIDER_RETRY_BASE_MS,
      PROVIDER_RETRY_MAX_MS,
      failures,
    );
    return {
      kind: "rate_limit",
      reason:
        "Generation is cooling down after a provider rate limit. Replays stay online while the worker retries automatically.",
      retryAtMs: now + delay,
    };
  }

  const delay = retryDelay(
    PROVIDER_RETRY_BASE_MS,
    PROVIDER_RETRY_MAX_MS,
    failures,
  );
  return {
    kind: "provider",
    reason: text
      ? `Generation provider hiccup: ${text.slice(0, 360)}. Existing episodes stay replayable while the worker retries.`
      : "Generation provider hiccup. Existing episodes stay replayable while the worker retries.",
    retryAtMs: now + delay,
  };
}
