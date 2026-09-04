import { createMeasure } from "measure-fn";
import type {
  LiveProgramState,
  PromptProposal,
  PromptRound,
} from "../shared/contracts.ts";

const participationMeasure = createMeasure("participation");

export type WinnerReward = {
  proposalId: number;
  chainId: number;
  asset: "USDG";
  tokenAddress: string | null;
  targetUsd: number;
  amountUsdG: number | null;
  status: "pending" | "sending" | "sent" | "uncertain" | "skipped";
  transactionHash: string | null;
  explorerUrl: string | null;
  lastError: string | null;
  claimedAtMs?: number | null;
  sentAtMs?: number | null;
};

export function winnerRewardStatusLabel(reward: WinnerReward | null) {
  if (!reward) return "QUEUED";
  if (reward.status === "sent") return "SENT";
  if (reward.status === "uncertain" || reward.status === "skipped")
    return "PAYMENT NEEDS ATTENTION";
  if (reward.status === "pending")
    return reward.lastError ? "PAYMENT DELAYED" : "QUEUED";
  if (reward.status === "sending")
    return reward.transactionHash ? "CONFIRMING" : "SENDING";
  return "QUEUED";
}

export type ParticipationState = {
  program: LiveProgramState | null;
  walletAddress: string | null;
  walletEthBalance: number;
  walletPower: number;
  walletScoreLoading: boolean;
  ideaSubmitting: boolean;
  votePendingId: number | null;
  participationError: string | null;
  winnerReward: WinnerReward | null;
  winnerNoticeProposalId: number | null;
  winnerNoticeDismissed: boolean;
};

type JsonRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

type ParticipationControllerOptions = {
  state: ParticipationState;
  json: JsonRequest;
  viewerId: () => string;
  proposalOwnerId: () => string;
  refreshStreamState: () => Promise<void>;
  shouldDismissComposerAfterSubmit?: () => boolean;
  onSubmitComplete?: () => void;
};

function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function createParticipationController(
  options: ParticipationControllerOptions,
) {
  const { state } = options;
  let ideaDraft = "";
  let ideaDraftDirty = false;
  let syncedOwnProposalSignature = "";
  let rewardPollAtMs = 0;

  function ownerKey() {
    return state.walletAddress
      ? `wallet:${state.walletAddress}`
      : `web:${options.proposalOwnerId()}`;
  }

  function currentRound(): PromptRound | null {
    return state.program?.votingRound || null;
  }

  function ownProposal(): PromptProposal | null {
    return (
      currentRound()?.proposals.find(
        (proposal) =>
          proposal.source === "web" && proposal.sourceId === ownerKey(),
      ) || null
    );
  }

  function normalizedIdea(value: string) {
    return value.replace(/\s+/g, " ").trim().slice(0, 500);
  }

  function draft() {
    return ideaDraft;
  }

  function setDraft(value: string) {
    ideaDraft = String(value || "").slice(0, 500);
    ideaDraftDirty = true;
  }

  function syncDraftFromBoard() {
    if (ideaDraftDirty) return;
    const own = ownProposal();
    const signature = own ? `${own.id}:${own.text}` : "";
    if (signature === syncedOwnProposalSignature) return;
    syncedOwnProposalSignature = signature;
    ideaDraft = own?.text || "";
  }

  function canSubmit() {
    if (state.ideaSubmitting) return false;
    if (
      state.program?.phase === "locked" ||
      state.program?.phase === "planning" ||
      state.program?.phase === "rendering" ||
      state.program?.phase === "finalizing"
    )
      return false;
    const text = normalizedIdea(ideaDraft);
    if (!text) return false;
    const own = ownProposal();
    if (own && currentRound()?.decisionMode === "voting") return false;
    return !own || normalizedIdea(own.text) !== text;
  }

  function syncFormState() {
    const enabled = canSubmit();
    document
      .querySelectorAll<HTMLButtonElement>('[data-action="submit-idea"]')
      .forEach((button) => {
        button.disabled = !enabled;
        button.setAttribute("aria-disabled", String(!enabled));
      });
  }

  async function refreshWalletScore() {
    if (!state.walletAddress || state.walletScoreLoading) return;
    const address = state.walletAddress;
    state.walletScoreLoading = true;
    state.participationError = null;
    try {
      const result = await participationMeasure.measure(
        {
          start: () =>
            `Refresh wallet score · ${address.slice(0, 6)}…${address.slice(-4)}`,
          end: (value) => ({
            chainId: value.chainId,
            ethBalance: value.ethBalance,
            power: value.power,
          }),
        },
        () =>
          options.json<{ ethBalance: number; power: number; chainId: number }>(
            "/api/wallet/score",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                viewerId: options.viewerId(),
                ownerId: options.proposalOwnerId(),
                walletAddress: address,
              }),
            },
          ),
      );
      if (state.walletAddress !== address) return;
      state.walletEthBalance = Number(result.ethBalance || 0);
      state.walletPower = Math.max(1, Number(result.power || 1));
      await options.refreshStreamState();
    } catch (cause) {
      if (state.walletAddress === address) {
        state.walletEthBalance = 0;
        state.walletPower = 1;
        state.participationError = errorText(
          cause,
          "Could not read Robinhood wallet",
        );
      }
    } finally {
      if (state.walletAddress === address) state.walletScoreLoading = false;
    }
  }

  async function refreshWinnerReward() {
    if (!state.walletAddress) return;
    const address = state.walletAddress;
    try {
      const payload = await participationMeasure.measure(
        {
          start: () =>
            `Refresh winner reward · ${address.slice(0, 6)}…${address.slice(-4)}`,
          end: (value) => ({
            proposalId: value.reward?.proposalId ?? null,
            status: value.reward?.status ?? null,
          }),
        },
        () =>
          options.json<{ reward: WinnerReward | null }>(
            `/api/rewards/mine?walletAddress=${encodeURIComponent(address)}`,
            { cache: "no-store" },
          ),
      );
      if (state.walletAddress !== address) return;
      state.winnerReward = payload.reward;
      if (!payload.reward) return;
      const recentSent =
        payload.reward.status !== "sent" ||
        !payload.reward.sentAtMs ||
        Date.now() - payload.reward.sentAtMs < 10 * 60_000;
      if (
        recentSent ||
        state.winnerNoticeProposalId === payload.reward.proposalId
      ) {
        state.winnerNoticeProposalId = payload.reward.proposalId;
        state.winnerNoticeDismissed =
          sessionStorage.getItem(
            `pumptv-reward-dismissed:${address}:${payload.reward.proposalId}`,
          ) === "1";
      }
    } catch {
      // Reward status is non-critical viewer metadata. The worker owns payment.
    }
  }

  function maybePollWinnerReward(now = Date.now()) {
    if (!state.walletAddress || now - rewardPollAtMs < 3_000) return;
    rewardPollAtMs = now;
    void refreshWinnerReward();
  }

  async function submitIdea() {
    if (state.ideaSubmitting) return false;
    const text = normalizedIdea(ideaDraft);
    if (!text) return false;

    state.ideaSubmitting = true;
    state.participationError = null;
    try {
      await participationMeasure.measure(
        {
          start: () => `Submit idea · ${text.slice(0, 72)}`,
          end: () => ({ chars: text.length }),
        },
        () =>
          options.json("/api/proposals", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              text,
              viewerId: options.viewerId(),
              ownerId: options.proposalOwnerId(),
              walletAddress: state.walletAddress,
            }),
          }),
      );
      ideaDraftDirty = false;
      syncedOwnProposalSignature = "";
      await options.refreshStreamState();
      if (options.shouldDismissComposerAfterSubmit?.())
        options.onSubmitComplete?.();
      return true;
    } catch (cause) {
      state.participationError = errorText(cause, "Could not save idea");
      return false;
    } finally {
      state.ideaSubmitting = false;
    }
  }

  async function cancelOwnIdea() {
    if (state.ideaSubmitting || !ownProposal()) return false;
    state.ideaSubmitting = true;
    state.participationError = null;
    try {
      await participationMeasure.measure("Withdraw own idea", () =>
        options.json("/api/proposals", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            viewerId: options.viewerId(),
            ownerId: options.proposalOwnerId(),
            walletAddress: state.walletAddress,
          }),
        }),
      );
      ideaDraft = "";
      ideaDraftDirty = false;
      syncedOwnProposalSignature = "";
      await options.refreshStreamState();
      return true;
    } catch (cause) {
      state.participationError = errorText(cause, "Could not cancel idea");
      return false;
    } finally {
      state.ideaSubmitting = false;
    }
  }

  async function voteForProposal(proposalId: number) {
    if (
      !Number.isSafeInteger(proposalId) ||
      proposalId <= 0 ||
      state.votePendingId
    )
      return false;

    state.votePendingId = proposalId;
    state.participationError = null;
    try {
      await participationMeasure.measure(
        {
          start: () => `Vote for proposal #${proposalId}`,
          end: () => ({ proposalId }),
        },
        () =>
          options.json("/api/votes", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              proposalId,
              viewerId: options.viewerId(),
              ownerId: options.proposalOwnerId(),
              walletAddress: state.walletAddress,
            }),
          }),
      );
      await options.refreshStreamState();
      return true;
    } catch (cause) {
      state.participationError = errorText(cause, "Could not vote");
      return false;
    } finally {
      state.votePendingId = null;
    }
  }

  function dismissWinnerNotice() {
    state.winnerNoticeDismissed = true;
    if (state.walletAddress && state.winnerNoticeProposalId)
      sessionStorage.setItem(
        `pumptv-reward-dismissed:${state.walletAddress}:${state.winnerNoticeProposalId}`,
        "1",
      );
  }

  return {
    ownerKey,
    currentRound,
    ownProposal,
    normalizedIdea,
    draft,
    setDraft,
    syncDraftFromBoard,
    canSubmit,
    syncFormState,
    refreshWalletScore,
    refreshWinnerReward,
    maybePollWinnerReward,
    submitIdea,
    cancelOwnIdea,
    voteForProposal,
    dismissWinnerNotice,
  };
}
