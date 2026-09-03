import type { Directive, PromptRound } from "../shared/contracts.ts";

export type PrewarmPolicy = {
  enabled: boolean;
  soloImmediate: boolean;
  votingLeadMs: number;
  leaseTtlMs: number;
};

export function prewarmPolicyFromEnv(): PrewarmPolicy {
  return {
    enabled: process.env.PUMPTV_PREWARM_ENABLED !== "0",
    soloImmediate: process.env.PUMPTV_PREWARM_SOLO_IMMEDIATE !== "0",
    votingLeadMs: Math.max(
      2_000,
      Number(process.env.PUMPTV_PREWARM_VOTING_LEAD_MS || 12_000),
    ),
    leaseTtlMs: Math.max(
      10_000,
      Number(process.env.PUMPTV_PREWARM_LEASE_TTL_MS || 30_000),
    ),
  };
}

export function normalizedDirective(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function shouldStartPrewarm(
  round: PromptRound,
  now: number,
  policy: Pick<PrewarmPolicy, "enabled" | "soloImmediate" | "votingLeadMs">,
) {
  if (!policy.enabled || !round.proposals.length || round.closesAtMs <= now)
    return false;
  if (round.decisionMode === "solo") return policy.soloImmediate;
  if (round.decisionMode !== "voting") return false;
  return round.closesAtMs - now <= policy.votingLeadMs;
}

export function speculativeDirectiveMatches(input: {
  episode: number;
  proposalId: number;
  text: string;
  directive: Directive;
}) {
  return (
    (input.directive.usedEpisode == null ||
      input.episode === input.directive.usedEpisode) &&
    input.proposalId === input.directive.proposalId &&
    normalizedDirective(input.text) === normalizedDirective(input.directive.text)
  );
}
