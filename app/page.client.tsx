import { render } from "tradjs/client";
import { OutsideInterfaceStyles } from "./page.styles.tsx";
import { createMeasure } from "measure-fn";
import {
  createInvalidationQueue,
  createReactiveState,
} from "../src/client/signals.ts";
import {
  createMetaMaskController,
  normalizeEvmAddress,
  type WalletNetwork,
} from "../src/client/metamask.ts";
import type {
  Clip,
  Directive,
  LiveProgramState,
  PromptProposal,
  PromptRound,
  RoomState,
  StreamState,
  WorldState,
} from "../src/shared/contracts.ts";

const mediaMeasure = createMeasure("media");
const uiMeasure = createMeasure("ui");

function clientErrorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : String(error ?? "Unknown error");
}

let serverOffsetMs = 0;
let longPollAbort: AbortController | null = null;
let streamRevision = 0;
let viewerId = "";
let proposalOwnerId = "";
let initialCatchupPending = false;
const NEW_VIEWER_HISTORY_OFFSET = 7;
let timer: ReturnType<typeof setInterval> | null = null;

type WalletState = "idle" | "connecting" | "connected" | "error";

let ideaDraft = "";
let ideaDraftDirty = false;
let syncedOwnProposalSignature = "";
let rewardPollAtMs = 0;

type WinnerReward = {
  proposalId: number;
  chainId: number;
  asset: "ETH";
  targetUsd: number;
  amountEth: number | null;
  quotedEthUsd: number | null;
  status: "pending" | "sending" | "sent" | "uncertain" | "skipped";
  transactionHash: string | null;
  explorerUrl: string | null;
  lastError: string | null;
  claimedAtMs?: number | null;
  sentAtMs?: number | null;
};

type LiveSlotState = "playing" | "intermission" | "transitioning";

const viewSignals = createReactiveState({
  timeline: [] as Clip[],
  room: null as RoomState | null,
  nextDirective: null as Directive | null,
  program: null as LiveProgramState | null,
  worldState: null as WorldState | null,
  replayClipId: null as number | null,
  transport: "connecting" as "connecting" | "live" | "reconnecting",
  error: null as string | null,
  soundEnabled: false,
  captionsEnabled: true,
  liveOverlayEnabled: true,
  infoOpen: false,
  playbackPaused: false,
  pausedClipId: null as number | null,
  trayOpen: false,
  walletState: "idle" as WalletState,
  walletAddress: null as string | null,
  walletEthBalance: 0,
  walletPower: 1,
  walletScoreLoading: false,
  ideaSubmitting: false,
  votePendingId: null as number | null,
  participationError: null as string | null,
  worldDetailId: null as string | null,
  worldDetailKind: null as "location" | "character" | "prop" | null,
  winnerReward: null as WinnerReward | null,
  winnerNoticeProposalId: null as number | null,
  winnerNoticeDismissed: false,
  liveSlotState: "playing" as LiveSlotState,
  lastEndedLiveClipId: null as number | null,
});
const view = viewSignals.state;
const renderQueue = createInvalidationQueue((reasons) => renderApp(reasons));
const videoSyncQueue = createInvalidationQueue((reasons) => {
  mediaMeasure.measureSync(
    {
      start: () => `Sync video deck · ${reasons.join(", ")}`,
      end: (value) => value,
    },
    () => {
      syncVideoDeck();
      return {
        reasons,
        activeClipId: activeVideoClipId,
        desiredClipId: desiredClip()?.id ?? null,
        liveSlot: view.liveSlotState,
      };
    },
  );
});

viewSignals.subscribe((change) => {
  renderQueue.invalidate(`signal:${String(change.key)}`);
});
for (const key of [
  "timeline",
  "replayClipId",
  "playbackPaused",
  "pausedClipId",
  "liveSlotState",
  "soundEnabled",
] as const) {
  viewSignals.subscribeKey(key, () => {
    videoSyncQueue.invalidate(`signal:${key}`);
  });
}

function scheduleViewRender(reason: string) {
  renderQueue.invalidate(reason);
}

function scheduleVideoSync(reason: string) {
  videoSyncQueue.invalidate(reason);
}
function setLiveSlotState(
  next: LiveSlotState,
  reason: string,
  detail: Record<string, unknown> = {},
) {
  if (view.liveSlotState === next) {
    syncLocalUiState();
    return false;
  }
  const previous = view.liveSlotState;
  view.liveSlotState = next;
  mediaMeasure.measureSync(
    {
      start: () => `Live media ${previous} → ${next}`,
      end: (value) => value,
    },
    () => ({ reason, previous, next, ...detail }),
  );
  syncLocalUiState();
  return true;
}

let mediaDeck: HTMLDivElement | null = null;
let posterNode: HTMLImageElement | null = null;
let activeVideoSlot = 0;
let activeVideoClipId: number | null = null;
let switchSerial = 0;
let crossfade: {
  incomingClipId: number;
  incomingSlot: number;
  outgoingSlot: number;
  serial: number;
} | null = null;
let pendingActivation: { clipId: number; slot: number; serial: number } | null =
  null;
let mediaTargetObserver: ResizeObserver | null = null;
let observedGlass: HTMLElement | null = null;
let lastMediaRect = "";

// Cold refreshes get a one-time decoder prime on the hidden deck. The visible
// playback then starts on the other, fresh decoder. This deliberately mirrors
// the user workaround that makes playback smooth after switching away/back,
// without showing or rewinding the priming decoder.
let coldStartPrime: { clipId: number; promise: Promise<void> } | null = null;
let coldStartAttemptedClipId: number | null = null;

function liveNowMs() {
  return Date.now() + serverOffsetMs;
}

function publishedTimeline(now = liveNowMs()) {
  return view.timeline.filter((clip) => clip.startsAtMs <= now);
}

function latestPublishedClip() {
  const published = publishedTimeline();
  return published.length ? published[published.length - 1] : null;
}

function replayClip() {
  return view.replayClipId == null
    ? null
    : view.timeline.find((clip) => clip.id === view.replayClipId) || null;
}

function desiredClip() {
  if (view.playbackPaused && view.pausedClipId != null)
    return (
      view.timeline.find((clip) => clip.id === view.pausedClipId) ||
      replayClip() ||
      latestPublishedClip()
    );
  return replayClip() || latestPublishedClip();
}

function visibleClip() {
  return (
    (activeVideoClipId == null
      ? null
      : view.timeline.find((clip) => clip.id === activeVideoClipId)) ||
    desiredClip()
  );
}

function incomingLiveClipPending() {
  if (view.replayClipId != null || view.liveSlotState !== "intermission")
    return false;
  const latest = latestPublishedClip();
  return Boolean(latest && latest.id !== activeVideoClipId);
}

function enterLiveIntermission(reason: string) {
  if (view.replayClipId != null) return;
  if (activeVideoClipId != null) view.lastEndedLiveClipId = activeVideoClipId;
  setLiveSlotState("intermission", reason, {
    clipId: activeVideoClipId,
    endedClipId: view.lastEndedLiveClipId,
  });
  const active = videoNodes()[activeVideoSlot];
  if (active) {
    active.pause();
    active.muted = true;
  }
  // The browser owns the truth at an episode boundary. Refreshing here repairs
  // any long-poll snapshot that still describes the episode we just watched as
  // `ready`/`finalizing`, but the overlay no longer depends on this request.
  void refreshStreamState();
}

function reconcileLiveEdge() {
  if (
    view.replayClipId != null ||
    view.playbackPaused ||
    view.liveSlotState === "intermission"
  )
    return;
  const latest = latestPublishedClip();
  if (!latest || latest.id !== activeVideoClipId || clipAfter(latest)) return;
  const active = videoNodes()[activeVideoSlot];
  if (!active) return;
  const duration = Number.isFinite(active.duration)
    ? active.duration
    : latest.durationSeconds;
  const atEnd =
    active.ended ||
    (active.paused &&
      duration > 0 &&
      active.currentTime >= Math.max(0, duration - 0.12));
  if (atEnd)
    enterLiveIntermission(active.ended ? "media-ended" : "edge-reconciled");
}

function clipAfter(clip: Clip | null) {
  if (!clip) return null;
  const ordered =
    view.replayClipId == null ? view.timeline : publishedTimeline();
  const index = ordered.findIndex((candidate) => candidate.id === clip.id);
  return index >= 0 ? ordered[index + 1] || null : null;
}

function clipPoster(clip: Clip | null) {
  if (!clip) return "";
  return clip.startFrameUrl || clip.anchorFrameUrl || clip.endFrameUrl || "";
}

function createMediaDeck() {
  const deck = document.createElement("div");
  deck.className = "mediaDeck";

  const poster = document.createElement("img");
  poster.className = "tvPosterFallback";
  poster.alt = "";
  poster.decoding = "async";
  deck.appendChild(poster);
  posterNode = poster;

  for (let slot = 0; slot < 2; slot += 1) {
    const video = document.createElement("video");
    video.className = "tvVideoLayer";
    video.dataset.slot = String(slot);
    video.preload = "auto";
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.setAttribute("aria-hidden", "true");
    deck.appendChild(video);
  }

  return deck;
}

function positionMediaDeck() {
  if (!mediaDeck) return;
  const glass = document.querySelector(".tvGlass") as HTMLElement | null;
  if (!glass) {
    mediaDeck.style.visibility = "hidden";
    lastMediaRect = "";
    return;
  }
  const rect = glass.getBoundingClientRect();
  const nextRect = `${Math.round(rect.left * 10) / 10}:${Math.round(rect.top * 10) / 10}:${Math.round(rect.width * 10) / 10}:${Math.round(rect.height * 10) / 10}`;
  if (nextRect !== lastMediaRect) {
    mediaDeck.style.left = `${rect.left}px`;
    mediaDeck.style.top = `${rect.top}px`;
    mediaDeck.style.width = `${rect.width}px`;
    mediaDeck.style.height = `${rect.height}px`;
    lastMediaRect = nextRect;
  }
  mediaDeck.style.visibility =
    rect.width > 0 && rect.height > 0 ? "visible" : "hidden";
}

function observeMediaTarget() {
  const glass = document.querySelector(".tvGlass") as HTMLElement | null;
  if (glass === observedGlass) return;
  mediaTargetObserver?.disconnect();
  observedGlass = glass;
  if (!glass || typeof ResizeObserver === "undefined") {
    positionMediaDeck();
    return;
  }
  mediaTargetObserver = new ResizeObserver(() => positionMediaDeck());
  mediaTargetObserver.observe(glass);
  positionMediaDeck();
}

function ensureMediaDeck() {
  if (!mediaDeck) mediaDeck = createMediaDeck();
  const host = document.getElementById("pumptv-media-host");
  if (host && mediaDeck.parentElement !== host) host.appendChild(mediaDeck);
  positionMediaDeck();
  syncPoster();
  return mediaDeck;
}

function videoNodes() {
  const deck = ensureMediaDeck();
  return [0, 1].map(
    (slot) =>
      deck.querySelector(
        `video[data-slot="${slot}"]`,
      ) as HTMLVideoElement | null,
  );
}

function syncPoster() {
  if (!posterNode) return;
  const poster = clipPoster(visibleClip() || desiredClip());
  if (poster && posterNode.src !== poster) posterNode.src = poster;
  posterNode.style.opacity = poster ? "1" : "0";
}

function renderApp(reasons: readonly string[]) {
  const root = document.getElementById("pumptv-root");
  if (!root) return;

  uiMeasure.measureSync(
    {
      start: () => `Render UI · ${reasons.join(", ")}`,
      end: (value) => value,
    },
    () => {
      // TradJS owns only the application root. The persistent media deck stays
      // in its sibling host, so a reactive UI render never replaces a decoder.
      render(<App />, root);

      // DOM effects run after the synchronous TradJS commit. Layout-dependent
      // work is deferred to rAF; there is no generic "DOM is probably ready"
      // microtask anymore.
      ensureMediaDeck();
      observeMediaTarget();
      syncLocalPresentation();
      syncIdeaFormState();
      updateLiveMeters();

      const selectionRelevant = reasons.some(
        (reason) =>
          reason === "boot" ||
          reason === "media:presentation" ||
          reason === "signal:timeline" ||
          reason === "signal:replayClipId",
      );
      requestAnimationFrame(() => {
        positionMediaDeck();
        if (selectionRelevant) centerSelectedEpisode();
      });

      return {
        reasons,
        phase: view.program?.phase ?? null,
        timeline: view.timeline.length,
        liveSlot: view.liveSlotState,
      };
    },
  );
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok)
    throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload as T;
}

function applyState(state: StreamState) {
  serverOffsetMs = state.serverNowMs - Date.now();
  view.room = state.room;
  view.timeline = state.timeline;
  view.nextDirective = state.nextDirective;
  view.program = state.program;
  view.worldState = state.worldState;
  if (
    view.walletAddress &&
    state.program.directive?.proposalId &&
    state.program.directive.authorAddress?.toLowerCase() ===
      view.walletAddress.toLowerCase()
  ) {
    const proposalId = state.program.directive.proposalId;
    if (view.winnerNoticeProposalId !== proposalId) {
      view.winnerNoticeProposalId = proposalId;
      view.winnerNoticeDismissed =
        sessionStorage.getItem(
          `pumptv-reward-dismissed:${view.walletAddress}:${proposalId}`,
        ) === "1";
    }
    void refreshWinnerReward();
  }
  syncIdeaDraftFromBoard();

  if (initialCatchupPending) {
    const published = [...state.timeline]
      .filter((clip) => clip.startsAtMs <= state.serverNowMs)
      .sort((a, b) => a.episode - b.episode || a.id - b.id);
    if (published.length) {
      const targetIndex = Math.max(
        0,
        published.length - 1 - NEW_VIEWER_HISTORY_OFFSET,
      );
      const target = published[targetIndex] || published[0];
      const latest = published[published.length - 1];
      view.replayClipId =
        target && latest && target.id !== latest.id ? target.id : null;
      initialCatchupPending = false;
      localStorage.removeItem("pumptv-new-viewer-catchup");
    }
  }

  if (
    view.replayClipId != null &&
    !view.timeline.some((clip) => clip.id === view.replayClipId)
  )
    view.replayClipId = null;
  view.error = null;
}

function walletFromAddress(value: unknown) {
  const next = normalizeEvmAddress(value);
  if (view.walletAddress !== next) {
    view.winnerReward = null;
    view.winnerNoticeProposalId = null;
    view.winnerNoticeDismissed = false;
  }
  view.walletAddress = next;
  view.walletState = next ? "connected" : "idle";
}

let metamaskController: ReturnType<typeof createMetaMaskController> | null =
  null;

function getMetaMaskController() {
  if (metamaskController) return metamaskController;
  metamaskController = createMetaMaskController({
    loadNetwork: () =>
      json<{ network: WalletNetwork }>("/api/wallet/score", {
        cache: "no-store",
      }).then((payload) => payload.network),
    dapp: {
      name: "MEME TV",
      url: window.location.origin,
      iconUrl: new URL("/api/logo", window.location.href).href,
    },
    onAccountsChanged: (address) => {
      walletFromAddress(address);
      view.walletEthBalance = 0;
      view.walletPower = 1;
      if (view.walletAddress) {
        void refreshWalletScore();
        void refreshWinnerReward();
      }
    },
    onDisconnect: () => {
      walletFromAddress(null);
      view.walletEthBalance = 0;
      view.walletPower = 1;
    },
    onChainChanged: () => {
      if (view.walletAddress) void refreshWalletScore();
    },
  });
  return metamaskController;
}

async function connectMetaMask(interactive: boolean) {
  view.walletState = interactive ? "connecting" : view.walletState;
  if (interactive) view.participationError = null;
  try {
    const result = await getMetaMaskController().connect(interactive);
    walletFromAddress(result.address);
    if (view.walletAddress) {
      await refreshWalletScore();
      await refreshWinnerReward();
    }
    return Boolean(view.walletAddress);
  } catch (cause: any) {
    const rejected = Number(cause?.code) === 4001;
    if (interactive && !rejected) {
      view.walletState = "error";
      view.participationError =
        cause instanceof Error ? cause.message : "MetaMask connection failed";
    } else if (!view.walletAddress) {
      view.walletState = "idle";
    }
    return false;
  }
}

async function refreshStreamState() {
  try {
    applyState(await json<StreamState>("/api/state"));
  } catch {}
}

function ownerKey() {
  return view.walletAddress
    ? `wallet:${view.walletAddress}`
    : `web:${proposalOwnerId}`;
}

function currentBoardRound() {
  return view.program?.votingRound || null;
}

function ownProposal() {
  return (
    currentBoardRound()?.proposals.find(
      (proposal) =>
        proposal.source === "web" && proposal.sourceId === ownerKey(),
    ) || null
  );
}

function normalizedIdea(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function syncIdeaDraftFromBoard() {
  if (ideaDraftDirty) return;
  const own = ownProposal();
  const signature = own ? `${own.id}:${own.text}` : "";
  if (signature === syncedOwnProposalSignature) return;
  syncedOwnProposalSignature = signature;
  ideaDraft = own?.text || "";
}

function ideaCanSubmit() {
  if (view.ideaSubmitting) return false;
  if (
    view.program?.phase === "locked" ||
    view.program?.phase === "planning" ||
    view.program?.phase === "rendering" ||
    view.program?.phase === "finalizing"
  )
    return false;
  const text = normalizedIdea(ideaDraft);
  if (!text) return false;
  const own = ownProposal();
  if (own && currentBoardRound()?.decisionMode === "voting") return false;
  return !own || normalizedIdea(own.text) !== text;
}

function syncIdeaFormState() {
  const enabled = ideaCanSubmit();
  document
    .querySelectorAll<HTMLButtonElement>('[data-action="submit-idea"]')
    .forEach((button) => {
      button.disabled = !enabled;
      button.setAttribute("aria-disabled", String(!enabled));
    });
}

async function refreshWalletScore() {
  if (!view.walletAddress || view.walletScoreLoading) return;
  view.walletScoreLoading = true;
  view.participationError = null;
  try {
    const result = await json<{
      ethBalance: number;
      power: number;
      chainId: number;
    }>("/api/wallet/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        viewerId,
        ownerId: proposalOwnerId,
        walletAddress: view.walletAddress,
      }),
    });
    view.walletEthBalance = Number(result.ethBalance || 0);
    view.walletPower = Math.max(1, Number(result.power || 1));
    await refreshStreamState();
  } catch (cause) {
    view.walletEthBalance = 0;
    view.walletPower = 1;
    view.participationError =
      cause instanceof Error
        ? cause.message
        : "Could not read Robinhood wallet";
  } finally {
    view.walletScoreLoading = false;
  }
}

async function refreshWinnerReward() {
  if (!view.walletAddress) return;
  const address = view.walletAddress;
  try {
    const payload = await json<{ reward: WinnerReward | null }>(
      `/api/rewards/mine?walletAddress=${encodeURIComponent(address)}`,
      { cache: "no-store" },
    );
    if (view.walletAddress !== address) return;
    view.winnerReward = payload.reward;
    if (payload.reward) {
      const recentSent =
        payload.reward.status !== "sent" ||
        !payload.reward.sentAtMs ||
        Date.now() - payload.reward.sentAtMs < 10 * 60_000;
      if (
        recentSent ||
        view.winnerNoticeProposalId === payload.reward.proposalId
      ) {
        view.winnerNoticeProposalId = payload.reward.proposalId;
        view.winnerNoticeDismissed =
          sessionStorage.getItem(
            `pumptv-reward-dismissed:${address}:${payload.reward.proposalId}`,
          ) === "1";
      }
    }
  } catch {
    // Reward status is non-critical viewer metadata. The worker owns payment.
  }
}

async function submitIdea() {
  if (view.ideaSubmitting) return;
  const text = normalizedIdea(ideaDraft);
  if (!text) return;

  view.ideaSubmitting = true;
  view.participationError = null;
  try {
    await json("/api/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        viewerId,
        ownerId: proposalOwnerId,
        walletAddress: view.walletAddress,
      }),
    });
    ideaDraftDirty = false;
    syncedOwnProposalSignature = "";
    await refreshStreamState();
  } catch (cause) {
    view.participationError =
      cause instanceof Error ? cause.message : "Could not save idea";
  } finally {
    view.ideaSubmitting = false;
  }
}

async function cancelOwnIdea() {
  if (view.ideaSubmitting || !ownProposal()) return;
  view.ideaSubmitting = true;
  view.participationError = null;
  try {
    await json("/api/proposals", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        viewerId,
        ownerId: proposalOwnerId,
        walletAddress: view.walletAddress,
      }),
    });
    ideaDraft = "";
    ideaDraftDirty = false;
    syncedOwnProposalSignature = "";
    await refreshStreamState();
  } catch (cause) {
    view.participationError =
      cause instanceof Error ? cause.message : "Could not cancel idea";
  } finally {
    view.ideaSubmitting = false;
  }
}

async function voteForProposal(proposalId: number) {
  if (
    !Number.isSafeInteger(proposalId) ||
    proposalId <= 0 ||
    view.votePendingId
  )
    return;

  view.votePendingId = proposalId;
  view.participationError = null;
  try {
    await json("/api/votes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proposalId,
        viewerId,
        ownerId: proposalOwnerId,
        walletAddress: view.walletAddress,
      }),
    });
    await refreshStreamState();
  } catch (cause) {
    view.participationError =
      cause instanceof Error ? cause.message : "Could not vote";
  } finally {
    view.votePendingId = null;
  }
}

function shouldAutofocusIdea() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function")
    return false;
  return window.matchMedia("(min-width: 821px) and (pointer: fine)").matches;
}

function focusIdeaInputIfAppropriate() {
  if (!shouldAutofocusIdea()) return;
  queueMicrotask(() =>
    document.querySelector<HTMLInputElement>("[data-idea-input]")?.focus(),
  );
}

function toggleTray() {
  const opening = !view.trayOpen;
  view.trayOpen = opening;
  if (opening) focusIdeaInputIfAppropriate();
}

function openTray() {
  if (!view.trayOpen) {
    view.trayOpen = true;
    focusIdeaInputIfAppropriate();
  }
}

let richTooltipNode: HTMLDivElement | null = null;
let richTooltipTarget: HTMLElement | null = null;
let richTooltipInstalled = false;

function ensureRichTooltip() {
  if (richTooltipNode?.isConnected) return richTooltipNode;
  const node = document.createElement("div");
  node.className = "richHoverTooltip";
  node.setAttribute("role", "tooltip");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = `
    <img class="richTooltipImage" alt="" />
    <div class="richTooltipCopy">
      <strong class="richTooltipKicker"></strong>
      <div class="richTooltipBody"></div>
      <small class="richTooltipMeta"></small>
    </div>`;
  document.body.appendChild(node);
  richTooltipNode = node;
  return node;
}

function positionRichTooltip(target: HTMLElement) {
  const tooltip = ensureRichTooltip();
  const targetRect = target.getBoundingClientRect();
  const tipRect = tooltip.getBoundingClientRect();
  const gap = 12;
  const edge = 10;
  const preferred = target.dataset.tooltipSide || "auto";
  const canLeft = targetRect.left - gap - tipRect.width >= edge;
  const canRight =
    targetRect.right + gap + tipRect.width <= window.innerWidth - edge;
  const side =
    preferred === "left" && canLeft
      ? "left"
      : preferred === "right" && canRight
        ? "right"
        : canLeft
          ? "left"
          : canRight
            ? "right"
            : "above";

  let left = targetRect.left;
  let top = targetRect.top;
  if (side === "left") {
    left = targetRect.left - tipRect.width - gap;
    top = targetRect.top + targetRect.height / 2 - tipRect.height / 2;
  } else if (side === "right") {
    left = targetRect.right + gap;
    top = targetRect.top + targetRect.height / 2 - tipRect.height / 2;
  } else {
    left = targetRect.left + targetRect.width / 2 - tipRect.width / 2;
    top = targetRect.top - tipRect.height - gap;
    if (top < edge) {
      top = targetRect.bottom + gap;
      tooltip.dataset.side = "below";
    }
  }
  left = Math.max(
    edge,
    Math.min(window.innerWidth - tipRect.width - edge, left),
  );
  top = Math.max(
    edge,
    Math.min(window.innerHeight - tipRect.height - edge, top),
  );
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
  if (tooltip.dataset.side !== "below") tooltip.dataset.side = side;
}

function showRichTooltip(target: HTMLElement) {
  const tooltip = ensureRichTooltip();
  richTooltipTarget = target;
  const image = tooltip.querySelector<HTMLImageElement>(".richTooltipImage");
  const kicker = tooltip.querySelector<HTMLElement>(".richTooltipKicker");
  const body = tooltip.querySelector<HTMLElement>(".richTooltipBody");
  const meta = tooltip.querySelector<HTMLElement>(".richTooltipMeta");
  const imageUrl = target.dataset.tooltipImage || "";
  if (image) {
    image.src = imageUrl;
    image.style.display = imageUrl ? "block" : "none";
  }
  if (kicker) kicker.textContent = target.dataset.tooltipKicker || "";
  if (body) body.textContent = target.dataset.tooltipBody || "";
  if (meta) meta.textContent = target.dataset.tooltipMeta || "";
  tooltip.classList.toggle("hasImage", Boolean(imageUrl));
  tooltip.classList.add("visible");
  tooltip.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    if (richTooltipTarget === target && target.isConnected)
      positionRichTooltip(target);
  });
}

function hideRichTooltip(target?: HTMLElement | null) {
  if (target && richTooltipTarget && target !== richTooltipTarget) return;
  richTooltipTarget = null;
  const tooltip = richTooltipNode;
  if (!tooltip) return;
  tooltip.classList.remove("visible");
  tooltip.setAttribute("aria-hidden", "true");
}

function installRichTooltips() {
  if (richTooltipInstalled) return;
  richTooltipInstalled = true;
  const tooltipTarget = (value: EventTarget | null) =>
    value instanceof Element
      ? value.closest<HTMLElement>("[data-rich-tooltip]")
      : null;

  document.addEventListener("pointerover", (event) => {
    const target = tooltipTarget(event.target);
    if (target) showRichTooltip(target);
  });
  document.addEventListener("pointerout", (event) => {
    const target = tooltipTarget(event.target);
    if (!target) return;
    const related =
      event.relatedTarget instanceof Element ? event.relatedTarget : null;
    if (related && target.contains(related)) return;
    hideRichTooltip(target);
  });
  document.addEventListener("focusin", (event) => {
    const target = tooltipTarget(event.target);
    if (target) showRichTooltip(target);
  });
  document.addEventListener("focusout", (event) => {
    const target = tooltipTarget(event.target);
    if (target) hideRichTooltip(target);
  });
  window.addEventListener("resize", () => {
    if (richTooltipTarget?.isConnected) positionRichTooltip(richTooltipTarget);
    else hideRichTooltip();
  });
  window.addEventListener("scroll", () => hideRichTooltip(), true);
}

function readPref(key: string, fallback: boolean) {
  const value = localStorage.getItem(key);
  return value == null ? fallback : value === "1";
}

function writePref(key: string, value: boolean) {
  localStorage.setItem(key, value ? "1" : "0");
}

function syncLocalUiState() {
  const html = document.documentElement;
  html.dataset.pumptvSound = view.soundEnabled ? "on" : "off";
  html.dataset.pumptvCaptions = view.captionsEnabled ? "on" : "off";
  html.dataset.pumptvOverlay = view.liveOverlayEnabled ? "on" : "off";
  html.dataset.pumptvInfo = view.infoOpen ? "open" : "closed";
  html.dataset.pumptvPlayback = view.playbackPaused ? "paused" : "playing";
  html.dataset.pumptvMode = view.replayClipId == null ? "live" : "replay";
  html.dataset.pumptvSlot =
    view.replayClipId == null ? view.liveSlotState : "replay";
  mediaDeck?.classList.toggle(
    "intermission",
    view.replayClipId == null && view.liveSlotState === "intermission",
  );

  document
    .querySelectorAll<HTMLElement>("[data-control]")
    .forEach((control) => {
      const name = control.dataset.control;
      const active =
        name === "playback"
          ? !view.playbackPaused
          : name === "sound"
            ? view.soundEnabled
            : name === "captions"
              ? view.captionsEnabled
              : name === "overlay"
                ? view.liveOverlayEnabled
                : name === "info"
                  ? view.infoOpen
                  : false;
      control.classList.toggle("on", active);
      if (name !== "fullscreen")
        control.setAttribute("aria-pressed", String(active));
    });

  if (mediaDeck) {
    const nodes = Array.from(
      mediaDeck.querySelectorAll("video"),
    ) as HTMLVideoElement[];
    for (const video of nodes) {
      if (video.dataset.clipId === String(activeVideoClipId))
        video.muted = !view.soundEnabled;
      else video.muted = true;
    }
  }
}

function syncEpisodeSelection() {
  const desiredId = desiredClip()?.id ?? null;
  const liveId = latestPublishedClip()?.id ?? null;
  document
    .querySelectorAll<HTMLElement>(".episodeCard[data-episode-id]")
    .forEach((card) => {
      const id = Number(card.dataset.episodeId);
      card.classList.toggle("active", Number.isFinite(id) && id === desiredId);
      card.classList.toggle(
        "live",
        Number.isFinite(id) && id === liveId && view.replayClipId == null,
      );
    });
  const liveCap = document.querySelector<HTMLElement>(".liveCap");
  if (liveCap) liveCap.classList.toggle("active", view.replayClipId == null);
}

function syncCurrentPromptDom() {
  const clip = visibleClip();
  const prompt = document.querySelector<HTMLElement>("[data-current-prompt]");
  const text = document.querySelector<HTMLElement>(
    "[data-current-prompt-text]",
  );
  const author = document.querySelector<HTMLElement>(
    "[data-current-prompt-author]",
  );
  const fact = document.querySelector<HTMLElement>(
    "[data-current-prompt-fact]",
  );
  if (!prompt) return;
  if (clip) prompt.removeAttribute("data-empty");
  else prompt.setAttribute("data-empty", "");
  if (text) text.textContent = clip?.directive || "";
  if (author) author.textContent = clip ? clipAuthor(clip) : "";
  if (fact) fact.textContent = clipFactOverlay(clip);
  if (clip) {
    prompt.dataset.richTooltip = "1";
    prompt.dataset.tooltipKicker = `EP ${clip.episode + 1}`;
    prompt.dataset.tooltipBody = clip.directive || "";
    prompt.dataset.tooltipMeta = clipAuthor(clip);
  } else {
    delete prompt.dataset.richTooltip;
    delete prompt.dataset.tooltipKicker;
    delete prompt.dataset.tooltipBody;
    delete prompt.dataset.tooltipMeta;
  }
}

function syncLocalPresentation() {
  syncLocalUiState();
  syncEpisodeSelection();
  syncCurrentPromptDom();
}

function ensureViewerIdAndPrefs() {
  viewerId = localStorage.getItem("pumptv-viewer-id") || "";
  if (!viewerId) {
    viewerId = crypto.randomUUID();
    localStorage.setItem("pumptv-viewer-id", viewerId);
    localStorage.setItem("pumptv-new-viewer-catchup", "1");
  }
  initialCatchupPending =
    localStorage.getItem("pumptv-new-viewer-catchup") === "1";

  // Anonymous proposal ownership is session-scoped rather than tied to viewer
  // presence. Separate tabs/browsers can therefore each keep one persistent
  // idea without silently editing each other's proposal. It survives refreshes
  // in the same tab through sessionStorage.
  proposalOwnerId = sessionStorage.getItem("pumptv-proposal-owner-id") || "";
  if (!proposalOwnerId) {
    proposalOwnerId = crypto.randomUUID();
    sessionStorage.setItem("pumptv-proposal-owner-id", proposalOwnerId);
  }

  view.soundEnabled = readPref("pumptv-v25-sound", false);
  view.captionsEnabled = readPref("pumptv-v25-captions", true);
  view.liveOverlayEnabled = readPref("pumptv-v25-live-overlay", true);
}

async function runStateLongPoll() {
  longPollAbort?.abort();
  const controller = new AbortController();
  longPollAbort = controller;
  let retryMs = 850;

  while (!controller.signal.aborted) {
    try {
      const response = await fetch(
        `/api/events?viewerId=${encodeURIComponent(viewerId)}&since=${streamRevision}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!response.ok)
        throw new Error(`State poll failed: ${response.status}`);
      const payload = (await response.json()) as {
        revision?: number;
        state?: StreamState | null;
      };
      if (Number.isSafeInteger(payload.revision))
        streamRevision = Number(payload.revision);
      if (payload.state) applyState(payload.state);
      else view.error = null;
      retryMs = 850;
      if (view.transport !== "live") {
        view.transport = "live";
      }
    } catch (cause) {
      if (controller.signal.aborted) break;
      view.transport = "reconnecting";
      view.error =
        cause instanceof Error ? cause.message : "state reconnecting";
      const jitter = Math.floor(Math.random() * Math.min(500, retryMs / 3));
      await new Promise((resolve) => setTimeout(resolve, retryMs + jitter));
      retryMs = Math.min(8_000, Math.round(retryMs * 1.7));
    }
  }
}

async function boot() {
  ensureViewerIdAndPrefs();
  installInteractionLayer();
  installRichTooltips();
  syncLocalUiState();
  scheduleViewRender("boot");
  void connectMetaMask(false);
  try {
    applyState(await json<StreamState>("/api/state"));
    view.transport = "live";
  } catch (cause) {
    view.error = cause instanceof Error ? cause.message : "offline";
  }

  void runStateLongPoll();

  timer = setInterval(() => {
    syncVideoDeck();
    reconcileLiveEdge();
    updateLiveMeters();
    if (view.walletAddress && Date.now() - rewardPollAtMs >= 3_000) {
      rewardPollAtMs = Date.now();
      void refreshWinnerReward();
    }
  }, 100);
}

function attachVideoSource(video: HTMLVideoElement, clip: Clip, slot: number) {
  video.src = clip.videoUrl;
  video.oncanplay = () => {
    if (video.dataset.clipId !== String(clip.id)) return;
    video.dataset.ready = "1";
    syncVideoDeck();
  };
  video.onloadeddata = () => {
    if (video.dataset.clipId !== String(clip.id)) return;
    video.dataset.ready = "1";
    syncVideoDeck();
  };
  video.onended = () => handleDeckEnded(slot, clip.id);
  video.load();
}

function configureVideo(video: HTMLVideoElement, clip: Clip, slot: number) {
  if (video.dataset.clipId === String(clip.id) && video.src) return;

  video.pause();
  video.classList.remove("active", "retiring", "entering", "reveal");
  video.setAttribute("aria-hidden", "true");
  video.dataset.clipId = String(clip.id);
  video.dataset.ready = "0";
  video.dataset.resumePending = "0";
  video.preload = "auto";
  video.playsInline = true;
  video.muted = true;
  video.poster = clipPoster(clip);
  video.removeAttribute("src");
  video.load();
  attachVideoSource(video, clip, slot);
}

function bufferedFromStart(video: HTMLVideoElement) {
  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);
    if (start <= 0.08) return Math.max(0, end);
  }
  return 0;
}

async function waitForColdRunway(
  video: HTMLVideoElement,
  clipId: number,
  timeoutMs = 4_000,
) {
  const startedAt = performance.now();
  while (video.dataset.clipId === String(clipId)) {
    const duration = Number.isFinite(video.duration) ? video.duration : 5;
    const goal = Math.min(2.25, Math.max(0.75, duration - 0.2));
    if (
      video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
      bufferedFromStart(video) >= goal
    )
      return;
    if (performance.now() - startedAt >= timeoutMs) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
  }
}

async function waitForPrimedFrames(video: HTMLVideoElement, count = 3) {
  const callback = (video as any).requestVideoFrameCallback;
  if (typeof callback !== "function") {
    const startedAt = performance.now();
    while (
      video.currentTime < 0.12 &&
      performance.now() - startedAt < 650 &&
      !video.paused
    )
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    return;
  }

  await new Promise<void>((resolve) => {
    let frames = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const next = () => {
      if (settled) return;
      frames += 1;
      if (frames >= count) finish();
      else callback.call(video, next);
    };
    const timeout = setTimeout(finish, 900);
    callback.call(video, next);
  });
}

async function primeColdLiveClip(
  clip: Clip,
  nodes: Array<HTMLVideoElement | null>,
) {
  const warmSlot = activeVideoSlot;
  const playbackSlot = 1 - warmSlot;
  const warm = nodes[warmSlot];
  const playback = nodes[playbackSlot];
  if (!warm || !playback) return;

  configureVideo(warm, clip, warmSlot);
  await waitForColdRunway(warm, clip.id);
  if (
    desiredClip()?.id !== clip.id ||
    view.replayClipId != null ||
    activeVideoClipId != null
  )
    return;

  try {
    warm.currentTime = 0;
  } catch {}
  warm.muted = true;
  try {
    await warm.play();
    await waitForPrimedFrames(warm);
  } catch {}
  warm.pause();
  warm.muted = true;

  if (
    desiredClip()?.id !== clip.id ||
    view.replayClipId != null ||
    activeVideoClipId != null
  )
    return;

  // Use a fresh decoder for what the viewer actually sees. The first decoder
  // has already warmed the browser's media/network path, but none of its
  // playback state is reused.
  configureVideo(playback, clip, playbackSlot);
  await waitForColdRunway(playback, clip.id, 2_500);
  if (
    desiredClip()?.id !== clip.id ||
    view.replayClipId != null ||
    activeVideoClipId != null
  )
    return;

  try {
    playback.currentTime = 0;
  } catch {}
  const serial = ++switchSerial;
  pendingActivation = { clipId: clip.id, slot: playbackSlot, serial };
  try {
    await activateVideoSlot(playbackSlot, clip, playback, nodes, serial);
  } finally {
    if (pendingActivation?.serial === serial) pendingActivation = null;
  }
}

function startColdLivePrime(clip: Clip, nodes: Array<HTMLVideoElement | null>) {
  if (coldStartPrime?.clipId === clip.id) return;
  const promise = primeColdLiveClip(clip, nodes)
    .catch((cause) => {
      mediaMeasure.measureSync("Cold decoder prime failed", () => ({
        episode: clip.episode + 1,
        error: clientErrorText(cause),
      }));
    })
    .finally(() => {
      if (coldStartPrime?.promise === promise) coldStartPrime = null;
      syncVideoDeck();
    });
  coldStartPrime = { clipId: clip.id, promise };
}

function targetTimeFor(_clip: Clip) {
  // Publication decides which episode is live. Playback always reveals a newly
  // selected/published episode from frame 0 so transitions never jump into the
  // middle of a clip.
  return 0;
}

async function waitForPaint(video: HTMLVideoElement) {
  await mediaMeasure.measure(
    {
      start: () => "Wait for first presented video frame",
      end: (result) => result,
    },
    () =>
      new Promise<{ via: string; readyState: number; currentTime: number }>(
        (resolve, reject) => {
          let settled = false;
          const startedAtTime = Number(video.currentTime || 0);
          const callback = (video as any).requestVideoFrameCallback;
          let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
          let hardTimer: ReturnType<typeof setTimeout> | null = null;

          const cleanup = () => {
            if (fallbackTimer) clearTimeout(fallbackTimer);
            if (hardTimer) clearTimeout(hardTimer);
            video.removeEventListener("playing", onPlaying);
            video.removeEventListener("timeupdate", onTimeUpdate);
            video.removeEventListener("error", onError);
          };
          const finish = (via: string) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({
              via,
              readyState: video.readyState,
              currentTime: Number(video.currentTime || 0),
            });
          };
          const fail = (message: string) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error(message));
          };
          const afterPaintTurn = (via: string) => {
            requestAnimationFrame(() =>
              requestAnimationFrame(() => finish(via)),
            );
          };
          const usable = () =>
            !video.paused &&
            !video.ended &&
            video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
          const onPlaying = () => {
            if (usable()) afterPaintTurn("playing");
          };
          const onTimeUpdate = () => {
            if (
              usable() &&
              Number(video.currentTime || 0) > startedAtTime + 0.01
            )
              afterPaintTurn("timeupdate");
          };
          const onError = () =>
            fail("video failed before its first frame was available");

          video.addEventListener("playing", onPlaying);
          video.addEventListener("timeupdate", onTimeUpdate);
          video.addEventListener("error", onError, { once: true });

          if (typeof callback === "function") {
            try {
              callback.call(video, () => finish("video-frame-callback"));
            } catch {}
          }

          // `play()` has already resolved before this function is called. Some
          // WebKit/Chromium builds nevertheless delay rVFC on hidden/entering
          // layers. If the media is demonstrably playing with current data,
          // two compositor turns are a stronger signal than waiting five
          // seconds and retrying the entire activation.
          fallbackTimer = setTimeout(() => {
            if (usable()) afterPaintTurn("playing-ready-fallback");
          }, 180);

          hardTimer = setTimeout(
            () => fail("timed out waiting for usable video playback"),
            8_000,
          );

          if (usable()) afterPaintTurn("already-playing");
        },
      ),
  );
}

function waitForOpacityTransition(video: HTMLVideoElement) {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      video.removeEventListener("transitionend", onEnd);
      resolve();
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.propertyName === "opacity") finish();
    };
    const fallback = setTimeout(finish, 900);
    video.addEventListener("transitionend", onEnd);
  });
}

async function activateVideoSlot(
  slot: number,
  clip: Clip,
  video: HTMLVideoElement,
  nodes: Array<HTMLVideoElement | null>,
  serial: number,
) {
  if (
    slot === activeVideoSlot &&
    activeVideoClipId === clip.id &&
    video.classList.contains("active")
  ) {
    // Once the latest live episode has ended, keep its final painted frame
    // parked beneath the intermission surface. Do not restart it just because
    // the 100ms media synchronizer runs again.
    const parkedAtLiveEdge =
      view.replayClipId == null && view.liveSlotState === "intermission";
    if (view.playbackPaused) {
      if (!video.paused) video.pause();
      return;
    }
    if (
      !parkedAtLiveEdge &&
      video.paused &&
      !video.ended &&
      video.dataset.resumePending !== "1"
    ) {
      // Resume muted first. A browser can pause a video when an async deck
      // switch loses its user-activation token; retrying audibly here just
      // repeats the autoplay rejection forever.
      video.dataset.resumePending = "1";
      video.muted = true;
      void video
        .play()
        .then(() => {
          video.dataset.resumePending = "0";
          if (activeVideoClipId === clip.id) video.muted = !view.soundEnabled;
        })
        .catch(() => {
          video.dataset.resumePending = "0";
        });
    } else if (!video.paused) {
      video.muted = !view.soundEnabled;
    }
    return;
  }

  const previous = activeVideoClipId == null ? null : nodes[activeVideoSlot];

  try {
    video.currentTime = targetTimeFor(clip);
  } catch {}

  // Always start an incoming deck muted. `canplay`/`loadeddata` fires after the
  // original episode-card click, so attempting the first play unmuted can be
  // rejected by browser autoplay policy even though the user initiated the
  // switch. Once playback is actually running and a frame has painted we apply
  // the user's sound preference to the now-active deck.
  video.muted = true;

  try {
    // Keep an intermission/loading surface mounted until the browser has
    // actually presented a frame. Cold-start activation used to switch the UI
    // to `transitioning` before `play()`/paint, creating a dead-looking gap.
    // Cold refreshes arrive here only after configureVideo has fully prefetched
    // the first clip. Do not play a hidden video and rewind it: that path left
    // Chromium's decoder in a visibly stuttery state on first reveal.
    await video.play();
    await waitForPaint(video);
  } catch (cause) {
    mediaMeasure.measureSync("Video activation failed", () => ({
      episode: clip.episode + 1,
      error: clientErrorText(cause),
      mediaCode: video.error?.code ?? null,
      mediaMessage: video.error?.message ?? null,
    }));
    // Keep the requested episode selected and retry from the media synchronizer
    // instead of silently falling back to the previous clip.
    video.dataset.ready =
      video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
        ? "1"
        : video.dataset.ready;
    return;
  }

  if (serial !== switchSerial || desiredClip()?.id !== clip.id) {
    if (activeVideoClipId !== clip.id) {
      video.pause();
      video.muted = true;
    }
    return;
  }

  const revealingFromIntermission =
    view.replayClipId == null && view.liveSlotState === "intermission";
  if (view.replayClipId == null) {
    setLiveSlotState(
      revealingFromIntermission ? "transitioning" : "playing",
      revealingFromIntermission ? "incoming-first-frame" : "video-first-frame",
      { clipId: clip.id },
    );
  }

  const changed = activeVideoClipId !== clip.id;
  const outgoingSlot = activeVideoSlot;

  // Reserve both decks for the entire visual transition. Until the incoming
  // video is fully opaque, the outgoing deck is still part of the picture and
  // MUST NOT be reused by the preloader. Reusing it early was the intermittent
  // black/poster blink between otherwise identical episode pairs.
  crossfade =
    previous && previous !== video
      ? { incomingClipId: clip.id, incomingSlot: slot, outgoingSlot, serial }
      : null;

  video.classList.remove("retiring", "reveal");
  video.classList.add("active", "entering");
  video.setAttribute("aria-hidden", "false");
  video.muted = !view.soundEnabled;

  if (previous && previous !== video) {
    previous.classList.add("retiring");
    previous.muted = true;
  }

  activeVideoSlot = slot;
  activeVideoClipId = clip.id;
  if (view.replayClipId == null) view.lastEndedLiveClipId = null;
  syncPoster();
  if (changed) syncLocalPresentation();
  scheduleViewRender("media:presentation");
  // `program.phase` can change before or after media readiness. Re-render at
  // the exact presentation boundary so LOADING cannot survive over a video
  // whose first frame is already on screen.

  if (previous && previous !== video) {
    // Force the entering deck's opacity:0 state to become a committed style,
    // then reveal on the next animation frame. This prevents the browser from
    // coalescing setup + reveal into a single paint.
    void video.offsetWidth;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => {
        video.classList.add("reveal");
        resolve();
      }),
    );
    await waitForOpacityTransition(video);

    if (crossfade?.serial === serial && crossfade.incomingClipId === clip.id) {
      video.classList.remove("entering", "reveal");
      previous.classList.remove("active", "retiring", "entering", "reveal");
      previous.setAttribute("aria-hidden", "true");
      previous.pause();
      previous.muted = true;
      crossfade = null;

      if (
        view.replayClipId == null &&
        view.liveSlotState === "transitioning" &&
        !video.ended
      ) {
        setLiveSlotState("playing", "crossfade-complete", { clipId: clip.id });
      }
    }
  } else {
    video.classList.remove("entering", "reveal");
  }

  scheduleVideoSync("crossfade-settled");
}

function syncVideoDeck() {
  const wanted = desiredClip();
  const nodes = videoNodes();
  if (!nodes[0] || !nodes[1]) return;

  if (
    wanted &&
    activeVideoClipId == null &&
    view.replayClipId == null &&
    !view.playbackPaused
  ) {
    if (coldStartPrime?.clipId === wanted.id) return;
    if (coldStartAttemptedClipId !== wanted.id) {
      coldStartAttemptedClipId = wanted.id;
      startColdLivePrime(wanted, nodes);
      return;
    }
  }

  if (!wanted) {
    for (const video of nodes) {
      if (!video) continue;
      video.pause();
      video.classList.remove("active", "retiring");
      video.muted = true;
    }
    activeVideoClipId = null;
    crossfade = null;
    pendingActivation = null;
    if (view.replayClipId == null) {
      setLiveSlotState("intermission", "no-live-clip");
    }
    syncPoster();
    return;
  }

  let wantedSlot = nodes.findIndex(
    (video) => video?.dataset.clipId === String(wanted.id),
  );
  if (wantedSlot < 0) {
    wantedSlot =
      activeVideoClipId == null ? activeVideoSlot : 1 - activeVideoSlot;
    const target = nodes[wantedSlot];
    if (target) configureVideo(target, wanted, wantedSlot);
  }

  const wantedVideo = nodes[wantedSlot];
  if (wantedVideo) {
    const ready =
      wantedVideo.dataset.ready === "1" ||
      wantedVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
    if (ready) {
      const alreadyActive =
        wantedSlot === activeVideoSlot &&
        activeVideoClipId === wanted.id &&
        wantedVideo.classList.contains("active");
      if (alreadyActive) {
        // The active-deck path is synchronous until its first return and is safe
        // to run from the media heartbeat for pause/resume maintenance.
        void activateVideoSlot(
          wantedSlot,
          wanted,
          wantedVideo,
          nodes,
          switchSerial,
        );
      } else {
        const sameActivationPending =
          pendingActivation?.clipId === wanted.id &&
          pendingActivation.slot === wantedSlot;
        if (!sameActivationPending) {
          const serial = ++switchSerial;
          pendingActivation = { clipId: wanted.id, slot: wantedSlot, serial };
          void activateVideoSlot(
            wantedSlot,
            wanted,
            wantedVideo,
            nodes,
            serial,
          ).finally(() => {
            if (pendingActivation?.serial === serial) pendingActivation = null;
          });
        }
      }
    }
  }

  // Never preload into the inactive deck while a requested clip is still
  // switching in. That deck belongs exclusively to `wanted` until activation
  // commits. Once `wanted` is active, the other deck may safely preload the
  // episode that follows `wanted`.
  if (
    activeVideoClipId === wanted.id &&
    crossfade == null &&
    pendingActivation == null
  ) {
    const preload = clipAfter(wanted);
    if (preload && preload.id !== wanted.id) {
      const preloadSlot = 1 - activeVideoSlot;
      const preloadVideo = nodes[preloadSlot];
      if (preloadVideo && preloadVideo.dataset.clipId !== String(preload.id))
        configureVideo(preloadVideo, preload, preloadSlot);
    }
  }

  const active = nodes[activeVideoSlot];
  if (active && activeVideoClipId === wanted.id)
    active.muted = !view.soundEnabled;
}

function primeDesiredPlaybackFromGesture() {
  const wanted = desiredClip();
  if (!wanted) return;
  const nodes = videoNodes();
  if (!nodes[0] || !nodes[1]) return;

  let slot = nodes.findIndex(
    (video) => video?.dataset.clipId === String(wanted.id),
  );
  if (slot < 0) {
    slot = activeVideoClipId == null ? activeVideoSlot : 1 - activeVideoSlot;
    const target = nodes[slot];
    if (target) configureVideo(target, wanted, slot);
  }

  const video = nodes[slot];
  if (!video) return;
  try {
    video.currentTime = 0;
  } catch {}

  // This function is called synchronously from the episode/live click handler,
  // so it is the only place where we intentionally try an audible play under
  // the browser's user-activation token. If that is rejected, immediately
  // retry muted; activation/crossfade will restore the preferred mute state.
  video.muted = !view.soundEnabled;
  void video
    .play()
    .then(() => {
      syncVideoDeck();
    })
    .catch(() => {
      video.muted = true;
      void video
        .play()
        .then(() => syncVideoDeck())
        .catch(() => {});
    });
}

function handleDeckEnded(slot: number, clipId: number) {
  if (slot !== activeVideoSlot || clipId !== activeVideoClipId) return;

  if (view.replayClipId != null) {
    // An outgoing deck can finish while a different replay episode is loading.
    // Never let that stale `ended` event advance/replace the newly requested
    // replay target. Only the replay episode that is *currently selected* owns
    // replay auto-advance semantics.
    if (view.replayClipId !== clipId) return;

    const published = publishedTimeline();
    const index = published.findIndex((clip) => clip.id === clipId);
    const following = index >= 0 ? published[index + 1] : null;
    const live = latestPublishedClip();
    if (following && following.id !== live?.id)
      view.replayClipId = following.id;
    else view.replayClipId = null;
    switchSerial += 1;
    pendingActivation = null;
    syncLocalUiState();
    syncEpisodeSelection();
    syncVideoDeck();
    return;
  }

  const current = view.timeline.find((clip) => clip.id === clipId) || null;
  const following = clipAfter(current);
  if (following && following.startsAtMs <= liveNowMs() + 250) {
    syncVideoDeck();
    return;
  }

  // The `ended` event is the fast path. `reconcileLiveEdge()` is the fallback
  // for browsers that miss it during a deck transition/background wake.
  enterLiveIntermission("ended-event");
}

function togglePlayback() {
  if (!view.playbackPaused) {
    view.playbackPaused = true;
    view.pausedClipId = visibleClip()?.id ?? desiredClip()?.id ?? null;
    const active = videoNodes()[activeVideoSlot];
    if (active && !active.paused) active.pause();
    syncLocalUiState();
    return;
  }

  view.playbackPaused = false;
  view.pausedClipId = null;
  if (view.replayClipId == null)
    setLiveSlotState("playing", "manual-playback-resume");
  switchSerial += 1;
  pendingActivation = null;
  syncLocalUiState();
  primeDesiredPlaybackFromGesture();
  syncVideoDeck();
}

function toggleSound() {
  view.soundEnabled = !view.soundEnabled;
  writePref("pumptv-v25-sound", view.soundEnabled);
  syncLocalUiState();
}

function toggleCaptions() {
  view.captionsEnabled = !view.captionsEnabled;
  writePref("pumptv-v25-captions", view.captionsEnabled);
  syncLocalUiState();
}

function toggleLiveOverlay() {
  view.liveOverlayEnabled = !view.liveOverlayEnabled;
  writePref("pumptv-v25-live-overlay", view.liveOverlayEnabled);
  syncLocalUiState();
}

function toggleInfo() {
  view.infoOpen = !view.infoOpen;
  syncLocalUiState();
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen)
      await document.documentElement.requestFullscreen();
  } catch {}
}

function formatClock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 100) / 10);
  const seconds = Math.floor(total);
  const tenths = Math.floor((total - seconds) * 10);
  return `${String(seconds).padStart(2, "0")}.${tenths}`;
}

function updateLiveMeters() {
  const vote = document.querySelector(
    "[data-vote-countdown]",
  ) as HTMLElement | null;
  if (vote && view.program?.countdownEndsAtMs)
    vote.textContent = formatClock(
      view.program.countdownEndsAtMs - liveNowMs(),
    );
  const futureVote = document.querySelector(
    "[data-future-vote-countdown]",
  ) as HTMLElement | null;
  if (futureVote && view.program?.votingRound?.closesAtMs)
    futureVote.textContent = formatClock(
      view.program.votingRound.closesAtMs - liveNowMs(),
    );
  if (view.program?.countdownEndsAtMs)
    document
      .querySelectorAll<HTMLElement>(
        "[data-your-turn-countdown], [data-drawer-countdown]",
      )
      .forEach((node) => {
        node.textContent = `${Math.max(0, Math.ceil((view.program!.countdownEndsAtMs! - liveNowMs()) / 1000))}s`;
      });
  const gen = document.querySelector(
    "[data-generation-elapsed]",
  ) as HTMLElement | null;
  if (gen && view.program?.generationStartedAtMs)
    gen.textContent = formatClock(
      liveNowMs() - view.program.generationStartedAtMs,
    );
}

function jumpToEpisode(id: number) {
  if (!view.timeline.some((clip) => clip.id === id)) return;
  view.playbackPaused = false;
  view.pausedClipId = null;
  const live = latestPublishedClip();
  view.replayClipId = live?.id === id ? null : id;
  if (view.replayClipId == null)
    setLiveSlotState("playing", "episode-selection");
  switchSerial += 1;
  pendingActivation = null;
  syncLocalUiState();
  syncEpisodeSelection();
  centerSelectedEpisode("smooth");
  primeDesiredPlaybackFromGesture();
  syncVideoDeck();
}

function returnLive() {
  view.playbackPaused = false;
  view.pausedClipId = null;
  view.replayClipId = null;
  // Returning to live starts the latest archive episode cleanly. The ended
  // edge will switch back to intermission when that episode actually finishes.
  setLiveSlotState("playing", "return-live");
  switchSerial += 1;
  pendingActivation = null;
  syncLocalUiState();
  syncEpisodeSelection();
  centerSelectedEpisode("smooth");
  primeDesiredPlaybackFromGesture();
  syncVideoDeck();
}

let interactionLayerInstalled = false;

function installInteractionLayer() {
  if (interactionLayerInstalled) return;
  interactionLayerInstalled = true;

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!view.trayOpen || view.worldDetailKind) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (
        target.closest(".participationSheet") ||
        target.closest(".participationDock") ||
        target.closest(".winnerRewardNotice")
      )
        return;

      view.trayOpen = false;
    },
    true,
  );

  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const control = target?.closest<HTMLElement>("[data-action]");
      if (!control) return;

      const action = control.dataset.action;
      if (!action) return;
      event.preventDefault();

      if (action === "playback") togglePlayback();
      else if (action === "sound") toggleSound();
      else if (action === "captions") toggleCaptions();
      else if (action === "overlay") toggleLiveOverlay();
      else if (action === "info") toggleInfo();
      else if (action === "close-info") {
        if (view.infoOpen) {
          view.infoOpen = false;
          syncLocalUiState();
        }
      } else if (action === "tray-toggle") toggleTray();
      else if (action === "close-tray") {
        if (view.trayOpen) {
          view.trayOpen = false;
        }
      } else if (action === "close-reward") {
        view.winnerNoticeDismissed = true;
        if (view.walletAddress && view.winnerNoticeProposalId)
          sessionStorage.setItem(
            `pumptv-reward-dismissed:${view.walletAddress}:${view.winnerNoticeProposalId}`,
            "1",
          );
      } else if (action === "tray-ideas") openTray();
      else if (action === "wallet") void connectMetaMask(true);
      else if (action === "submit-idea") void submitIdea();
      else if (action === "cancel-own") void cancelOwnIdea();
      else if (action === "world-detail") {
        const kind = control.dataset.worldKind as
          "location" | "character" | "prop" | undefined;
        view.worldDetailKind = kind || null;
        view.worldDetailId = control.dataset.worldId || null;
      } else if (action === "close-world-detail") {
        view.worldDetailKind = null;
        view.worldDetailId = null;
      } else if (action === "vote") {
        const id = Number(control.dataset.proposalId);
        if (Number.isSafeInteger(id)) void voteForProposal(id);
      } else if (action === "fullscreen") void toggleFullscreen();
      else if (action === "live") returnLive();
      else if (action === "episode") {
        const id = Number(control.dataset.episodeId);
        if (Number.isFinite(id)) jumpToEpisode(id);
      }
    },
    true,
  );

  document.addEventListener(
    "input",
    (event) => {
      const target =
        event.target instanceof HTMLInputElement ? event.target : null;
      if (!target?.matches("[data-idea-input]")) return;
      ideaDraft = target.value.slice(0, 500);
      ideaDraftDirty = true;
      syncIdeaFormState();
    },
    true,
  );

  document.addEventListener(
    "submit",
    (event) => {
      const form =
        event.target instanceof HTMLFormElement ? event.target : null;
      if (!form?.matches("[data-idea-form]")) return;
      event.preventDefault();
      void submitIdea();
    },
    true,
  );

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (view.worldDetailKind) {
      view.worldDetailKind = null;
      view.worldDetailId = null;
      return;
    }
    if (view.trayOpen) {
      view.trayOpen = false;
      return;
    }
    if (view.infoOpen) {
      view.infoOpen = false;
      syncLocalUiState();
    }
  });

  window.addEventListener("resize", positionMediaDeck);
}

function centerSelectedEpisode(behavior: ScrollBehavior = "auto") {
  const active = document.querySelector(
    ".episodeCard.active",
  ) as HTMLElement | null;
  if (active) active.scrollIntoView({ block: "nearest", behavior });
}

function shortAddress(value: string | null | undefined) {
  if (!value) return null;
  if (value.length <= 12) return value;
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

function authorLabel(author: string | null, address: string | null) {
  if (author) return author.startsWith("@") ? author : `@${author}`;
  return shortAddress(address) || "@?";
}

function clipAuthor(clip: Clip) {
  return authorLabel(clip.directiveAuthor, clip.directiveAuthorAddress);
}

function clipFactOverlay(clip: Clip | null | undefined) {
  if (!clip?.showrunnerPlanJson) return "";
  try {
    const parsed = JSON.parse(clip.showrunnerPlanJson) as {
      _factOverlay?: unknown;
    };
    return typeof parsed._factOverlay === "string"
      ? parsed._factOverlay.trim().slice(0, 96)
      : "";
  } catch {
    return "";
  }
}

function engineState() {
  if (!view.program) return "boot";
  if (view.program.phase === "starting") return "boot";
  if (view.program.phase === "offline") return "off";
  if (view.program.phase === "setup" || view.program.phase === "paused")
    return "pause";
  if (
    view.program.phase === "planning" ||
    view.program.phase === "rendering" ||
    view.program.phase === "finalizing"
  )
    return "work";
  return "ready";
}

function tooltipStatus() {
  if (!view.program || !view.room) return "MEME TV is starting";
  if (view.program.reason) return view.program.reason;
  if (view.program.phase === "starting") return "Generation worker is starting";
  if (view.program.phase === "locked")
    return `Preparing episode ${view.program.targetEpisode + 1}`;
  if (
    view.program.phase === "planning" ||
    view.program.phase === "rendering" ||
    view.program.phase === "finalizing"
  )
    return `Generating episode ${view.program.targetEpisode + 1}`;
  if (view.program.phase === "ready")
    return `Episode ${view.program.targetEpisode + 1} ready`;
  const round = view.program.votingRound;
  const proposals = round?.proposals.length || 0;
  return proposals
    ? view.program.countdownEndsAtMs
      ? round?.decisionMode === "voting"
        ? `${proposals} active ideas; voting is open`
        : "1 active idea; it locks in automatically unless another IP challenges"
      : `${proposals} active idea${proposals === 1 ? "" : "s"}`
    : "Waiting for suggestions";
}

type ControlIconName =
  "playback" | "sound" | "captions" | "overlay" | "info" | "fullscreen";
type ControlAction =
  "playback" | "sound" | "captions" | "overlay" | "info" | "fullscreen";

function ControlIcon({ name }: { name: ControlIconName }) {
  if (name === "playback")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        {view.playbackPaused ? (
          <path d="M8 5v14l11-7-11-7Z" />
        ) : (
          <>
            <rect x="7" y="5" width="3.5" height="14" rx="1" />
            <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
          </>
        )}
      </svg>
    );
  if (name === "sound")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 9v6h4l5 4V5L8 9H4Z" />
        {view.soundEnabled ? (
          <path
            className="stroke"
            d="M16 9.2c1.1 1.1 1.1 4.5 0 5.6M18.5 7c2.6 2.5 2.6 7.5 0 10"
          />
        ) : null}
      </svg>
    );
  if (name === "captions")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect className="stroke" x="3" y="5" width="18" height="14" rx="3" />
        <path
          className="stroke"
          d="M9.8 10.2a2.4 2.4 0 1 0 0 3.6M16.8 10.2a2.4 2.4 0 1 0 0 3.6"
        />
      </svg>
    );
  if (name === "overlay")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="2" />
        <path
          className="stroke"
          d="M8.3 8.3a5.2 5.2 0 0 0 0 7.4M15.7 8.3a5.2 5.2 0 0 1 0 7.4M5.5 5.5a9.2 9.2 0 0 0 0 13M18.5 5.5a9.2 9.2 0 0 1 0 13"
        />
      </svg>
    );
  if (name === "info")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="stroke" cx="12" cy="12" r="8" />
        <circle cx="12" cy="8" r="1.2" />
        <path className="stroke" d="M12 11v6" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path className="stroke" d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
    </svg>
  );
}

function KnobControl(props: {
  active?: boolean;
  title: string;
  icon: ControlIconName;
  action: ControlAction;
}) {
  return (
    <button
      className={`knobControl ${props.active ? "on" : ""}`}
      type="button"
      data-action={props.action}
      data-control={props.action}
      aria-label={props.title}
      aria-pressed={Boolean(props.active)}
    >
      <span className="knobIcon">
        <ControlIcon name={props.icon} />
      </span>
    </button>
  );
}

function sortedCandidates(round: PromptRound | null) {
  return [...(round?.proposals || [])].sort(
    (a, b) => b.voteCount - a.voteCount || a.id - b.id,
  );
}

function stageGlyph(phase: LiveProgramState["phase"]) {
  if (phase === "planning") return "◇";
  if (phase === "rendering") return "▶";
  if (phase === "finalizing") return "◆";
  if (phase === "ready") return "●";
  if (phase === "locked") return "◆";
  if (phase === "deciding") return "◷";
  if (phase === "voting") return "◉";
  if (phase === "paused" || phase === "setup" || phase === "offline")
    return "!";
  if (phase === "starting") return "…";
  return "○";
}

type TrayIconName = "wallet" | "ideas" | "world" | "chevron" | "send";

function TrayIcon({ name }: { name: TrayIconName }) {
  if (name === "wallet")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          className="stroke"
          d="M4 7.5h13.5A2.5 2.5 0 0 1 20 10v7.5H6A2 2 0 0 1 4 15.5v-8Z"
        />
        <path
          className="stroke"
          d="M4.5 7.5 15 4v3.5M15.5 11.5H20v3h-4.5a1.5 1.5 0 0 1 0-3Z"
        />
      </svg>
    );
  if (name === "ideas")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          className="stroke"
          d="M12 3v3M12 18v3M3 12h3M18 12h3M5.7 5.7l2.1 2.1M16.2 16.2l2.1 2.1M18.3 5.7l-2.1 2.1M7.8 16.2l-2.1 2.1"
        />
        <circle className="stroke" cx="12" cy="12" r="3.5" />
      </svg>
    );
  if (name === "world")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="stroke" cx="12" cy="12" r="8" />
        <path
          className="stroke"
          d="M4.5 10h15M4.5 14h15M12 4c2.2 2.1 3.2 4.8 3.2 8S14.2 17.9 12 20M12 4c-2.2 2.1-3.2 4.8-3.2 8S9.8 17.9 12 20"
        />
      </svg>
    );
  if (name === "send")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path className="stroke" d="m5 12 14-7-4.5 14-3-5.5L5 12Z" />
        <path className="stroke" d="M11.5 13.5 19 5" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path className="stroke" d="m7 15 5-5 5 5" />
    </svg>
  );
}

function trayRound() {
  return view.program?.votingRound || null;
}

function CurrentPrompt({ clip }: { clip: Clip | null }) {
  const fact = clipFactOverlay(clip);
  return (
    <div
      className="currentPrompt"
      data-current-prompt
      data-empty={clip ? undefined : ""}
    >
      <span data-current-prompt-text>{clip?.directive || ""}</span>
      {fact ? (
        <b
          className="currentPromptFact"
          data-current-prompt-fact
          aria-label={`Exact resolved fact: ${fact}`}
        >
          {fact}
        </b>
      ) : (
        <b data-current-prompt-fact style={{ display: "none" }} />
      )}
      <i data-current-prompt-author>{clip ? clipAuthor(clip) : ""}</i>
    </div>
  );
}

function formatScore(value: number) {
  const score = Math.max(0, Number(value || 0));
  if (score < 1_000)
    return score < 10 && score % 1
      ? score.toFixed(1).replace(/\.0$/, "")
      : Math.round(score).toString();
  const units = [
    [1_000_000_000_000_000, "Q"],
    [1_000_000_000_000, "T"],
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ] as const;
  for (const [size, suffix] of units) {
    if (score < size) continue;
    const scaled = score / size;
    return `${scaled.toFixed(scaled < 10 ? 1 : 0).replace(/\.0$/, "")}${suffix}`;
  }
  return Math.round(score).toString();
}

function formatExactScore(value: number) {
  const score = Math.max(0, Number(value || 0));
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(score);
}

function proposalScoreTooltip(proposal: PromptProposal) {
  return [
    `Total ${formatExactScore(proposal.voteCount)}`,
    `Creator ${formatExactScore(proposal.ownerWeight)}`,
    `Votes ${formatExactScore(proposal.realVoteCount)}`,
    `Voters ${proposal.voterCount}`,
  ].join("\n");
}

type BoardIconName =
  | "viewer"
  | "wallet"
  | "send"
  | "edit"
  | "cancel"
  | "upvote"
  | "suggestions"
  | "world";

function BoardIcon({ name }: { name: BoardIconName }) {
  if (name === "viewer")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          className="stroke"
          d="M3.5 12s3.2-5 8.5-5 8.5 5 8.5 5-3.2 5-8.5 5-8.5-5-8.5-5Z"
        />
        <circle className="stroke" cx="12" cy="12" r="2.2" />
      </svg>
    );
  if (name === "wallet") return <TrayIcon name="wallet" />;
  if (name === "send") return <TrayIcon name="send" />;
  if (name === "edit")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path className="stroke" d="m5 17-.7 3.7L8 20l10.5-10.5-3-3L5 17Z" />
      </svg>
    );
  if (name === "cancel")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path className="stroke" d="m7 7 10 10M17 7 7 17" />
      </svg>
    );
  if (name === "upvote")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path className="stroke" d="M12 19V6M6.5 11.5 12 6l5.5 5.5" />
      </svg>
    );
  if (name === "suggestions")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path className="stroke" d="M5 5.5h14v10H9.5L5 19v-13.5Z" />
        <path className="stroke" d="M8.5 9h7M8.5 12h4.5" />
      </svg>
    );
  return <TrayIcon name="world" />;
}

function ProposalCard({
  proposal,
  own = false,
  rank,
}: {
  proposal: PromptProposal;
  own?: boolean;
  rank: number;
  key?: unknown;
}) {
  const pending = view.votePendingId === proposal.id;
  return (
    <div
      className={`persistentProposal ${rank === 1 ? "leader" : ""} ${own ? "own" : ""} ${pending ? "pending" : ""}`}
      data-proposal-id={proposal.id}
    >
      <em className="proposalRank">{rank}</em>
      <div
        className="persistentProposalText"
        data-rich-tooltip="1"
        data-tooltip-kicker={`IDEA #${proposal.id}`}
        data-tooltip-body={proposal.text}
        data-tooltip-meta={authorLabel(proposal.author, proposal.authorAddress)}
      >
        <span>{proposal.text}</span>
        <i>
          <code>#{proposal.id}</code>
          {proposal.author || proposal.authorAddress ? (
            <>{authorLabel(proposal.author, proposal.authorAddress)}</>
          ) : null}
        </i>
      </div>
      {own ? (
        <b
          className="proposalTotal"
          data-rich-tooltip="1"
          data-tooltip-kicker={`SCORE · #${proposal.id}`}
          data-tooltip-body={proposalScoreTooltip(proposal)}
        >
          {formatScore(proposal.voteCount)}
        </b>
      ) : (
        <button
          type="button"
          className="proposalVote"
          data-action="vote"
          data-proposal-id={proposal.id}
          disabled={pending}
          aria-label={`Vote with score ${formatScore(view.walletPower)}. Current total ${formatScore(proposal.voteCount)}`}
          data-rich-tooltip="1"
          data-tooltip-kicker={`SCORE · #${proposal.id}`}
          data-tooltip-body={proposalScoreTooltip(proposal)}
          data-tooltip-meta={`Your vote adds ${formatExactScore(view.walletPower)}`}
        >
          <BoardIcon name="upvote" />
          <b>{formatScore(proposal.voteCount)}</b>
        </button>
      )}
    </div>
  );
}

function PersistentIdeas() {
  const round = currentBoardRound();
  const own = ownProposal();
  const proposals = sortedCandidates(round);
  const ownLocked = Boolean(own && round?.decisionMode === "voting");
  const countdown = view.program?.countdownEndsAtMs
    ? `${Math.max(0, Math.ceil((view.program.countdownEndsAtMs - liveNowMs()) / 1000))}s`
    : null;
  return (
    <section className="persistentIdeas" aria-label="Suggestions">
      <div className="persistentIdeasHead">
        <b>
          {proposals.length} IDEA{proposals.length === 1 ? "" : "S"}
        </b>
        {countdown ? (
          <span>
            {round?.decisionMode === "voting" ? "VOTE" : "STARTS"}{" "}
            <strong data-drawer-countdown>{countdown}</strong>
          </span>
        ) : null}
      </div>
      <form
        className={`persistentIdeaForm ${own ? "editing" : ""}`}
        data-idea-form
      >
        <input
          data-idea-input
          value={ideaDraft}
          maxLength={500}
          autoComplete="off"
          spellCheck="true"
          placeholder={
            ownLocked
              ? "your idea is locked while voting is open"
              : own
                ? "edit your idea"
                : "what happens next?"
          }
          aria-label="Your idea"
          disabled={view.ideaSubmitting || ownLocked}
        />
        <button
          type="submit"
          data-action="submit-idea"
          disabled={!ideaCanSubmit()}
          aria-label={own ? "Save changed idea" : "Submit idea"}
        >
          <BoardIcon name="send" />
        </button>
        {own ? (
          <button
            type="button"
            className="withdrawIdea"
            data-action="cancel-own"
            aria-label={
              ownLocked ? "Idea locked while voting is open" : "Withdraw idea"
            }
            disabled={ownLocked}
          >
            <BoardIcon name="cancel" />
          </button>
        ) : null}
      </form>
      <div className="persistentProposalList">
        {proposals.map((proposal, index) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            rank={index + 1}
            own={proposal.id === own?.id}
          />
        ))}
      </div>
    </section>
  );
}

function worldDetail() {
  if (!view.worldState || !view.worldDetailKind) return null;
  if (view.worldDetailKind === "location")
    return {
      title: view.worldState.location,
      lines: [
        view.worldState.locationDetails,
        view.worldState.lastEndingBeat,
        ...view.worldState.openThreads,
      ].filter(Boolean),
    };
  if (view.worldDetailKind === "character") {
    const item = view.worldState.characters.find(
      (character) => character.id === view.worldDetailId,
    );
    return item
      ? {
          title: item.name,
          lines: [
            item.appearance,
            item.wardrobe,
            item.status,
            item.position,
          ].filter(Boolean),
        }
      : null;
  }
  const item = view.worldState.props.find(
    (prop) => prop.id === view.worldDetailId,
  );
  return item
    ? {
        title: item.name,
        lines: [item.description, item.status, item.position].filter(Boolean),
      }
    : null;
}

function WorldDetailModal() {
  const detail = worldDetail();
  if (!detail) return null;
  return (
    <div className="worldDetailShade" role="presentation">
      <article
        className="worldDetailModal"
        role="dialog"
        aria-modal="true"
        aria-label={detail.title || "World detail"}
      >
        <button
          type="button"
          data-action="close-world-detail"
          aria-label="Close"
        >
          ×
        </button>
        <b>{detail.title || "—"}</b>
        {detail.lines.map((line, index) => (
          <p key={`${index}:${line}`}>{line}</p>
        ))}
      </article>
    </div>
  );
}

function PersistentWorld() {
  if (!view.worldState) return <section className="persistentWorld" />;
  return (
    <section className="persistentWorld" aria-label="World state">
      <button
        type="button"
        className="worldLocationCard"
        data-action="world-detail"
        data-world-kind="location"
        data-world-id="location"
        data-rich-tooltip="1"
        data-tooltip-kicker={view.worldState.location || "WORLD"}
        data-tooltip-body={
          view.worldState.locationDetails ||
          view.worldState.lastEndingBeat ||
          ""
        }
        data-tooltip-meta={view.worldState.lastEndingBeat || ""}
      >
        <b>{view.worldState.location || "—"}</b>
        {view.worldState.lastEndingBeat ? (
          <span>{view.worldState.lastEndingBeat}</span>
        ) : null}
      </button>
      {view.worldState.characters.length ? (
        <div className="persistentWorldItems">
          {view.worldState.characters.map((item) => (
            <button
              key={item.id}
              type="button"
              data-action="world-detail"
              data-world-kind="character"
              data-world-id={item.id}
              data-rich-tooltip="1"
              data-tooltip-kicker={item.name}
              data-tooltip-body={[item.appearance, item.wardrobe]
                .filter(Boolean)
                .join("\n")}
              data-tooltip-meta={[item.status, item.position]
                .filter(Boolean)
                .join(" · ")}
            >
              <b>{item.name}</b>
              <span>{item.status}</span>
            </button>
          ))}
        </div>
      ) : null}
      {view.worldState.props.length ? (
        <div className="persistentWorldItems props">
          {view.worldState.props.map((item) => (
            <button
              key={item.id}
              type="button"
              data-action="world-detail"
              data-world-kind="prop"
              data-world-id={item.id}
              data-rich-tooltip="1"
              data-tooltip-kicker={item.name}
              data-tooltip-body={item.description}
              data-tooltip-meta={[item.status, item.position]
                .filter(Boolean)
                .join(" · ")}
            >
              <b>{item.name}</b>
              <span>{item.status}</span>
            </button>
          ))}
        </div>
      ) : null}
      {view.worldState.openThreads.length ? (
        <div
          className="persistentThreads"
          role="list"
          aria-label="Open story threads"
        >
          {view.worldState.openThreads.map((thread, index) => (
            <div
              className="persistentThreadRow"
              role="listitem"
              key={`${index}:${thread}`}
            >
              <em>{index + 1}</em>
              <span>{thread}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ParticipationBoard() {
  const round = currentBoardRound();
  const candidates = sortedCandidates(round);
  const leader = candidates[0] || null;
  const walletTitle = view.walletAddress
    ? `${shortAddress(view.walletAddress)} · Robinhood Chain · ${view.walletEthBalance.toFixed(4)} ETH · 1 vote`
    : "Connect MetaMask";
  const own = ownProposal();

  return (
    <section className={`participationBoard ${view.trayOpen ? "open" : ""}`}>
      <div className="participationDock">
        <button
          className="boardToggle"
          type="button"
          data-action="tray-toggle"
          aria-label={
            view.trayOpen ? "Close ideas" : own ? "Open my idea" : "Add an idea"
          }
          aria-expanded={view.trayOpen}
        >
          <span>{own ? "MY IDEA" : "ADD IDEA"}</span>
          <TrayIcon name="chevron" />
        </button>

        <span
          className="viewerMetric"
          aria-label={`${view.room?.viewerCount ?? 0} viewers`}
        >
          <BoardIcon name="viewer" />
          <b>{view.room?.viewerCount ?? 0}</b>
        </span>

        <button
          className="dockIdeaSummary"
          type="button"
          data-action="tray-toggle"
          aria-label="Open suggestions and world state"
          data-rich-tooltip={leader ? "1" : undefined}
          data-tooltip-kicker={
            leader ? `LEADING IDEA #${leader.id}` : undefined
          }
          data-tooltip-body={leader?.text}
          data-tooltip-meta={
            leader
              ? authorLabel(leader.author, leader.authorAddress)
              : undefined
          }
        >
          {leader ? (
            <>
              <span>{leader.text}</span>
              <b>{formatScore(leader.voteCount)}</b>
            </>
          ) : (
            <i>•••</i>
          )}
        </button>

        <span
          className="proposalMetric"
          aria-label={`${candidates.length} suggestions`}
        >
          <BoardIcon name="suggestions" />
          <b>{candidates.length}</b>
        </span>

        <button
          type="button"
          className={`walletMetric ${view.walletAddress ? "connected" : ""}`}
          data-action="wallet"
          aria-label={walletTitle}
          data-rich-tooltip={view.walletAddress ? "1" : undefined}
          data-tooltip-kicker={
            view.walletAddress ? "ROBINHOOD CHAIN" : undefined
          }
          data-tooltip-body={
            view.walletAddress
              ? `Robinhood ETH ${view.walletEthBalance.toFixed(4)}\nVoting power ${formatExactScore(view.walletPower)}`
              : undefined
          }
          data-tooltip-meta={
            view.walletAddress ? shortAddress(view.walletAddress) : undefined
          }
        >
          <BoardIcon name="wallet" />
          {view.walletAddress ? (
            <b>
              {view.walletScoreLoading ? "…" : formatScore(view.walletPower)}
            </b>
          ) : null}
        </button>

        {view.participationError ? (
          <i
            className="participationError"
            data-rich-tooltip="1"
            data-tooltip-kicker="ERROR"
            data-tooltip-body={view.participationError}
          >
            !
          </i>
        ) : null}
      </div>

      {view.trayOpen ? (
        <button
          type="button"
          className="participationShade"
          data-action="close-tray"
          aria-label="Close participation panel"
        />
      ) : null}

      <div className="participationSheet" aria-hidden={!view.trayOpen}>
        <div className="drawerGrab" aria-hidden="true">
          <i />
        </div>
        <div className="participationColumns">
          <PersistentWorld />
          <PersistentIdeas />
        </div>
      </div>

      <WorldDetailModal />
    </section>
  );
}

function liveEdgeEpisode() {
  const active =
    activeVideoClipId == null
      ? null
      : view.timeline.find((clip) => clip.id === activeVideoClipId) || null;
  if (active) return active.episode;

  const ended =
    view.lastEndedLiveClipId == null
      ? null
      : view.timeline.find((clip) => clip.id === view.lastEndedLiveClipId) ||
        null;
  return ended?.episode ?? null;
}

function programBusyForFutureEpisode() {
  if (!view.program) return false;
  const busy =
    view.program.phase === "locked" ||
    view.program.phase === "planning" ||
    view.program.phase === "rendering" ||
    view.program.phase === "finalizing" ||
    view.program.phase === "ready";
  if (!busy) return false;

  const presentedEpisode = liveEdgeEpisode();
  // A long-poll snapshot can still say EP N is `ready` after the browser has
  // already presented and ended EP N. Only suppress the next-turn surface when
  // the server is actually working on an episode AFTER the one on screen.
  return (
    presentedEpisode == null || view.program.targetEpisode > presentedEpisode
  );
}

function YourTurnOverlay() {
  if (
    view.replayClipId != null ||
    view.liveSlotState !== "intermission" ||
    incomingLiveClipPending() ||
    programBusyForFutureEpisode()
  )
    return null;

  const round = view.program?.votingRound || null;
  const ideas = round?.proposals.length || 0;
  const decisionMode =
    round?.decisionMode || (ideas > 1 ? "voting" : ideas ? "solo" : "waiting");
  const countdown = view.program?.countdownEndsAtMs
    ? `${Math.max(0, Math.ceil((view.program.countdownEndsAtMs - liveNowMs()) / 1000))}s`
    : null;
  const unavailable =
    view.program?.phase === "offline" ||
    view.program?.phase === "setup" ||
    view.program?.phase === "paused";

  return (
    <div className="yourTurnOverlay choose">
      <div className="yourTurnCard">
        <span className="yourTurnKicker">
          {decisionMode === "voting" ? "VOTE" : "YOUR TURN"}
        </span>
        {countdown ? (
          <strong className="yourTurnCountdown" data-your-turn-countdown>
            {countdown}
          </strong>
        ) : null}
        {ideas ? (
          <div className="yourTurnMeta">
            {ideas} IDEA{ideas === 1 ? "" : "S"}
          </div>
        ) : unavailable ? (
          <div className="yourTurnMeta">
            {view.program?.reason || "UNAVAILABLE"}
          </div>
        ) : null}
        <button type="button" data-action="tray-ideas">
          {decisionMode === "voting" ? "OPEN VOTE" : "ADD IDEA"}
        </button>
      </div>
    </div>
  );
}

function GenerationPulse() {
  if (view.replayClipId != null || view.liveSlotState !== "intermission")
    return null;
  const mediaLoading = incomingLiveClipPending();
  const serverBusy = programBusyForFutureEpisode();
  if (!mediaLoading && !serverBusy) return null;

  const label =
    mediaLoading || view.program?.phase === "ready" ? "LOADING" : "GENERATING";
  const targetEpisode =
    view.program?.targetEpisode ?? (liveEdgeEpisode() ?? -1) + 1;
  return (
    <div
      className="generationPulse"
      aria-label={`${label === "LOADING" ? "Loading" : "Generating"} episode ${targetEpisode + 1}`}
      title={tooltipStatus()}
    >
      <i aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

function WinnerRewardNotice() {
  if (
    !view.walletAddress ||
    !view.winnerNoticeProposalId ||
    view.winnerNoticeDismissed
  )
    return null;
  const reward =
    view.winnerReward?.proposalId === view.winnerNoticeProposalId
      ? view.winnerReward
      : null;
  const targetUsd = reward?.targetUsd ?? 1;
  const amountEth = reward?.amountEth ?? null;
  const status =
    reward?.status === "sent"
      ? "SENT"
      : reward?.status === "uncertain"
        ? "PAYMENT PENDING"
        : "SENDING";
  return (
    <aside
      className={`winnerRewardNotice ${reward?.status || "pending"}`}
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        data-action="close-reward"
        aria-label="Dismiss reward notification"
      >
        ×
      </button>
      <b>YOUR IDEA WON</b>
      <strong>
        {`$${targetUsd.toFixed(2)}`} ·{" "}
        {amountEth == null ? "ETH" : `${amountEth.toFixed(6)} ETH`}
      </strong>
      <span>{status}</span>
      {reward?.status === "sent" && reward.explorerUrl ? (
        <a href={reward.explorerUrl} target="_blank" rel="noreferrer">
          VIEW TX
        </a>
      ) : null}
    </aside>
  );
}

function TactileTV({ clip }: { clip: Clip | null }) {
  const state = engineState();
  const isReplay = view.replayClipId != null;

  return (
    <div className="tvShell">
      <div className="tvScrew screwA" />
      <div className="tvScrew screwB" />
      <div className="tvScrew screwC" />
      <div className="tvScrew screwD" />
      <div className="tvScreenFrame">
        <div className="tvGlass">
          {!clip ? (
            <div className="tvIdle">
              <div className={`idleOrb ${state}`}>
                <span>●</span>
              </div>
            </div>
          ) : null}
          <div className="glassGlow" />
          {view.liveSlotState !== "intermission" || isReplay ? (
            <CurrentPrompt clip={clip} />
          ) : null}
          <YourTurnOverlay />
          <GenerationPulse />
          {isReplay ? (
            <button
              className="liveReturn"
              type="button"
              data-action="live"
              aria-label="Return to live"
            >
              ●
            </button>
          ) : null}
        </div>
      </div>

      <div className="tvHardware">
        <button className={`powerLamp ${state}`} aria-label={tooltipStatus()} />
        <div className="knobStack">
          <KnobControl
            active={!view.playbackPaused}
            title={view.playbackPaused ? "Play" : "Pause"}
            icon="playback"
            action="playback"
          />
          <KnobControl
            active={view.soundEnabled}
            title={view.soundEnabled ? "Mute" : "Unmute"}
            icon="sound"
            action="sound"
          />
          <KnobControl
            active={view.captionsEnabled}
            title={
              view.captionsEnabled
                ? "Hide prompt captions"
                : "Show prompt captions"
            }
            icon="captions"
            action="captions"
          />
          <KnobControl
            title="Fullscreen"
            icon="fullscreen"
            action="fullscreen"
          />
        </div>
        <div className="speaker" aria-hidden="true">
          {Array.from({ length: 18 }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ProgramShelfSlot() {
  if (!view.program) return null;
  const phase = view.program.phase;
  const candidateCount = view.program.votingRound?.proposals.length || 0;
  if (phase === "ready") return null; // the real future clip card is already in the rail
  if (phase === "idle" && candidateCount === 0) return null;
  const episode = view.program.targetEpisode + 1;
  const directiveText = view.program.directive?.text?.trim() || "";
  const title =
    view.program.reason ||
    (phase === "deciding"
      ? `Idea locks for episode ${episode}`
      : phase === "voting"
        ? `Voting for episode ${episode}`
        : phase === "planning" ||
            phase === "rendering" ||
            phase === "finalizing"
          ? `Generating episode ${episode}`
          : phase === "locked"
            ? `Preparing episode ${episode}`
            : `Waiting for episode ${episode}`);
  const copy =
    phase === "deciding" || phase === "voting"
      ? candidateCount
        ? `${candidateCount} idea${candidateCount === 1 ? "" : "s"}`
        : ""
      : "";
  return (
    <div
      className={`programShelfSlot phase-${phase}`}
      aria-label={title}
      data-rich-tooltip="1"
      data-tooltip-kicker={`EP ${episode}`}
      data-tooltip-body={directiveText || title}
      data-tooltip-meta={
        candidateCount
          ? `${candidateCount} active idea${candidateCount === 1 ? "" : "s"}`
          : title
      }
    >
      <span className="programShelfState" aria-hidden="true">
        {stageGlyph(phase)}
      </span>
      <span className="programShelfCopy">
        {copy ? <span>{copy}</span> : <i />}
      </span>
      <b>{episode}</b>
    </div>
  );
}

function EpisodeShelf() {
  const now = liveNowMs();
  const episodes = [...view.timeline]
    .filter((clip) => Boolean(clip.videoUrl))
    .sort((a, b) => b.episode - a.episode || b.id - a.id);
  const shown = visibleClip();
  const live = latestPublishedClip();

  return (
    <aside className="episodeShelf" aria-label="Episodes">
      <button
        className={`liveCap ${view.replayClipId == null ? "active" : ""}`}
        type="button"
        data-action="live"
        aria-label="Live"
      >
        <span>●</span>
      </button>
      <div className="episodeList">
        <ProgramShelfSlot />
        {episodes.map((clip) => {
          const active = shown?.id === clip.id;
          const isLive = live?.id === clip.id && view.replayClipId == null;
          const future = clip.startsAtMs > now + 250;
          const thumb =
            clip.startFrameUrl || clip.endFrameUrl || clip.anchorFrameUrl;
          return (
            <button
              className={`episodeCard ${active ? "active" : ""} ${isLive ? "live" : ""} ${future ? "future" : ""}`}
              type="button"
              data-action="episode"
              data-episode-id={clip.id}
              data-rich-tooltip="1"
              data-tooltip-kicker={`EP ${clip.episode + 1}${isLive ? " · LIVE" : future ? " · READY" : ""}`}
              data-tooltip-body={clip.directive}
              data-tooltip-meta={[
                clipAuthor(clip),
                clip.directiveVoteCount == null
                  ? null
                  : `${formatScore(clip.directiveVoteCount)} pts`,
                clip.resolution,
                clip.generationMode,
                clip.totalGenerationMs == null
                  ? null
                  : `${(clip.totalGenerationMs / 1000).toFixed(1)}s gen`,
              ]
                .filter(Boolean)
                .join(" · ")}
              data-tooltip-image={thumb || undefined}
              data-tooltip-side="left"
              aria-label={`Episode ${clip.episode + 1}`}
            >
              <span className="episodeThumb">
                {thumb ? <img src={thumb} alt="" loading="lazy" /> : <i />}
                {isLive ? <em>●</em> : null}
              </span>
              <b>{clip.episode + 1}</b>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function App() {
  const clip = visibleClip();
  const state = engineState();
  return (
    <main className="viewerApp">
      <OutsideInterfaceStyles />
      <section className="watchDeck">
        <div className="minimalTop">
          <div className="wordmark">
            <img className="pumptvLogo" src="/api/logo" alt="MEME TV" />
          </div>
          <div className="tinyStatus">
            <i
              className={`statusDot ${state}`}
              data-rich-tooltip="1"
              data-tooltip-kicker="STATUS"
              data-tooltip-body={tooltipStatus()}
            />
            {view.transport !== "live" ? (
              <i className="transportDot" aria-label={view.transport} />
            ) : null}
          </div>
        </div>
        <div className="tvCenter">
          <TactileTV clip={clip} />
        </div>
        <ParticipationBoard />
        <WinnerRewardNotice />
        {view.error ? (
          <div
            className="fatalBadge"
            data-rich-tooltip="1"
            data-tooltip-kicker="ERROR"
            data-tooltip-body={view.error}
          >
            !
          </div>
        ) : null}
        {view.room?.generation.paused ? (
          <div
            className="fatalBadge warning"
            data-rich-tooltip="1"
            data-tooltip-kicker="GENERATION"
            data-tooltip-body={
              view.room.generation.reason || "Generation paused"
            }
          >
            !
          </div>
        ) : null}
      </section>
      <EpisodeShelf />
    </main>
  );
}

boot();
