import type { PromptDecisionMode } from "../shared/contracts.ts";

export type DecisionActivity = "proposal" | "vote" | "legacy";

export type DecisionPolicy = {
  soloMs: number;
  votingMs: number;
  newIdeaGraceMs: number;
};

function finiteMs(value: unknown, fallback: number, minimum: number) {
  const parsed = Number(value);
  return Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback);
}

export function decisionPolicyFromEnv(): DecisionPolicy {
  const legacyVotingBase = process.env.PUMPTV_VOTING_BASE_MS;
  const legacyVotingGuarantee = process.env.PUMPTV_VOTING_GUARANTEE_MS;
  return {
    soloMs: finiteMs(process.env.PUMPTV_SOLO_DECISION_MS, 20_000, 5_000),
    votingMs: finiteMs(
      process.env.PUMPTV_VOTING_WINDOW_MS ?? legacyVotingBase,
      20_000,
      8_000,
    ),
    newIdeaGraceMs: finiteMs(
      process.env.PUMPTV_VOTING_NEW_IDEA_GRACE_MS ?? legacyVotingGuarantee,
      10_000,
      5_000,
    ),
  };
}

export function nextDecisionDeadline(input: {
  now: number;
  previousDeadline: number;
  mode: PromptDecisionMode;
  firstArm: boolean;
  enteringVoting: boolean;
  activity: DecisionActivity;
  policy: DecisionPolicy;
}) {
  const {
    now,
    previousDeadline,
    mode,
    firstArm,
    enteringVoting,
    activity,
    policy,
  } = input;

  if (firstArm) {
    return now + (mode === "voting" ? policy.votingMs : policy.soloMs);
  }

  if (enteringVoting) {
    // The first challenger starts a fresh, full ballot. The existing solo
    // countdown is a latency-hiding window, not time that should be stolen
    // from a real vote.
    return Math.max(previousDeadline, now + policy.votingMs);
  }

  if (mode === "voting" && activity === "proposal") {
    // A genuinely new candidate arriving late must remain votable for a small
    // grace period. This can extend the deadline, but only proposal admission
    // can do it; moving votes never changes the clock.
    return Math.max(previousDeadline, now + policy.newIdeaGraceMs);
  }

  // Once a ballot is open, votes are information, not a timer-control surface.
  // Keeping the deadline stable makes the UI predictable and prevents activity
  // from creating surprising "locking" jumps.
  return previousDeadline;
}
