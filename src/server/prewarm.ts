import type {
  Clip,
  Directive,
  PromptRound,
  Resolution,
} from "../shared/contracts.ts";
import {
  CandidateContinuityError,
  commitRenderedClipCandidate,
  renderClipCandidate,
  type RenderedClipCandidate,
} from "./generate.ts";
import { prewarmMeasure } from "./observability.ts";
import {
  claimPrewarmSlot,
  clearPrewarmSlot,
  nextEpisode,
  releaseDirective,
  renewPrewarmSlot,
  setPrewarmStage,
} from "./repository.ts";
import {
  normalizedDirective,
  prewarmPolicyFromEnv,
  shouldStartPrewarm,
  speculativeDirectiveMatches,
  type PrewarmPolicy,
} from "./prewarm-policy.ts";

type PrewarmJob = {
  roundId: number;
  proposalId: number;
  episode: number;
  directiveText: string;
  startedAtMs: number;
  discarded: boolean;
  settled: boolean;
  candidate: RenderedClipCandidate | null;
  error: unknown | null;
  leaseHeartbeat: ReturnType<typeof setInterval> | null;
  promise: Promise<void>;
};

export type PrewarmPromotion =
  { kind: "none" } | { kind: "promoted"; clip: Clip } | { kind: "rejected" };

export class PrewarmController {
  readonly policy: PrewarmPolicy;
  private readonly owner: string;
  private job: PrewarmJob | null = null;
  private readonly attemptedRounds = new Set<number>();

  constructor(owner: string, policy = prewarmPolicyFromEnv()) {
    this.owner = owner;
    this.policy = policy;
  }

  private pruneAttemptedRounds(currentRoundId: number) {
    if (this.attemptedRounds.size < 64) return;
    for (const id of this.attemptedRounds) {
      if (id < currentRoundId - 16) this.attemptedRounds.delete(id);
    }
  }

  private matchesDirective(job: PrewarmJob, directive: Directive) {
    return speculativeDirectiveMatches({
      episode: job.episode,
      proposalId: job.proposalId,
      text: job.directiveText,
      directive,
    });
  }

  private async retire(
    job: PrewarmJob,
    reason: string,
    outcome: "discarded" | "promoted" = "discarded",
  ) {
    if (job.discarded) return;
    job.discarded = true;
    if (job.leaseHeartbeat) {
      clearInterval(job.leaseHeartbeat);
      job.leaseHeartbeat = null;
    }
    prewarmMeasure.measureSync(
      {
        start: () =>
          outcome === "promoted"
            ? "Retire promoted prewarm"
            : "Discard speculative render",
        end: (value) => value,
      },
      () => ({
        roundId: job.roundId,
        proposalId: job.proposalId,
        episode: job.episode + 1,
        stage: job.candidate ? "ready" : "in-flight",
        reason,
        outcome,
      }),
    );
    await clearPrewarmSlot(this.owner);
    if (job.settled && this.job === job) this.job = null;
  }

  async syncWithOpenRound(round: PromptRound | null) {
    const job = this.job;
    if (!job || job.discarded) return;
    if (!round || round.id !== job.roundId) {
      await this.retire(job, "proposal round changed before lock");
      return;
    }
    const proposal = round.proposals.find((item) => item.id === job.proposalId);
    if (!proposal) {
      await this.retire(job, "speculated proposal was removed");
      return;
    }
    if (
      normalizedDirective(proposal.text) !==
      normalizedDirective(job.directiveText)
    ) {
      await this.retire(job, "speculated proposal text changed");
    }
  }

  async maybeStart(input: {
    round: PromptRound | null;
    previousClip: Clip | null;
    resolution: Resolution;
    now: number;
  }) {
    if (!input.previousClip || !input.round || this.job) return false;
    if (!shouldStartPrewarm(input.round, input.now, this.policy)) return false;

    const episode = await nextEpisode();
    if (input.round.targetEpisode !== episode) return false;
    if (this.attemptedRounds.has(input.round.id)) return false;

    const leader = input.round.proposals[0];
    if (!leader) return false;

    const claimed = await claimPrewarmSlot({
      owner: this.owner,
      roundId: input.round.id,
      proposalId: leader.id,
      ttlMs: this.policy.leaseTtlMs,
    });
    if (!claimed) return false;

    this.attemptedRounds.add(input.round.id);
    this.pruneAttemptedRounds(input.round.id);

    const job: PrewarmJob = {
      roundId: input.round.id,
      proposalId: leader.id,
      episode,
      directiveText: leader.text,
      startedAtMs: Date.now(),
      discarded: false,
      settled: false,
      candidate: null,
      error: null,
      leaseHeartbeat: null,
      promise: Promise.resolve(),
    };
    this.job = job;

    job.leaseHeartbeat = setInterval(
      () => {
        void renewPrewarmSlot(this.owner, this.policy.leaseTtlMs)
          .then((stillOwned) => {
            if (!stillOwned && !job.discarded) {
              void this.retire(job, "prewarm lease lost").catch(() => {});
            }
          })
          .catch(() => {});
      },
      Math.max(1_000, Math.floor(this.policy.leaseTtlMs / 3)),
    );

    job.promise = prewarmMeasure
      .measure(
        {
          start: () =>
            `Prewarm EP ${episode + 1} · round ${job.roundId} · proposal #${job.proposalId}`,
          end: (candidate) => ({
            episode: candidate.episode + 1,
            proposalId: candidate.proposalId,
            requestId: candidate.clip.requestId,
            totalMs: candidate.clip.totalGenerationMs,
            discarded: job.discarded,
          }),
        },
        () =>
          renderClipCandidate({
            kind: "prewarm",
            episode,
            directive: leader.text,
            proposalId: leader.id,
            previousClip: input.previousClip,
            resolution: input.resolution,
            mode: "full",
            onStage: async (value) => {
              if (!job.discarded) await setPrewarmStage(this.owner, value);
            },
          }),
      )
      .then(async (candidate) => {
        if (job.discarded) return;
        job.candidate = candidate;
        await setPrewarmStage(this.owner, "ready");
      })
      .catch(async (error) => {
        job.error = error;
        prewarmMeasure.measureSync(
          "Prewarm failed; canonical path preserved",
          () => ({
            roundId: job.roundId,
            proposalId: job.proposalId,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        await this.retire(job, "speculative render failed");
      })
      .finally(() => {
        job.settled = true;
        if (job.discarded && this.job === job) this.job = null;
      });

    return true;
  }

  /**
   * Called after a directive exists but before claiming it for canonical work.
   * Returns true when the exact winning render is already in flight, so the
   * worker should keep ticking instead of issuing a duplicate provider request.
   */
  async shouldWaitForLockedDirective(directive: Directive | null) {
    const job = this.job;
    if (!directive || !job || job.discarded) return false;
    if (!this.matchesDirective(job, directive)) {
      await this.retire(
        job,
        "locked winner differs from speculative candidate",
      );
      return false;
    }
    return !job.candidate && !job.error;
  }

  async promoteIfReady(input: {
    episode: number;
    claimed: Directive;
  }): Promise<PrewarmPromotion> {
    const job = this.job;
    if (
      !job ||
      job.discarded ||
      !job.candidate ||
      !this.matchesDirective(job, input.claimed)
    ) {
      return { kind: "none" };
    }

    try {
      await setPrewarmStage(this.owner, "finalizing");
      const clip = await prewarmMeasure.measure(
        {
          start: () =>
            `Promote EP ${input.episode + 1} · proposal #${job.proposalId}`,
          end: (result) => ({
            episode: result.episode + 1,
            clipId: result.id,
            requestId: result.requestId,
            leadMs: Math.max(0, Date.now() - job.startedAtMs),
          }),
        },
        () =>
          commitRenderedClipCandidate({
            candidate: job.candidate!,
            directive: input.claimed,
          }),
      );
      await this.retire(job, "authoritative winner committed", "promoted");
      return { kind: "promoted", clip };
    } catch (error) {
      if (!(error instanceof CandidateContinuityError)) {
        await releaseDirective(input.claimed.id).catch(() => {});
        throw error;
      }

      prewarmMeasure.measureSync("Prewarm promotion rejected safely", () => ({
        proposalId: job.proposalId,
        reason: error.message,
      }));
      await releaseDirective(input.claimed.id);
      await this.retire(job, "candidate continuity changed before publish");
      return { kind: "rejected" };
    }
  }

  async stop(reason = "worker stopping") {
    if (this.job) await this.retire(this.job, reason);
  }

  stopSoon() {
    const job = this.job;
    if (!job) return;
    job.discarded = true;
    if (job.leaseHeartbeat) {
      clearInterval(job.leaseHeartbeat);
      job.leaseHeartbeat = null;
    }
    void clearPrewarmSlot(this.owner).catch(() => {});
  }
}
