import { render } from "tradjs/client";
import { createEVMClient } from "@metamask/connect-evm";
import { getAddress, isAddress } from "viem";
import { createMeasure } from "measure-fn";
import {
  createInvalidationQueue,
  createReactiveState,
} from "../src/client/signals.ts";
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

type TrayView = "ideas" | "world";
type WalletState = "idle" | "connecting" | "connected" | "missing" | "error";

type WalletNetwork = {
  chainId: number;
  chainHex: string;
  name: string;
  currency: "ETH";
  rpcUrl: string;
  explorerUrl: string;
};

let walletNetworkPromise: Promise<WalletNetwork> | null = null;

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

type Eip1193Provider = {
  request(input: { method: string; params?: unknown[] | object }): Promise<any>;
  on?(event: string, handler: (...args: any[]) => void): void;
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
  trayView: "ideas" as TrayView,
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

function normalizeClientEvmAddress(value: unknown) {
  const text = String(value || "").trim();
  if (!text || !isAddress(text)) return null;
  return getAddress(text);
}

function walletFromAddress(value: unknown) {
  const next = normalizeClientEvmAddress(value);
  if (view.walletAddress !== next) {
    view.winnerReward = null;
    view.winnerNoticeProposalId = null;
    view.winnerNoticeDismissed = false;
  }
  view.walletAddress = next;
  view.walletState = next ? "connected" : "idle";
}

let metamaskClientPromise: ReturnType<typeof createEVMClient> | null = null;
let metamaskEventsInstalled = false;

function getWalletNetwork() {
  if (!walletNetworkPromise) {
    walletNetworkPromise = json<{ network: WalletNetwork }>(
      "/api/wallet/score",
      {
        cache: "no-store",
      },
    ).then((payload) => payload.network);
  }
  return walletNetworkPromise;
}

function getMetaMaskClient() {
  if (!metamaskClientPromise) {
    metamaskClientPromise = getWalletNetwork().then((network) =>
      createEVMClient({
        dapp: {
          name: "MEME TV",
          url: window.location.origin,
          iconUrl: new URL("/api/logo", window.location.href).href,
        },
        api: {
          supportedNetworks: {
            [network.chainHex]: network.rpcUrl,
          },
        },
      }),
    );
  }
  return metamaskClientPromise;
}

async function ensureRobinhoodChain(
  provider: Eip1193Provider,
  network: WalletNetwork,
) {
  const current = String(
    (await provider.request({ method: "eth_chainId" })) || "",
  ).toLowerCase();
  if (current === network.chainHex.toLowerCase()) return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: network.chainHex }],
    });
  } catch (cause: any) {
    if (
      Number(cause?.code) !== 4902 &&
      !/unknown chain|unrecognized chain/i.test(String(cause?.message || ""))
    )
      throw cause;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: network.chainHex,
          chainName: network.name,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: [network.rpcUrl],
          blockExplorerUrls: [network.explorerUrl],
        },
      ],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: network.chainHex }],
    });
  }
}

function installMetaMaskEvents(provider: Eip1193Provider) {
  if (metamaskEventsInstalled || !provider.on) return;
  metamaskEventsInstalled = true;
  provider.on("accountsChanged", (accounts: string[] = []) => {
    walletFromAddress(accounts[0] || null);
    view.walletEthBalance = 0;
    view.walletPower = 1;
    if (view.walletAddress) {
      void refreshWalletScore();
      void refreshWinnerReward();
    }
  });
  provider.on("disconnect", () => {
    walletFromAddress(null);
    view.walletEthBalance = 0;
    view.walletPower = 1;
  });
  provider.on("chainChanged", () => {
    if (view.walletAddress) void refreshWalletScore();
  });
}

async function connectMetaMask(interactive: boolean) {
  view.walletState = interactive ? "connecting" : view.walletState;
  if (interactive) view.participationError = null;
  try {
    const network = await getWalletNetwork();
    const client = await getMetaMaskClient();
    const provider = client.getProvider() as Eip1193Provider;
    installMetaMaskEvents(provider);

    let accounts: string[] = [];
    if (interactive) {
      const result = await client.connect({ chainIds: [network.chainHex] });
      accounts = Array.isArray(result?.accounts) ? result.accounts : [];
      await ensureRobinhoodChain(provider, network);
    } else {
      const existing = await provider.request({
        method: "eth_accounts",
        params: [],
      });
      accounts = Array.isArray(existing) ? existing : [];
    }

    walletFromAddress(accounts[0] || null);
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
  if (opening) view.trayView = "ideas";
  if (opening) focusIdeaInputIfAppropriate();
}

function openTray(targetView: TrayView) {
  const opening = !(view.trayOpen && view.trayView === targetView);
  if (!opening) view.trayOpen = false;
  else {
    view.trayOpen = true;
    view.trayView = targetView;
  }
  if (opening && targetView === "ideas") focusIdeaInputIfAppropriate();
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
      } else if (action === "tray-ideas") openTray("ideas");
      else if (action === "tray-world") openTray("world");
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

function candidateShare(
  candidate: PromptProposal,
  candidates: PromptProposal[],
) {
  const total = candidates.reduce(
    (sum, item) => sum + Math.max(0, item.voteCount),
    0,
  );
  return total > 0
    ? Math.max(8, Math.round((candidate.voteCount / total) * 100))
    : 8;
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

function CandidateRows({
  round,
  limit = 5,
  interactive = false,
}: {
  round: PromptRound | null;
  limit?: number;
  interactive?: boolean;
}) {
  const candidates = sortedCandidates(round);
  if (!candidates.length) return null;
  const winnerId = round?.winnerProposalId ?? null;
  return (
    <div className="liveRanking">
      {candidates.slice(0, limit).map((candidate, index) => {
        const selected =
          winnerId === candidate.id || candidate.status === "selected";
        return (
          <div
            className={`rankRow ${selected ? "winner" : ""} ${interactive ? "interactive" : ""} ${view.votePendingId === candidate.id ? "pending" : ""}`}
            key={candidate.id}
            data-action={interactive ? "vote" : undefined}
            data-proposal-id={interactive ? candidate.id : undefined}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? 0 : undefined}
          >
            <em>{index + 1}</em>
            <div
              className="rankIdea"
              data-rich-tooltip="1"
              data-tooltip-kicker={`IDEA #${candidate.id}`}
              data-tooltip-body={candidate.text}
              data-tooltip-meta={authorLabel(
                candidate.author,
                candidate.authorAddress,
              )}
            >
              <span>{candidate.text}</span>
              <i>{authorLabel(candidate.author, candidate.authorAddress)}</i>
              <small
                style={{ width: `${candidateShare(candidate, candidates)}%` }}
              />
            </div>
            <b
              className={
                candidate.operatorVoteOverride == null ? "" : "override"
              }
            >
              {candidate.voteCount}
            </b>
          </div>
        );
      })}
    </div>
  );
}

function OutsideProgram() {
  if (!view.program || !view.liveOverlayEnabled) return null;

  const phase = view.program.phase;
  const deciding = phase === "deciding";
  const voting = phase === "voting";
  if (!deciding && !voting) return null;

  const primaryRound = view.program.votingRound || view.program.decisionRound;
  return (
    <section
      className={`outsideProgram phase-${phase}`}
      title={view.program.reason || tooltipStatus()}
      aria-label="Next episode decision"
    >
      <div className="outsideProgramHead">
        <span className="outsideProgramGlyph" aria-hidden="true">
          {stageGlyph(phase)}
        </span>
        <b>{view.program.targetEpisode + 1}</b>
        {view.program.countdownEndsAtMs ? (
          <strong data-vote-countdown>
            {formatClock(view.program.countdownEndsAtMs - liveNowMs())}
          </strong>
        ) : null}
      </div>
      <CandidateRows round={primaryRound} />
    </section>
  );
}

function OutsideTool(props: {
  active?: boolean;
  icon: "overlay" | "info";
  action: "overlay" | "info";
  title: string;
}) {
  return (
    <button
      className={`outsideTool ${props.active ? "on" : ""}`}
      type="button"
      data-action={props.action}
      data-control={props.action}
      aria-label={props.title}
      aria-pressed={Boolean(props.active)}
    >
      <ControlIcon name={props.icon} />
    </button>
  );
}

function WorldStatePanel() {
  if (!view.infoOpen) return null;
  return (
    <aside className="outsideWorld" aria-label="World state">
      <button
        className="outsideWorldClose"
        type="button"
        data-action="close-info"
        title="Close"
        aria-label="Close"
      >
        ×
      </button>

      {view.worldState ? (
        <div className="outsideWorldBody">
          <div className="outsideWorldLocation">
            <b>{view.worldState.location || "—"}</b>
            {view.worldState.locationDetails ? (
              <p>{view.worldState.locationDetails}</p>
            ) : null}
            {view.worldState.lastEndingBeat ? (
              <em>{view.worldState.lastEndingBeat}</em>
            ) : null}
          </div>

          {view.worldState.characters.length ? (
            <div className="outsideWorldGroup">
              {view.worldState.characters.map((item) => (
                <article key={item.id}>
                  <b>{item.name}</b>
                  <span>{item.status}</span>
                  {item.position ? <small>{item.position}</small> : null}
                </article>
              ))}
            </div>
          ) : null}

          {view.worldState.props.length ? (
            <div className="outsideWorldGroup compact">
              {view.worldState.props.map((item) => (
                <article key={item.id}>
                  <b>{item.name}</b>
                  <span>{item.status}</span>
                  {item.position ? <small>{item.position}</small> : null}
                </article>
              ))}
            </div>
          ) : null}

          {view.worldState.openThreads.length ? (
            <div className="outsideThreads">
              {view.worldState.openThreads.slice(0, 6).map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}

function OutsideConsole() {
  return (
    <div className="outsideConsole">
      <div className="outsideTools">
        <OutsideTool
          active={view.liveOverlayEnabled}
          icon="overlay"
          action="overlay"
          title={
            view.liveOverlayEnabled ? "Hide next episode" : "Show next episode"
          }
        />
        <OutsideTool
          active={view.infoOpen}
          icon="info"
          action="info"
          title="World state"
        />
      </div>
      <OutsideProgram />
      <WorldStatePanel />
    </div>
  );
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

function ParticipationIdeas() {
  const round = trayRound();
  const candidates = sortedCandidates(round);
  const canVote = Boolean(
    round?.status === "open" && round.decisionMode === "voting",
  );
  const generationBusy =
    view.program?.phase === "locked" ||
    view.program?.phase === "planning" ||
    view.program?.phase === "rendering" ||
    view.program?.phase === "finalizing";

  return (
    <div className="trayIdeas">
      <form className="ideaForm" data-idea-form>
        <input
          data-idea-input
          value={ideaDraft}
          maxLength={500}
          autoComplete="off"
          spellCheck="true"
          placeholder="what happens next?"
          aria-label="Next episode idea"
          disabled={view.ideaSubmitting || generationBusy}
        />
        <button
          type="submit"
          data-action="submit-idea"
          disabled={!ideaCanSubmit()}
          title="Submit"
          aria-label="Submit idea"
        >
          <TrayIcon name="send" />
        </button>
      </form>

      {round ? (
        <div className="trayBallot">
          <div className="trayBallotMeta">
            <b>{round.targetEpisode + 1}</b>
            {round.votingStartedAtMs && round.closesAtMs > liveNowMs() ? (
              <strong data-future-vote-countdown>
                {formatClock(round.closesAtMs - liveNowMs())}
              </strong>
            ) : null}
          </div>
          {candidates.length ? (
            <CandidateRows round={round} interactive={canVote} limit={8} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ParticipationWorld() {
  if (!view.worldState) return null;
  return (
    <div className="trayWorld">
      <div className="trayWorldLocation">
        <b>{view.worldState.location || "—"}</b>
        {view.worldState.locationDetails ? (
          <p>{view.worldState.locationDetails}</p>
        ) : null}
        {view.worldState.lastEndingBeat ? (
          <em>{view.worldState.lastEndingBeat}</em>
        ) : null}
      </div>

      {view.worldState.characters.length ? (
        <div className="trayWorldGrid">
          {view.worldState.characters.map((item) => (
            <article key={item.id}>
              <b>{item.name}</b>
              <span>{item.status}</span>
              {item.position ? <small>{item.position}</small> : null}
            </article>
          ))}
        </div>
      ) : null}

      {view.worldState.props.length ? (
        <div className="trayWorldGrid compact">
          {view.worldState.props.map((item) => (
            <article key={item.id}>
              <b>{item.name}</b>
              <span>{item.status}</span>
              {item.position ? <small>{item.position}</small> : null}
            </article>
          ))}
        </div>
      ) : null}

      {view.worldState.openThreads.length ? (
        <div className="trayThreads">
          {view.worldState.openThreads.slice(0, 8).map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ParticipationTray() {
  const round = trayRound();
  const phase = view.program?.phase || "idle";
  const targetEpisode =
    round?.targetEpisode ?? view.program?.targetEpisode ?? 0;
  const candidateCount = round?.proposals.length || 0;
  const walletTitle =
    view.walletState === "missing"
      ? "Connect MetaMask"
      : view.walletAddress
        ? view.walletAddress
        : view.walletState === "connecting"
          ? "Connecting MetaMask"
          : "Connect MetaMask";

  return (
    <section className={`participationTray ${view.trayOpen ? "open" : ""}`}>
      <div className="trayBar">
        <button
          className="trayToggle"
          type="button"
          data-action="tray-toggle"
          title={view.trayOpen ? "Collapse" : "Open"}
          aria-label={
            view.trayOpen ? "Collapse participation" : "Open participation"
          }
        >
          <TrayIcon name="chevron" />
        </button>

        <div className="trayPulse" title={tooltipStatus()}>
          <i>{stageGlyph(phase as LiveProgramState["phase"])}</i>
          <b>{targetEpisode + 1}</b>
          {candidateCount ? <small>{candidateCount}</small> : null}
          {round?.votingStartedAtMs && round.closesAtMs > liveNowMs() ? (
            <strong data-vote-countdown>
              {formatClock(round.closesAtMs - liveNowMs())}
            </strong>
          ) : null}
        </div>

        <div className="trayActions">
          <button
            className={`trayAction wallet ${view.walletAddress ? "on" : ""} ${view.walletState}`}
            type="button"
            data-action="wallet"
            title={walletTitle}
            aria-label={walletTitle}
          >
            <TrayIcon name="wallet" />
            {view.walletAddress ? (
              <span>{shortAddress(view.walletAddress)}</span>
            ) : null}
          </button>
          <button
            className={`trayAction ${view.trayOpen && view.trayView === "ideas" ? "on" : ""}`}
            type="button"
            data-action="tray-ideas"
            title="Ideas"
            aria-label="Ideas and voting"
          >
            <TrayIcon name="ideas" />
          </button>
          <button
            className={`trayAction ${view.trayOpen && view.trayView === "world" ? "on" : ""}`}
            type="button"
            data-action="tray-world"
            title="World"
            aria-label="World state"
          >
            <TrayIcon name="world" />
          </button>
        </div>
      </div>

      {view.trayOpen ? (
        <div className="trayBody">
          {view.participationError ? (
            <div
              className="trayError"
              title={view.participationError}
              aria-label={view.participationError}
            >
              !
            </div>
          ) : null}
          {view.trayView === "world" ? (
            <ParticipationWorld />
          ) : (
            <ParticipationIdeas />
          )}
        </div>
      ) : null}
    </section>
  );
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
          data-current-prompt-fact
          aria-label={`Exact resolved fact: ${fact}`}
          style={{
            marginLeft: "12px",
            paddingLeft: "12px",
            borderLeft: "1px solid rgba(231,188,83,.32)",
            color: "#e7bc53",
            fontSize: ".82em",
            fontWeight: 800,
            whiteSpace: "nowrap",
            letterSpacing: ".02em",
          }}
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

function OutsideInterfaceStyles() {
  return (
    <style>{`
      /* Episode history is part of the TV hardware, not neon UI chrome. */
      .episodeCard,
      .episodeCard.active,
      .episodeCard.live,
      .episodeCard.active.live,
      .programShelfSlot,
      .liveCap {
        outline: none !important;
        border-color: rgba(255,255,255,.09) !important;
      }

      .episodeCard,
      .episodeCard.active,
      .episodeCard.live,
      .episodeCard.active.live {
        box-shadow: none !important;
      }

      .episodeCard.active,
      .episodeCard.live,
      .episodeCard.active.live {
        background: rgba(255,255,255,.045) !important;
      }

      .episodeCard::before,
      .episodeCard::after,
      .episodeThumb::before,
      .episodeThumb::after {
        border-color: rgba(255,255,255,.1) !important;
        box-shadow: none !important;
      }

      .episodeCard.active,
      .episodeCard.live,
      .episodeCard.active.live {
        background: rgba(255,255,255,.045) !important;
      }

      .episodeCard::before,
      .episodeCard::after,
      .episodeThumb::before,
      .episodeThumb::after {
        border-color: rgba(255,255,255,.1) !important;
        box-shadow: none !important;
      }

      .episodeCard .episodeThumb,
      .episodeCard.active .episodeThumb,
      .episodeCard.live .episodeThumb,
      .episodeCard.active.live .episodeThumb {
        border-color: rgba(255,255,255,.09) !important;
        outline: none !important;
        box-shadow: inset 0 1px rgba(255,255,255,.035), 0 5px 16px rgba(0,0,0,.18) !important;
        transition: transform 130ms ease, filter 130ms ease, border-color 130ms ease !important;
      }

      .episodeCard:hover .episodeThumb {
        border-color: rgba(255,255,255,.18) !important;
        filter: brightness(1.06);
      }

      .episodeCard.active .episodeThumb {
        border-color: rgba(255,255,255,.28) !important;
        transform: translateY(-1px);
        filter: brightness(1.08) contrast(1.02);
        box-shadow: inset 0 1px rgba(255,255,255,.07), 0 7px 20px rgba(0,0,0,.28) !important;
      }

      .episodeCard > b,
      .episodeCard.active > b,
      .episodeCard.live > b {
        color: rgba(255,255,255,.58) !important;
        text-shadow: none !important;
      }

      .episodeCard.active > b {
        color: rgba(255,255,255,.9) !important;
      }

      .richHoverTooltip {
        position: fixed;
        z-index: 9999;
        width: min(350px, calc(100vw - 20px));
        min-height: 54px;
        display: grid;
        grid-template-columns: 1fr;
        gap: 0;
        padding: 9px;
        border: 1px solid rgba(255,255,255,.16);
        border-radius: 14px;
        background:
          linear-gradient(180deg, rgba(34,36,43,.96), rgba(13,14,18,.96));
        box-shadow:
          inset 0 1px rgba(255,255,255,.08),
          0 18px 60px rgba(0,0,0,.5),
          0 0 0 1px rgba(0,0,0,.2);
        color: rgba(255,255,255,.94);
        backdrop-filter: blur(22px) saturate(1.2);
        pointer-events: none;
        opacity: 0;
        visibility: hidden;
        transform: translateY(3px) scale(.985);
        transform-origin: center;
        transition: opacity 110ms ease, transform 110ms ease, visibility 110ms linear;
      }

      .richHoverTooltip.visible {
        opacity: 1;
        visibility: visible;
        transform: translateY(0) scale(1);
      }

      .richHoverTooltip.hasImage {
        grid-template-columns: 112px minmax(0,1fr);
        gap: 10px;
      }

      .richTooltipImage {
        width: 112px;
        height: 70px;
        object-fit: cover;
        border-radius: 9px;
        background: rgba(255,255,255,.035);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,.08);
      }

      .richTooltipCopy {
        min-width: 0;
        display: grid;
        align-content: center;
        gap: 5px;
        padding: 1px 2px;
      }

      .richTooltipKicker {
        font: 780 9px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .11em;
        color: rgba(255,255,255,.52);
      }

      .richTooltipBody {
        white-space: pre-line;
        overflow-wrap: anywhere;
        font-size: 12px;
        line-height: 1.4;
        color: rgba(255,255,255,.94);
      }

      .richTooltipMeta {
        white-space: pre-line;
        overflow-wrap: anywhere;
        font: 650 9px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        color: rgba(255,255,255,.46);
      }

      .richHoverTooltip::after {
        content: "";
        position: absolute;
        width: 9px;
        height: 9px;
        background: rgba(22,23,28,.96);
        border: solid rgba(255,255,255,.13);
        transform: rotate(45deg);
      }

      .richHoverTooltip[data-side="left"]::after {
        right: -5px;
        top: calc(50% - 5px);
        border-width: 1px 1px 0 0;
      }

      .richHoverTooltip[data-side="right"]::after {
        left: -5px;
        top: calc(50% - 5px);
        border-width: 0 0 1px 1px;
      }

      .richHoverTooltip[data-side="above"]::after {
        left: calc(50% - 5px);
        bottom: -5px;
        border-width: 0 1px 1px 0;
      }

      .richHoverTooltip[data-side="below"]::after {
        left: calc(50% - 5px);
        top: -5px;
        border-width: 1px 0 0 1px;
      }

      .outsideConsole {
        width: min(980px, calc(100vw - 150px));
        margin: 12px auto 0;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: start;
        gap: 10px;
        position: relative;
        z-index: 8;
      }

      .outsideTools {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .outsideTool {
        width: 42px;
        height: 42px;
        display: grid;
        place-items: center;
        padding: 0;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 14px;
        background: rgba(12,13,16,.72);
        color: rgba(255,255,255,.68);
        box-shadow: inset 0 1px rgba(255,255,255,.05), 0 8px 28px rgba(0,0,0,.18);
        backdrop-filter: blur(16px);
        cursor: pointer;
      }

      .outsideTool svg {
        width: 19px;
        height: 19px;
        fill: currentColor;
      }

      .outsideTool svg .stroke {
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .outsideTool.on {
        color: #fff;
        border-color: rgba(255,255,255,.32);
        background: rgba(34,36,42,.82);
      }

      .outsideProgram {
        min-height: 42px;
        display: grid;
        gap: 10px;
        padding: 10px 12px;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 16px;
        background: rgba(10,11,14,.68);
        box-shadow: inset 0 1px rgba(255,255,255,.04), 0 12px 36px rgba(0,0,0,.16);
        backdrop-filter: blur(18px);
        overflow: hidden;
      }

      .outsideProgramHead,
      .outsideFutureHead {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 20px;
      }

      .outsideProgramGlyph {
        width: 18px;
        text-align: center;
        opacity: .75;
      }

      .outsideProgramHead > b,
      .outsideFutureHead > b {
        font: 700 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        opacity: .72;
      }

      .outsideProgramHead > strong,
      .outsideFutureHead > strong {
        margin-left: auto;
        font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .04em;
        opacity: .82;
      }

      .outsideWinner {
        display: grid;
        gap: 3px;
        padding: 2px 2px 4px;
      }

      .outsideWinner > span {
        font-size: 14px;
        line-height: 1.35;
      }

      .outsideWinner > i,
      .outsideProgram .rankIdea > i {
        font-size: 10px;
        opacity: .46;
        font-style: normal;
      }

      .outsideProgram .liveRanking {
        display: grid;
        gap: 6px;
      }

      .outsideProgram .rankRow {
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px;
        padding: 7px 8px;
        border-radius: 10px;
        background: rgba(255,255,255,.035);
      }

      .outsideProgram .rankRow > em,
      .outsideProgram .rankRow > b {
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-style: normal;
        opacity: .7;
      }

      .outsideProgram .rankIdea {
        min-width: 0;
        display: grid;
        gap: 3px;
        position: relative;
        padding-bottom: 4px;
      }

      .outsideProgram .rankIdea > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }

      .outsideProgram .rankIdea > small {
        position: absolute;
        left: 0;
        bottom: 0;
        height: 1px;
        border-radius: 999px;
        background: currentColor;
        opacity: .28;
      }

      .outsideProgram .rankRow.winner {
        background: rgba(255,255,255,.075);
      }

      .outsideFuture {
        display: grid;
        gap: 7px;
        padding-top: 8px;
        border-top: 1px solid rgba(255,255,255,.08);
      }

      .outsideWorld {
        grid-column: 2;
        position: relative;
        padding: 14px 42px 14px 14px;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 16px;
        background: rgba(10,11,14,.86);
        box-shadow: 0 16px 52px rgba(0,0,0,.28);
        backdrop-filter: blur(22px);
      }

      .outsideWorldClose {
        position: absolute;
        top: 10px;
        right: 10px;
        width: 26px;
        height: 26px;
        border: 0;
        border-radius: 50%;
        background: rgba(255,255,255,.06);
        color: inherit;
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
      }

      .outsideWorldBody {
        display: grid;
        gap: 12px;
      }

      .outsideWorldLocation {
        display: grid;
        gap: 5px;
      }

      .outsideWorldLocation > b {
        font-size: 14px;
      }

      .outsideWorldLocation > p,
      .outsideWorldLocation > em {
        margin: 0;
        max-width: 76ch;
        font-size: 12px;
        line-height: 1.45;
        opacity: .7;
        font-style: normal;
      }

      .outsideWorldLocation > em {
        opacity: .92;
      }

      .outsideWorldGroup {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 7px;
      }

      .outsideWorldGroup article {
        display: grid;
        gap: 3px;
        padding: 9px 10px;
        border-radius: 10px;
        background: rgba(255,255,255,.035);
      }

      .outsideWorldGroup article > b {
        font-size: 11px;
      }

      .outsideWorldGroup article > span,
      .outsideWorldGroup article > small {
        font-size: 10px;
        line-height: 1.35;
        opacity: .68;
      }

      .outsideWorldGroup.compact article {
        padding-block: 7px;
      }

      .outsideThreads {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .outsideThreads > span {
        max-width: 46ch;
        padding: 6px 8px;
        border: 1px solid rgba(255,255,255,.08);
        border-radius: 999px;
        font-size: 10px;
        line-height: 1.25;
        opacity: .7;
      }

      .minimalTop .wordmark > b {
        display: none;
      }

      .participationTray {
        width: min(980px, calc(100vw - 150px));
        margin: 12px auto 0;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 17px;
        background: rgba(10,11,14,.72);
        box-shadow: inset 0 1px rgba(255,255,255,.04), 0 12px 40px rgba(0,0,0,.18);
        backdrop-filter: blur(18px);
        overflow: hidden;
        position: relative;
        z-index: 8;
      }

      .trayBar {
        min-height: 48px;
        display: grid;
        grid-template-columns: 34px minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px;
        padding: 7px 8px;
      }

      .trayToggle,
      .trayAction,
      .ideaForm > button {
        border: 0;
        color: rgba(255,255,255,.66);
        background: transparent;
        cursor: pointer;
      }

      .trayToggle {
        width: 34px;
        height: 34px;
        display: grid;
        place-items: center;
        border-radius: 11px;
      }

      .trayToggle svg,
      .trayAction svg,
      .ideaForm svg {
        width: 18px;
        height: 18px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .participationTray.open .trayToggle svg {
        transform: rotate(180deg);
      }

      .trayPulse {
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .trayPulse > i,
      .trayPulse > b,
      .trayPulse > small,
      .trayPulse > strong {
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-style: normal;
        opacity: .68;
      }

      .trayPulse > small {
        min-width: 18px;
        height: 18px;
        display: grid;
        place-items: center;
        border-radius: 999px;
        background: rgba(255,255,255,.07);
      }

      .trayPulse > strong {
        margin-left: 2px;
        opacity: .9;
      }

      .trayActions {
        display: flex;
        align-items: center;
        gap: 5px;
      }

      .trayAction {
        min-width: 34px;
        height: 34px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        padding: 0 8px;
        border: 1px solid transparent;
        border-radius: 11px;
      }

      .trayAction.on {
        color: #fff;
        border-color: rgba(255,255,255,.14);
        background: rgba(255,255,255,.06);
      }

      .trayAction.wallet > span {
        max-width: 105px;
        overflow: hidden;
        text-overflow: ellipsis;
        font: 650 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: nowrap;
      }

      .trayAction.wallet.connecting {
        opacity: .55;
      }

      .trayBody {
        position: relative;
        border-top: 1px solid rgba(255,255,255,.08);
        padding: 10px;
      }

      .trayError {
        position: absolute;
        top: 10px;
        right: 10px;
        width: 22px;
        height: 22px;
        display: grid;
        place-items: center;
        border-radius: 50%;
        background: rgba(255,255,255,.08);
        font: 800 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        z-index: 2;
      }

      .trayIdeas,
      .trayWorld {
        display: grid;
        gap: 10px;
      }

      .ideaForm {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 38px;
        gap: 7px;
      }

      .ideaForm > input {
        width: 100%;
        min-width: 0;
        height: 40px;
        border: 1px solid rgba(255,255,255,.1);
        border-radius: 12px;
        outline: none;
        background: rgba(255,255,255,.035);
        color: inherit;
        padding: 0 12px;
        font: inherit;
        font-size: 13px;
      }

      .ideaForm > input:focus {
        border-color: rgba(255,255,255,.24);
        background: rgba(255,255,255,.055);
      }

      .ideaForm > input::placeholder {
        color: rgba(255,255,255,.28);
      }

      .ideaForm > button {
        width: 38px;
        height: 40px;
        display: grid;
        place-items: center;
        border: 1px solid rgba(255,255,255,.1);
        border-radius: 12px;
        background: rgba(255,255,255,.045);
      }

      .ideaForm > button:disabled {
        opacity: .28;
        cursor: default;
      }

      .trayLocked {
        display: grid;
        gap: 3px;
        padding: 9px 10px;
        border-radius: 11px;
        background: rgba(255,255,255,.035);
      }

      .trayLocked > span {
        font-size: 12px;
        line-height: 1.4;
      }

      .trayLocked > i {
        font-size: 9px;
        font-style: normal;
        opacity: .45;
      }

      .trayBallot {
        display: grid;
        gap: 7px;
      }

      .trayBallotMeta {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 2px;
      }

      .trayBallotMeta > b,
      .trayBallotMeta > strong {
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        opacity: .65;
      }

      .trayBallotMeta > strong {
        margin-left: auto;
        opacity: .88;
      }

      .participationTray .liveRanking {
        display: grid;
        gap: 6px;
      }

      .participationTray .rankRow {
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px;
        min-width: 0;
        padding: 8px 9px;
        border: 1px solid transparent;
        border-radius: 10px;
        background: rgba(255,255,255,.035);
      }

      .participationTray .rankRow.interactive {
        cursor: pointer;
      }

      .participationTray .rankRow.interactive:hover {
        border-color: rgba(255,255,255,.12);
        background: rgba(255,255,255,.06);
      }

      .participationTray .rankRow.pending {
        opacity: .45;
      }

      .participationTray .rankRow > em,
      .participationTray .rankRow > b {
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-style: normal;
        opacity: .68;
      }

      .participationTray .rankIdea {
        min-width: 0;
        display: grid;
        gap: 3px;
        position: relative;
        padding-bottom: 4px;
      }

      .participationTray .rankIdea > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }

      .participationTray .rankIdea > i {
        font-size: 9px;
        font-style: normal;
        opacity: .42;
      }

      .participationTray .rankIdea > small {
        position: absolute;
        left: 0;
        bottom: 0;
        height: 1px;
        border-radius: 999px;
        background: currentColor;
        opacity: .28;
      }

      .trayWorldLocation {
        display: grid;
        gap: 5px;
        padding-right: 28px;
      }

      .trayWorldLocation > b {
        font-size: 14px;
      }

      .trayWorldLocation > p,
      .trayWorldLocation > em {
        margin: 0;
        max-width: 80ch;
        font-size: 12px;
        line-height: 1.45;
        font-style: normal;
        opacity: .68;
      }

      .trayWorldLocation > em {
        opacity: .92;
      }

      .trayWorldGrid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 7px;
      }

      .trayWorldGrid article {
        display: grid;
        gap: 3px;
        padding: 9px 10px;
        border-radius: 10px;
        background: rgba(255,255,255,.035);
      }

      .trayWorldGrid article > b {
        font-size: 11px;
      }

      .trayWorldGrid article > span,
      .trayWorldGrid article > small {
        font-size: 10px;
        line-height: 1.35;
        opacity: .66;
      }

      .trayThreads {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .trayThreads > span {
        max-width: 48ch;
        padding: 6px 8px;
        border: 1px solid rgba(255,255,255,.08);
        border-radius: 999px;
        font-size: 10px;
        line-height: 1.25;
        opacity: .7;
      }

      .watchDeck {
        overflow: visible !important;
      }

      .participationBoard {
        width: min(1040px, calc(100vw - 150px));
        margin: 10px auto 0;
        position: relative;
        z-index: 48;
        overflow: visible;
      }

      .participationDock {
        min-height: 46px;
        display: grid;
        grid-template-columns: 34px auto auto minmax(80px, 1fr) auto auto;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        position: relative;
        z-index: 3;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 15px;
        background:
          linear-gradient(180deg, rgba(25,27,32,.9), rgba(10,11,14,.9));
        box-shadow:
          inset 0 1px rgba(255,255,255,.055),
          0 12px 38px rgba(0,0,0,.24);
        backdrop-filter: blur(20px) saturate(1.15);
      }

      .boardToggle,
      .dockIdeaSummary,
      .walletMetric {
        border: 0;
        color: inherit;
        font: inherit;
      }

      .boardToggle {
        width: 34px;
        height: 34px;
        display: grid;
        place-items: center;
        padding: 0;
        border-radius: 10px;
        background: rgba(255,255,255,.035);
        color: rgba(255,255,255,.62);
        cursor: pointer;
      }

      .boardToggle:hover,
      .participationBoard.open .boardToggle {
        background: rgba(255,255,255,.075);
        color: rgba(255,255,255,.9);
      }

      .boardToggle svg,
      .participationMeta svg,
      .persistentIdeaForm svg,
      .ownIdeaActions svg,
      .viewerMetric svg,
      .walletMetric svg {
        width: 17px;
        height: 17px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .boardToggle svg {
        transition: transform 260ms cubic-bezier(.2,.75,.2,1);
      }

      .participationBoard.open .boardToggle svg {
        transform: rotate(180deg);
      }

      .viewerMetric,
      .episodeMetric,
      .walletMetric {
        height: 32px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: rgba(255,255,255,.62);
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: nowrap;
      }

      .viewerMetric,
      .episodeMetric {
        padding: 0 3px;
      }

      .episodeMetric {
        gap: 7px;
      }

      .episodeMetric > strong {
        opacity: .9;
      }

      .dockIdeaSummary {
        min-width: 0;
        height: 32px;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 9px;
        padding: 0 10px;
        border-radius: 10px;
        background: rgba(255,255,255,.025);
        color: rgba(255,255,255,.72);
        text-align: left;
        cursor: pointer;
      }

      .dockIdeaSummary:hover {
        background: rgba(255,255,255,.055);
        color: rgba(255,255,255,.92);
      }

      .dockIdeaSummary > span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
        line-height: 1;
      }

      .dockIdeaSummary > b,
      .dockIdeaSummary > i {
        font: 720 9px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-style: normal;
        opacity: .58;
        white-space: nowrap;
      }

      .walletMetric {
        border: 1px solid transparent;
        border-radius: 10px;
        padding: 0 8px;
        background: transparent;
        cursor: pointer;
      }

      .walletMetric:hover,
      .walletMetric.connected {
        border-color: rgba(255,255,255,.1);
        background: rgba(255,255,255,.045);
        color: rgba(255,255,255,.86);
      }

      .participationError {
        width: 20px;
        height: 20px;
        display: grid;
        place-items: center;
        border-radius: 50%;
        background: rgba(255,255,255,.08);
        font: 800 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-style: normal;
      }

      .participationSheet {
        position: absolute;
        left: 0;
        right: 0;
        bottom: calc(100% + 8px);
        height: clamp(310px, 48vh, 540px);
        z-index: 2;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,.135);
        border-radius: 20px;
        background:
          radial-gradient(circle at 50% 110%, rgba(255,255,255,.04), transparent 42%),
          linear-gradient(180deg, rgba(20,22,27,.955), rgba(8,9,12,.965));
        box-shadow:
          inset 0 1px rgba(255,255,255,.065),
          0 -10px 44px rgba(0,0,0,.24),
          0 28px 80px rgba(0,0,0,.5);
        backdrop-filter: blur(26px) saturate(1.18);
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
        transform: translateY(18px) scale(.985,.94);
        transform-origin: 50% 100%;
        transition:
          opacity 180ms ease,
          transform 320ms cubic-bezier(.16,.84,.24,1),
          visibility 0s linear 320ms;
      }

      .participationBoard.open .participationSheet {
        opacity: 1;
        visibility: visible;
        pointer-events: auto;
        transform: translateY(0) scale(1);
        transition:
          opacity 190ms ease,
          transform 330ms cubic-bezier(.16,.84,.24,1),
          visibility 0s linear 0s;
      }

      .participationColumns {
        height: 100%;
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(0, .92fr) minmax(0, 1.08fr);
      }

      .persistentWorld,
      .persistentIdeas {
        min-width: 0;
        min-height: 0;
        padding: 14px;
        overflow: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
      }

      .persistentWorld {
        border-right: 1px solid rgba(255,255,255,.075);
        display: grid;
        align-content: start;
        gap: 8px;
      }

      .worldLocationCard,
      .persistentWorldItems > button {
        width: 100%;
        text-align: left;
        border: 1px solid transparent;
        color: inherit;
        background: rgba(255,255,255,.026);
        cursor: pointer;
      }

      .worldLocationCard {
        display: grid;
        gap: 5px;
        padding: 10px 11px;
        border-radius: 12px;
      }

      .worldLocationCard:hover,
      .persistentWorldItems > button:hover {
        border-color: rgba(255,255,255,.11);
        background: rgba(255,255,255,.055);
      }

      .worldLocationCard > b { font-size: 13px; }
      .worldLocationCard > span {
        font-size: 11px;
        line-height: 1.4;
        opacity: .66;
      }

      .persistentWorldItems {
        display: grid;
        grid-template-columns: repeat(2, minmax(0,1fr));
        gap: 6px;
      }

      .persistentWorldItems > button {
        display: grid;
        gap: 3px;
        padding: 8px 9px;
        border-radius: 10px;
      }

      .persistentWorldItems > button > b { font-size: 11px; }
      .persistentWorldItems > button > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 10px;
        opacity: .58;
      }

      .persistentWorldItems.props > button { opacity: .86; }

      .persistentThreads {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }

      .persistentThreads > span {
        max-width: 46ch;
        padding: 5px 7px;
        border: 1px solid rgba(255,255,255,.065);
        border-radius: 999px;
        font-size: 9px;
        line-height: 1.25;
        opacity: .58;
      }

      .persistentIdeas {
        display: grid;
        align-content: start;
        gap: 7px;
      }

      .persistentIdeaForm {
        display: grid;
        grid-template-columns: minmax(0,1fr) 38px;
        gap: 7px;
        position: sticky;
        top: 0;
        z-index: 2;
        padding-bottom: 7px;
        background: linear-gradient(180deg, rgba(15,17,21,.98) 68%, rgba(15,17,21,0));
      }

      .persistentIdeaForm > input {
        min-width: 0;
        width: 100%;
        height: 38px;
        border: 1px solid rgba(255,255,255,.1);
        border-radius: 11px;
        outline: none;
        padding: 0 11px;
        background: rgba(255,255,255,.035);
        color: inherit;
        font: inherit;
        font-size: 12px;
      }

      .persistentIdeaForm > input:focus {
        border-color: rgba(255,255,255,.22);
        background: rgba(255,255,255,.055);
      }

      .persistentIdeaForm > input::placeholder { color: rgba(255,255,255,.27); }

      .persistentIdeaForm > button,
      .ownIdeaActions > button {
        border: 1px solid rgba(255,255,255,.09);
        border-radius: 10px;
        background: rgba(255,255,255,.04);
        color: rgba(255,255,255,.65);
        cursor: pointer;
      }

      .persistentIdeaForm > button {
        width: 38px;
        height: 38px;
        display: grid;
        place-items: center;
      }

      .persistentIdeaForm > button:disabled { opacity: .28; cursor: default; }

      .persistentProposalList {
        display: grid;
        gap: 6px;
      }

      .persistentProposal {
        min-width: 0;
        display: grid;
        grid-template-columns: minmax(0,1fr) auto;
        align-items: center;
        gap: 9px;
        padding: 9px 10px;
        border: 1px solid transparent;
        border-radius: 11px;
        background: rgba(255,255,255,.03);
      }

      .persistentProposal:hover {
        border-color: rgba(255,255,255,.1);
        background: rgba(255,255,255,.055);
      }

      .persistentProposal.own {
        grid-template-columns: minmax(0,1fr) auto auto;
        border-color: rgba(255,255,255,.11);
        background: rgba(255,255,255,.06);
        cursor: default;
      }

      .persistentProposal.pending { opacity: .45; }

      .persistentProposalText {
        min-width: 0;
        display: grid;
        gap: 3px;
      }

      .persistentProposalText > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
      }

      .persistentProposalText > i {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 9px;
        font-style: normal;
        opacity: .4;
      }

      .persistentProposal > b {
        font: 760 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        opacity: .78;
      }

      .proposalVote {
        height: 30px;
        min-width: 52px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        padding: 0 8px;
        border: 1px solid rgba(255,255,255,.1);
        border-radius: 9px;
        background: rgba(255,255,255,.045);
        color: rgba(255,255,255,.78);
        cursor: pointer;
      }
      .proposalVote:hover {
        transform: translateY(-1px);
        background: rgba(255,255,255,.09);
        border-color: rgba(255,255,255,.18);
      }
      .proposalVote:active { transform: translateY(0); }
      .proposalVote:disabled { opacity: .4; cursor: default; }
      .proposalVote svg { width: 13px; height: 13px; }
      .proposalVote > b {
        font: 760 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }

      .ownIdeaActions { display: flex; gap: 4px; }
      .ownIdeaActions > button {
        width: 27px;
        height: 27px;
        display: grid;
        place-items: center;
      }
      .ownIdeaActions svg { width: 13px; height: 13px; }

      .worldDetailShade {
        position: fixed;
        inset: 0;
        z-index: 90;
        display: grid;
        place-items: center;
        padding: 20px;
        background: rgba(0,0,0,.58);
        backdrop-filter: blur(8px);
      }

      .worldDetailModal {
        width: min(520px, 92vw);
        max-height: min(70vh, 620px);
        overflow: auto;
        position: relative;
        display: grid;
        gap: 9px;
        padding: 18px;
        border: 1px solid rgba(255,255,255,.13);
        border-radius: 16px;
        background: rgba(13,14,18,.96);
        box-shadow: 0 30px 90px rgba(0,0,0,.45);
      }

      .worldDetailModal > button {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: 50%;
        background: rgba(255,255,255,.06);
        color: inherit;
        cursor: pointer;
      }

      .worldDetailModal > b { padding-right: 30px; font-size: 15px; }
      .worldDetailModal > p {
        margin: 0;
        font-size: 12px;
        line-height: 1.5;
        opacity: .72;
      }


      /* v12: make the history rail own its vertical space. Removing decorative
         rail children in v11 exposed the old intrinsic-height behavior, which
         could collapse .episodeList to roughly one card. */
      .episodeShelf {
        height: 100dvh !important;
        max-height: 100dvh !important;
        min-height: 0 !important;
        display: flex !important;
        flex-direction: column !important;
        align-items: stretch !important;
        overflow: hidden !important;
        box-sizing: border-box !important;
      }

      .episodeShelf > .liveCap {
        flex: 0 0 auto !important;
      }

      .episodeShelf > .episodeList {
        flex: 1 1 0 !important;
        height: 0 !important;
        min-height: 0 !important;
        max-height: none !important;
        overflow-x: hidden !important;
        overflow-y: auto !important;
        overscroll-behavior: contain;
        display: flex !important;
        flex-direction: column !important;
        align-items: stretch !important;
        gap: 8px !important;
        padding-bottom: 12px !important;
        scrollbar-width: thin;
      }

      .episodeList > .episodeCard {
        flex: 0 0 auto !important;
        width: 100% !important;
        min-width: 0 !important;
      }

      .episodeList > .programShelfSlot {
        flex: 0 0 66px !important;
        width: 100% !important;
        min-width: 0 !important;
        display: grid !important;
        grid-template-columns: minmax(0, 1fr) 24px;
        align-items: center;
        gap: 8px;
        padding: 8px;
        border: 1px solid rgba(255,255,255,.09) !important;
        border-radius: 13px;
        background: linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.012));
        box-shadow: inset 0 1px rgba(255,255,255,.025), 0 5px 18px rgba(0,0,0,.18) !important;
        box-sizing: border-box;
      }

      .programShelfVisual {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 0;
        height: 46px;
        border-radius: 9px;
        background: rgba(0,0,0,.32);
        overflow: hidden;
      }

      .programShelfPulse {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: rgba(255,255,255,.42);
        box-shadow: 0 0 0 5px rgba(255,255,255,.025);
      }

      .programShelfSlot.phase-locked .programShelfPulse,
      .programShelfSlot.phase-planning .programShelfPulse,
      .programShelfSlot.phase-rendering .programShelfPulse,
      .programShelfSlot.phase-finalizing .programShelfPulse {
        animation: programShelfBreath 1.15s ease-in-out infinite alternate;
      }

      .programShelfVisual > small {
        position: absolute;
        right: 6px;
        bottom: 4px;
        font-size: 9px;
        opacity: .55;
      }

      .programShelfSlot > b {
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        opacity: .7;
        text-align: center;
      }

      @keyframes programShelfBreath {
        from { transform: scale(.9); opacity: .45; }
        to { transform: scale(1.14); opacity: 1; }
      }

      .episodeCard.future {
        opacity: .58;
      }

      /* v12 drawer: one intentional dock row, with the sheet floating upward
         over the set instead of reflowing the TV. */
      .participationBoard {
        width: min(1080px, calc(100vw - 176px));
        margin-top: 14px;
        z-index: 58;
      }

      .participationDock {
        min-height: 48px;
        grid-template-columns: 36px auto minmax(0, 1fr) auto auto auto;
        gap: 9px;
        padding: 6px 9px;
        border-radius: 16px;
        background:
          linear-gradient(180deg, rgba(27,29,34,.94), rgba(11,12,15,.94));
        box-shadow:
          inset 0 1px rgba(255,255,255,.065),
          inset 0 -1px rgba(0,0,0,.32),
          0 10px 34px rgba(0,0,0,.28);
      }

      .viewerMetric,
      .proposalMetric,
      .walletMetric {
        height: 34px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        white-space: nowrap;
        color: rgba(255,255,255,.62);
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }

      .viewerMetric,
      .proposalMetric {
        min-width: 40px;
        padding: 0 5px;
      }

      .proposalMetric svg {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .episodeMetric { display: none !important; }

      .dockIdeaSummary {
        height: 34px;
        padding: 0 12px;
        border: 1px solid rgba(255,255,255,.045);
        background: rgba(255,255,255,.022);
      }

      .dockIdeaSummary:hover {
        border-color: rgba(255,255,255,.095);
      }

      .participationSheet {
        bottom: calc(100% + 10px);
        height: min(64vh, 660px);
        min-height: 370px;
        border-radius: 22px;
        background:
          radial-gradient(circle at 72% 115%, rgba(255,255,255,.05), transparent 42%),
          linear-gradient(180deg, rgba(24,26,31,.975), rgba(8,9,12,.982));
        box-shadow:
          inset 0 1px rgba(255,255,255,.075),
          inset 0 -1px rgba(0,0,0,.5),
          0 -14px 50px rgba(0,0,0,.2),
          0 34px 100px rgba(0,0,0,.58);
        transform: translateY(26px) scale(.988,.93);
      }

      .drawerGrab {
        height: 20px;
        display: grid;
        place-items: center;
        border-bottom: 1px solid rgba(255,255,255,.055);
        background: rgba(255,255,255,.012);
      }

      .drawerGrab > i {
        width: 42px;
        height: 3px;
        border-radius: 999px;
        background: rgba(255,255,255,.15);
      }

      .participationColumns {
        height: calc(100% - 20px);
        grid-template-columns: minmax(0, .88fr) minmax(0, 1.12fr);
      }

      .persistentWorld,
      .persistentIdeas {
        padding: 16px;
      }

      .persistentWorld {
        gap: 10px;
        background: linear-gradient(90deg, rgba(255,255,255,.012), transparent 58%);
      }

      .worldLocationCard {
        padding: 13px 14px;
        border-radius: 14px;
        background: rgba(255,255,255,.035);
      }

      .worldLocationCard > b {
        font-size: 14px;
      }

      .worldLocationCard > span {
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        overflow: hidden;
        font-size: 11px;
        line-height: 1.45;
      }

      .persistentWorldItems {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 7px;
      }

      .persistentWorldItems > button {
        min-height: 58px;
        align-content: center;
        padding: 10px 11px;
        border-radius: 12px;
        background: rgba(255,255,255,.028);
      }

      .persistentIdeas {
        gap: 9px;
      }

      .persistentIdeaForm {
        grid-template-columns: minmax(0, 1fr) 42px;
        gap: 8px;
        padding-bottom: 10px;
        background: linear-gradient(180deg, rgba(18,20,24,.99) 74%, rgba(18,20,24,0));
      }

      .persistentIdeaForm > input,
      .persistentIdeaForm > button {
        height: 42px;
      }

      .persistentIdeaForm > button {
        width: 42px;
      }

      .persistentProposalList {
        gap: 7px;
      }

      .persistentProposal {
        min-height: 50px;
        padding: 10px 11px;
        border-color: rgba(255,255,255,.035);
        background: rgba(255,255,255,.028);
      }

      .persistentProposal.own {
        border-color: rgba(255,255,255,.14);
        background: rgba(255,255,255,.06);
      }

      .persistentProposalText > span {
        white-space: normal;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        line-height: 1.35;
      }

      @media (max-width: 760px) {
        .participationBoard {
          width: min(94vw, 680px);
          margin-top: 8px;
        }

        .participationDock {
          grid-template-columns: 32px auto auto minmax(0,1fr) auto;
          gap: 5px;
          padding-inline: 6px;
        }

        .participationDock > .participationError { display: none; }
        .walletMetric > b { display: none; }
        .dockIdeaSummary { padding-inline: 8px; }

        .participationSheet {
          height: min(68vh, 560px);
          border-radius: 17px;
        }

        .participationColumns {
          display: block;
          overflow: auto;
        }

        .persistentWorld,
        .persistentIdeas {
          overflow: visible;
        }

        .persistentWorld {
          border-right: 0;
          border-bottom: 1px solid rgba(255,255,255,.07);
        }
        .persistentWorldItems { grid-template-columns: 1fr 1fr; }
        .participationTray {
          width: min(94vw, 680px);
          margin-top: 8px;
        }

        .trayBar {
          grid-template-columns: 30px minmax(0, 1fr) auto;
          padding-inline: 6px;
        }

        .trayAction.wallet > span {
          display: none;
        }

        .outsideConsole {
          width: min(94vw, 680px);
          grid-template-columns: 1fr;
          margin-top: 8px;
        }

        .outsideTools {
          flex-direction: row;
        }

        .outsideWorld {
          grid-column: 1;
        }
      }


      /* v15 — PumpTV brass / silver hardware language. */
      :root {
        --pump-gold: #c8ff00;
        --pump-gold-hi: #d9ff33;
        --pump-gold-low: #86ad00;
        --pump-silver: #f6f7f2;
        --pump-silver-dim: #747a70;
        --pump-black: #000000;
        --pump-panel: #080a07;
      }

      .minimalTop .wordmark {
        width: 76px !important;
        height: 76px !important;
        display: block !important;
        padding: 0 !important;
        border: 0 !important;
        border-radius: 0 !important;
        overflow: hidden !important;
        background: transparent !important;
        box-shadow: none !important;
      }
      .pumptvLogo {
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
        filter: drop-shadow(0 5px 14px rgba(0,0,0,.35));
      }

      .statusDot.ready,
      .powerLamp.ready,
      .statusDot.work,
      .powerLamp.work {
        background: var(--pump-gold-hi) !important;
        box-shadow: 0 0 0 1px rgba(200,255,0,.22), 0 0 12px rgba(200,255,0,.28) !important;
      }

      /* These are machined hardware keys now, not glowing arcade knobs. */
      .knobStack {
        display: flex !important;
        flex-direction: column !important;
        align-items: center !important;
        gap: 10px !important;
      }
      .knobControl {
        position: relative !important;
        width: 48px !important;
        height: 38px !important;
        min-width: 48px !important;
        min-height: 38px !important;
        padding: 0 !important;
        display: grid !important;
        place-items: center !important;
        border: 1px solid rgba(200,201,203,.25) !important;
        border-radius: 12px !important;
        outline: 0 !important;
        color: rgba(200,201,203,.72) !important;
        background:
          linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.015)),
          #151719 !important;
        box-shadow:
          inset 0 1px rgba(255,255,255,.09),
          inset 0 -2px rgba(0,0,0,.55),
          0 5px 12px rgba(0,0,0,.25) !important;
        cursor: pointer !important;
        transform: none !important;
      }
      .knobControl:hover {
        border-color: rgba(200,201,203,.42) !important;
        color: var(--pump-silver) !important;
        transform: translateY(-1px) !important;
      }
      .knobControl:active {
        transform: translateY(1px) !important;
        box-shadow: inset 0 2px 5px rgba(0,0,0,.58) !important;
      }
      .knobControl.on {
        color: var(--pump-gold-hi) !important;
        border-color: rgba(200,255,0,.48) !important;
        background:
          linear-gradient(180deg, rgba(200,255,0,.12), rgba(255,255,255,.015)),
          #171713 !important;
      }
      .knobNeedle {
        position: absolute !important;
        top: 4px !important;
        right: 7px !important;
        width: 11px !important;
        height: 2px !important;
        border: 0 !important;
        border-radius: 999px !important;
        background: var(--pump-silver-dim) !important;
        transform: rotate(-48deg) !important;
        transform-origin: right center !important;
        opacity: .38 !important;
        box-shadow: none !important;
      }
      .knobControl.on .knobNeedle {
        background: var(--pump-gold-hi) !important;
        opacity: .95 !important;
      }
      .knobIcon {
        position: relative !important;
        inset: auto !important;
        width: 20px !important;
        height: 20px !important;
        display: grid !important;
        place-items: center !important;
        border: 0 !important;
        background: transparent !important;
      }
      .knobIcon svg {
        width: 19px !important;
        height: 19px !important;
        fill: currentColor !important;
      }
      .knobIcon svg .stroke {
        fill: none !important;
        stroke: currentColor !important;
        stroke-width: 1.7 !important;
      }

      /* Selected != neon border: a small brass play index plus mechanical lift. */
      .episodeCard {
        position: relative !important;
        opacity: .72;
        transition: opacity 140ms ease, transform 140ms ease, background 140ms ease !important;
      }
      .episodeCard:hover { opacity: .9; }
      .episodeCard.active {
        opacity: 1 !important;
        transform: translateX(-2px) !important;
        background: linear-gradient(90deg, rgba(200,255,0,.09), rgba(200,201,203,.025)) !important;
      }
      .episodeCard.active > b::before {
        content: "▶";
        color: var(--pump-gold-hi);
        font-size: 7px;
        margin-right: 4px;
        vertical-align: 1px;
      }
      .episodeCard.live .episodeThumb > em {
        color: var(--pump-gold-hi) !important;
        text-shadow: 0 0 8px rgba(200,255,0,.45) !important;
      }
      .episodeCard.active .episodeThumb {
        border-color: rgba(200,255,0,.32) !important;
        box-shadow:
          inset 0 1px rgba(255,255,255,.07),
          0 7px 20px rgba(0,0,0,.30),
          -3px 0 0 rgba(200,255,0,.72) !important;
      }
      .liveCap.active { color: var(--pump-gold-hi) !important; }

      .programShelfSlot {
        border-color: rgba(200,255,0,.24) !important;
        background: linear-gradient(180deg, rgba(200,255,0,.07), rgba(255,255,255,.012)) !important;
      }
      .programShelfPulse { color: var(--pump-gold-hi) !important; }

      /* The persistent board is a true ranking. Own ideas remain editable but are
         no longer artificially pinned above higher-scoring proposals. */
      .persistentProposalList {
        display: grid !important;
        gap: 8px !important;
      }
      .persistentProposal {
        display: grid !important;
        grid-template-columns: 24px minmax(0, 1fr) auto auto !important;
        align-items: center !important;
        gap: 9px !important;
        min-width: 0 !important;
        padding: 10px 11px !important;
        border: 1px solid rgba(200,201,203,.10) !important;
        border-radius: 13px !important;
        background: linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.014)) !important;
      }
      .persistentProposal:not(.own) {
        grid-template-columns: 24px minmax(0, 1fr) auto !important;
      }
      .persistentProposal:first-child {
        border-color: rgba(200,255,0,.26) !important;
        background: linear-gradient(180deg, rgba(200,255,0,.055), rgba(255,255,255,.015)) !important;
      }
      .persistentProposal.own {
        border-color: rgba(200,201,203,.24) !important;
        background: linear-gradient(180deg, rgba(200,201,203,.055), rgba(255,255,255,.014)) !important;
      }
      .proposalRank {
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
        font-style: normal !important;
        color: var(--pump-silver-dim) !important;
        text-align: center;
      }
      .persistentProposal:first-child .proposalRank { color: var(--pump-gold-hi) !important; }
      .persistentProposalText { min-width: 0 !important; display: grid !important; gap: 4px !important; }
      .persistentProposalText > span {
        font-size: 13px !important;
        line-height: 1.35 !important;
        white-space: normal !important;
      }
      .persistentProposalText > i {
        min-width: 0;
        display: flex !important;
        align-items: center !important;
        flex-wrap: wrap !important;
        gap: 7px !important;
        font: 600 9px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
        font-style: normal !important;
        color: rgba(200,201,203,.46) !important;
      }
      .persistentProposalText > i > code {
        color: rgba(217,255,51,.72) !important;
        font: inherit !important;
      }
      .persistentProposalText > i > small {
        font: inherit !important;
        color: rgba(200,201,203,.52) !important;
      }
      .proposalTotal {
        min-width: 34px;
        text-align: right;
        color: var(--pump-gold-hi) !important;
        font: 750 12px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;
      }
      .proposalVote,
      .ownIdeaActions > button,
      .persistentIdeaForm > button,
      .boardToggle,
      .walletMetric {
        border-color: rgba(200,201,203,.16) !important;
        color: var(--pump-silver) !important;
        background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.015)) !important;
        box-shadow: inset 0 1px rgba(255,255,255,.05) !important;
      }
      .proposalVote:hover,
      .persistentIdeaForm > button:hover,
      .boardToggle:hover,
      .walletMetric:hover {
        border-color: rgba(200,255,0,.38) !important;
        color: var(--pump-gold-hi) !important;
      }
      .proposalVote > b { color: var(--pump-gold-hi) !important; }

      .participationBoard,
      .participationSheet,
      .participationDock {
        --tray-accent: var(--pump-gold);
      }
      .participationDock,
      .participationSheet {
        border-color: rgba(200,201,203,.12) !important;
        background-color: rgba(13,14,15,.95) !important;
      }
      .drawerGrab > i { background: linear-gradient(90deg, var(--pump-silver-dim), var(--pump-gold), var(--pump-silver-dim)) !important; }
      .dockIdeaSummary > b,
      .walletMetric.connected { color: var(--pump-gold-hi) !important; }

      /* v21 — quieter hardware: icon/state/depth, no decorative needles. */
      .minimalTop .wordmark {
        width: 66px !important;
        height: 66px !important;
        opacity: .94;
      }
      .pumptvLogo {
        mix-blend-mode: lighten;
        filter: drop-shadow(0 4px 10px rgba(0,0,0,.28)) saturate(.92) !important;
      }

      .knobStack { gap: 8px !important; }
      .knobControl {
        width: 46px !important;
        height: 34px !important;
        min-width: 46px !important;
        min-height: 34px !important;
        border-radius: 9px !important;
        border-color: rgba(200,201,203,.20) !important;
        color: rgba(200,201,203,.58) !important;
        background:
          linear-gradient(180deg, rgba(255,255,255,.065), rgba(255,255,255,.012) 54%, rgba(0,0,0,.08)),
          #151617 !important;
        box-shadow:
          inset 0 1px rgba(255,255,255,.08),
          inset 0 -1px 0 rgba(0,0,0,.72),
          0 3px 0 rgba(0,0,0,.46),
          0 6px 12px rgba(0,0,0,.18) !important;
      }
      .knobControl::after {
        content: "";
        position: absolute;
        right: 5px;
        top: 5px;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: rgba(125,128,133,.34);
        box-shadow: inset 0 1px rgba(255,255,255,.12);
      }
      .knobControl.on::after {
        background: var(--pump-gold-hi);
        box-shadow: 0 0 5px rgba(217,255,51,.26);
      }
      .knobControl[data-control="fullscreen"]::after { display: none; }
      .knobControl:hover {
        color: var(--pump-silver) !important;
        border-color: rgba(200,201,203,.34) !important;
        transform: translateY(-1px) !important;
      }
      .knobControl:active {
        transform: translateY(2px) !important;
        box-shadow:
          inset 0 2px 5px rgba(0,0,0,.54),
          inset 0 1px rgba(255,255,255,.035),
          0 1px 0 rgba(0,0,0,.42) !important;
      }
      .knobControl.on {
        color: var(--pump-gold-hi) !important;
        border-color: rgba(200,255,0,.34) !important;
        background:
          linear-gradient(180deg, rgba(200,255,0,.09), rgba(255,255,255,.012) 58%, rgba(0,0,0,.09)),
          #171714 !important;
      }
      .knobNeedle { display: none !important; }
      .knobIcon, .knobIcon svg {
        width: 18px !important;
        height: 18px !important;
      }

      /* Episode state reads as physical indexing, not border decoration. */
      .episodeCard {
        opacity: .68 !important;
        transform: none !important;
        background: rgba(255,255,255,.012) !important;
      }
      .episodeCard:hover {
        opacity: .88 !important;
        transform: translateX(-1px) !important;
      }
      .episodeCard.active {
        opacity: 1 !important;
        transform: translateX(-4px) !important;
        background: linear-gradient(90deg, rgba(200,255,0,.07), rgba(255,255,255,.022)) !important;
        box-shadow: 0 5px 14px rgba(0,0,0,.18) !important;
      }
      .episodeCard.active::after {
        content: "" !important;
        position: absolute !important;
        left: -2px !important;
        top: 50% !important;
        width: 3px !important;
        height: 24px !important;
        border-radius: 1px 3px 3px 1px !important;
        transform: translateY(-50%) !important;
        background: linear-gradient(180deg, var(--pump-gold-hi), var(--pump-gold-low)) !important;
        box-shadow: 0 0 7px rgba(200,255,0,.20) !important;
      }
      .episodeCard.active > b::before { content: none !important; }
      .episodeCard.active > b { color: var(--pump-gold-hi) !important; }
      .episodeCard.active .episodeThumb {
        border-color: rgba(200,201,203,.20) !important;
        box-shadow: inset 0 1px rgba(255,255,255,.055), 0 6px 15px rgba(0,0,0,.24) !important;
      }
      .episodeCard.live .episodeThumb > em {
        color: #ff596b !important;
        text-shadow: 0 0 7px rgba(255,89,107,.38) !important;
      }

      /* Proposals read as ranked rows rather than a pile of pills. */
      .persistentProposalList { gap: 6px !important; }
      .persistentProposal {
        min-height: 52px !important;
        padding: 8px 9px !important;
        border-radius: 9px !important;
        border-color: rgba(200,201,203,.075) !important;
        background: rgba(255,255,255,.018) !important;
        box-shadow: inset 0 1px rgba(255,255,255,.022) !important;
      }
      .persistentProposal:hover {
        border-color: rgba(200,201,203,.14) !important;
        background: rgba(255,255,255,.03) !important;
      }
      .persistentProposal:first-child {
        border-color: rgba(200,255,0,.18) !important;
        background: linear-gradient(90deg, rgba(200,255,0,.045), rgba(255,255,255,.016)) !important;
      }
      .persistentProposal.own {
        border-color: rgba(200,201,203,.16) !important;
        background: rgba(200,201,203,.026) !important;
      }
      .proposalRank {
        font-size: 9px !important;
        opacity: .82;
      }
      .persistentProposalText { gap: 3px !important; }
      .persistentProposalText > span {
        font-size: 12px !important;
        line-height: 1.28 !important;
      }
      .persistentProposalText > i {
        gap: 6px !important;
        font-size: 8px !important;
      }
      .proposalTotal { min-width: 26px !important; font-size: 11px !important; }
      .proposalVote {
        min-width: 44px !important;
        height: 29px !important;
        padding: 0 7px !important;
        border-radius: 7px !important;
        gap: 4px !important;
      }
      .ownIdeaActions { gap: 3px !important; }
      .ownIdeaActions > button {
        width: 28px !important;
        height: 28px !important;
        border-radius: 7px !important;
      }
      .persistentIdeaForm > input {
        border-radius: 9px 0 0 9px !important;
      }
      .persistentIdeaForm > button {
        border-radius: 0 9px 9px 0 !important;
      }
      .walletMetric, .boardToggle { border-radius: 8px !important; }

      /* v23: denser drawer + less dashboard-like hierarchy. */
      .participationSheet {
        height: clamp(300px, 40vh, 455px) !important;
        border-radius: 16px !important;
      }
      .drawerGrab { height: 24px !important; }
      .drawerGrab > i {
        width: 42px !important;
        height: 3px !important;
        opacity: .66 !important;
      }
      .participationColumns {
        grid-template-columns: minmax(270px, .72fr) minmax(0, 1.28fr) !important;
      }
      .persistentWorld,
      .persistentIdeas {
        padding: 11px 12px 12px !important;
      }
      .persistentWorld {
        gap: 7px !important;
      }
      .worldLocationCard {
        gap: 4px !important;
        padding: 9px 10px !important;
        border-radius: 9px !important;
      }
      .worldLocationCard > b {
        font-size: 12px !important;
      }
      .worldLocationCard > span {
        display: -webkit-box !important;
        overflow: hidden !important;
        -webkit-box-orient: vertical !important;
        -webkit-line-clamp: 2 !important;
        font-size: 10px !important;
        line-height: 1.32 !important;
      }
      .persistentWorldItems {
        grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)) !important;
        gap: 5px !important;
      }
      .persistentWorldItems > button {
        min-height: 49px !important;
        padding: 7px 8px !important;
        border-radius: 8px !important;
      }
      .persistentWorldItems > button > b { font-size: 10px !important; }
      .persistentWorldItems > button > span { font-size: 9px !important; }
      .persistentThreads {
        display: grid !important;
        gap: 3px !important;
      }
      .persistentThreads > span {
        max-width: none !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        padding: 3px 2px !important;
        border: 0 !important;
        border-radius: 0 !important;
        font-size: 8px !important;
        line-height: 1.2 !important;
        opacity: .42 !important;
      }
      .persistentThreads > span::before {
        content: "·";
        margin-right: 5px;
        color: var(--pump-gold-low);
      }
      .persistentIdeas {
        gap: 6px !important;
      }
      .persistentIdeaForm {
        grid-template-columns: minmax(0,1fr) 34px !important;
        gap: 5px !important;
        padding-bottom: 6px !important;
      }
      .persistentIdeaForm > input,
      .persistentIdeaForm > button {
        height: 34px !important;
      }
      .persistentIdeaForm > button { width: 34px !important; }
      .persistentProposal {
        min-height: 47px !important;
        padding: 7px 8px !important;
      }
      .persistentProposalText > span {
        font-size: 11px !important;
      }
      .persistentProposalText > i {
        font-size: 7.5px !important;
      }
      .participationDock {
        min-height: 42px !important;
        padding: 4px 7px !important;
        gap: 6px !important;
        border-radius: 12px !important;
      }
      .boardToggle {
        width: 31px !important;
        height: 31px !important;
      }
      .dockIdeaSummary,
      .viewerMetric,
      .walletMetric { height: 30px !important; }
      .dockIdeaSummary { padding: 0 9px !important; }

      /* Selected episode: underline the media itself instead of a rail-side tab. */
      .episodeCard.active {
        transform: translateX(-2px) !important;
      }
      .episodeCard.active::after {
        content: none !important;
      }
      .episodeCard .episodeThumb {
        position: relative !important;
        overflow: visible !important;
      }
      .episodeCard.active .episodeThumb::after {
        content: "" !important;
        position: absolute !important;
        left: 50% !important;
        bottom: -5px !important;
        width: 28px !important;
        height: 3px !important;
        transform: translateX(-50%) !important;
        border: 0 !important;
        border-radius: 2px !important;
        background: linear-gradient(90deg, var(--pump-gold-low), var(--pump-gold-hi), var(--pump-gold-low)) !important;
        box-shadow: 0 1px 5px rgba(200,255,0,.24) !important;
      }
      .episodeCard.active > b {
        color: var(--pump-gold-hi) !important;
      }

      /* v24: open drawer is a control console, not a second dashboard. */
      .participationSheet {
        height: auto !important;
        max-height: min(46vh, 430px) !important;
      }
      .participationColumns {
        height: auto !important;
        max-height: calc(min(46vh, 430px) - 24px) !important;
      }
      .persistentWorld,
      .persistentIdeas {
        max-height: calc(min(46vh, 430px) - 24px) !important;
      }
      .participationBoard.open .participationDock {
        display: flex !important;
        align-items: center !important;
        min-height: 38px !important;
        padding: 3px 6px !important;
      }
      .participationBoard.open .dockIdeaSummary,
      .participationBoard.open .proposalMetric {
        display: none !important;
      }
      .participationBoard.open .walletMetric {
        margin-left: auto !important;
      }
      .participationBoard.open .participationError {
        flex: 0 0 auto !important;
      }
      .participationBoard.open .boardToggle,
      .participationBoard.open .viewerMetric,
      .participationBoard.open .walletMetric {
        height: 28px !important;
      }
      .participationBoard.open .boardToggle {
        width: 29px !important;
      }
      .participationBoard.open .viewerMetric {
        padding-inline: 7px !important;
      }

      /* Let the proposal list carry the visual hierarchy; chrome stays quiet. */
      .persistentIdeas {
        background: linear-gradient(180deg, rgba(255,255,255,.009), transparent 34%) !important;
      }
      .persistentIdeaForm {
        padding: 0 0 7px !important;
      }
      .persistentProposalList {
        gap: 4px !important;
      }
      .persistentProposal {
        min-height: 44px !important;
        padding: 6px 7px !important;
        border-radius: 7px !important;
      }
      .persistentProposalText > span {
        font-size: 11px !important;
        line-height: 1.22 !important;
      }
      .persistentProposalText > i {
        opacity: .46 !important;
        letter-spacing: .01em !important;
      }
      .proposalVote {
        min-width: 40px !important;
        height: 27px !important;
        padding-inline: 6px !important;
        border-radius: 6px !important;
      }
      .proposalVote svg {
        width: 11px !important;
        height: 11px !important;
      }
      .ownIdeaActions > button {
        width: 26px !important;
        height: 26px !important;
        border-radius: 6px !important;
      }

      /* World state is reference material: compact until intentionally opened. */
      .persistentWorld {
        background: rgba(0,0,0,.055) !important;
      }
      .worldLocationCard {
        min-height: 0 !important;
      }
      .persistentWorldItems > button {
        min-height: 44px !important;
      }
      .persistentThreads {
        margin-top: 1px !important;
      }
      .persistentThreads > span:nth-child(n+5) {
        display: none !important;
      }

      /* Rail state: selected is brighter and indexed, live is independent. */
      .episodeCard.active {
        opacity: 1 !important;
        filter: brightness(1.05) !important;
      }
      .episodeCard:not(.active) .episodeThumb {
        filter: saturate(.86) brightness(.9) !important;
      }
      .episodeCard.active .episodeThumb::after {
        bottom: -4px !important;
        width: 24px !important;
        height: 2px !important;
        box-shadow: 0 1px 4px rgba(200,255,0,.18) !important;
      }

      /* v25: scene index + ranked control surface. */
      .participationSheet {
        background:
          linear-gradient(180deg, rgba(255,255,255,.018), transparent 18%),
          #111316 !important;
        border-color: rgba(200,201,203,.11) !important;
        box-shadow: 0 -16px 48px rgba(0,0,0,.34), inset 0 1px rgba(255,255,255,.035) !important;
      }
      .participationColumns {
        grid-template-columns: minmax(230px, .58fr) minmax(0, 1.42fr) !important;
      }
      .persistentWorld {
        padding: 9px 10px 10px !important;
        gap: 5px !important;
        border-right-color: rgba(255,255,255,.055) !important;
        background: rgba(0,0,0,.09) !important;
      }
      .worldLocationCard {
        padding: 8px 9px !important;
        border: 0 !important;
        border-bottom: 1px solid rgba(255,255,255,.055) !important;
        border-radius: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
      }
      .worldLocationCard:hover {
        background: rgba(255,255,255,.025) !important;
      }
      .worldLocationCard > b {
        color: rgba(245,245,242,.93) !important;
        font-size: 11px !important;
      }
      .worldLocationCard > span {
        -webkit-line-clamp: 1 !important;
        opacity: .58 !important;
        font-size: 9px !important;
      }
      .persistentWorldItems {
        grid-template-columns: 1fr !important;
        gap: 0 !important;
      }
      .persistentWorldItems > button {
        min-height: 34px !important;
        display: grid !important;
        grid-template-columns: minmax(88px,.72fr) minmax(0,1.28fr) !important;
        align-items: center !important;
        gap: 8px !important;
        padding: 5px 8px !important;
        border: 0 !important;
        border-bottom: 1px solid rgba(255,255,255,.04) !important;
        border-radius: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
        text-align: left !important;
      }
      .persistentWorldItems > button:hover {
        background: rgba(255,255,255,.025) !important;
      }
      .persistentWorldItems > button > b {
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        color: rgba(239,239,236,.88) !important;
      }
      .persistentWorldItems > button > span {
        overflow: hidden !important;
        text-overflow: ellipsis !important;
        white-space: nowrap !important;
        opacity: .48 !important;
        text-align: right !important;
      }
      .persistentWorldItems.props > button {
        opacity: .72 !important;
      }
      .persistentThreads {
        display: flex !important;
        align-items: center !important;
        gap: 5px !important;
        min-height: 23px !important;
        padding: 3px 6px 0 !important;
        overflow: hidden !important;
      }
      .persistentThreads > span {
        flex: 1 1 0 !important;
        min-width: 0 !important;
        padding: 0 !important;
        font-size: 8px !important;
        opacity: .38 !important;
      }
      .persistentThreads > span::before { content: none !important; }
      .persistentThreads > button {
        flex: 0 0 auto !important;
        height: 20px !important;
        min-width: 26px !important;
        padding: 0 6px !important;
        border: 1px solid rgba(200,255,0,.18) !important;
        border-radius: 5px !important;
        background: rgba(200,255,0,.045) !important;
        color: var(--pump-gold) !important;
        font: 700 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
      }

      .persistentIdeas {
        padding: 9px 10px 10px !important;
      }
      .persistentIdeaForm {
        gap: 0 !important;
        padding-bottom: 7px !important;
      }
      .persistentIdeaForm > input {
        height: 32px !important;
        border-radius: 7px 0 0 7px !important;
        border-right: 0 !important;
        background: rgba(0,0,0,.16) !important;
      }
      .persistentIdeaForm > button {
        width: 34px !important;
        height: 32px !important;
        border-radius: 0 7px 7px 0 !important;
        background: rgba(255,255,255,.025) !important;
      }
      .persistentProposalList { gap: 2px !important; }
      .persistentProposal {
        position: relative !important;
        grid-template-columns: 24px minmax(0,1fr) auto !important;
        min-height: 42px !important;
        padding: 5px 6px !important;
        border: 0 !important;
        border-bottom: 1px solid rgba(255,255,255,.055) !important;
        border-radius: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
      }
      .persistentProposal:hover {
        background: rgba(255,255,255,.018) !important;
      }
      .persistentProposal.leader::before {
        content: "" !important;
        position: absolute !important;
        left: 0 !important;
        top: 9px !important;
        bottom: 9px !important;
        width: 2px !important;
        border-radius: 2px !important;
        background: linear-gradient(180deg,var(--pump-gold-hi),var(--pump-gold-low)) !important;
        opacity: .9 !important;
      }
      .persistentProposal.own::after {
        content: "" !important;
        position: absolute !important;
        right: 5px !important;
        top: 5px !important;
        width: 4px !important;
        height: 4px !important;
        border-radius: 50% !important;
        background: var(--pump-silver) !important;
        opacity: .55 !important;
      }
      .proposalRank {
        width: 20px !important;
        text-align: center !important;
        font-size: 8px !important;
        opacity: .42 !important;
      }
      .persistentProposal.leader .proposalRank {
        color: var(--pump-gold-hi) !important;
        opacity: .9 !important;
      }
      .persistentProposalText { gap: 2px !important; }
      .persistentProposalText > span {
        font-size: 10.5px !important;
        line-height: 1.18 !important;
      }
      .persistentProposalText > i {
        display: flex !important;
        align-items: center !important;
        gap: 5px !important;
        font-size: 7px !important;
        opacity: .42 !important;
      }
      .persistentProposalText > i > code {
        color: var(--pump-gold-low) !important;
      }
      .proposalVote {
        min-width: 36px !important;
        height: 25px !important;
        gap: 3px !important;
        border-color: rgba(255,255,255,.075) !important;
        background: rgba(255,255,255,.02) !important;
      }
      .proposalVote:hover {
        border-color: rgba(200,255,0,.28) !important;
        background: rgba(200,255,0,.045) !important;
      }
      .proposalTotal {
        min-width: 20px !important;
        text-align: right !important;
        color: var(--pump-gold-hi) !important;
        font-size: 10px !important;
      }
      .ownIdeaActions { gap: 3px !important; }
      .ownIdeaActions > button {
        width: 24px !important;
        height: 24px !important;
        border-radius: 5px !important;
        background: rgba(255,255,255,.018) !important;
      }

      /* The drawer grab is a hardware seam, not a draggable-app affordance. */
      .drawerGrab { height: 18px !important; }
      .drawerGrab > i {
        width: 34px !important;
        height: 2px !important;
        opacity: .38 !important;
        box-shadow: none !important;
      }


      /* v26: rail + actions read as instrumentation, not thumbnail/button placeholders. */
      .episodeList > .programShelfSlot {
        position: relative !important;
        flex-basis: 54px !important;
        grid-template-columns: 24px minmax(0, 1fr) 22px !important;
        gap: 6px !important;
        padding: 6px 7px !important;
        border-color: rgba(200,255,0,.12) !important;
        border-radius: 9px !important;
        background:
          linear-gradient(180deg, rgba(200,255,0,.025), transparent 58%),
          rgba(255,255,255,.012) !important;
        box-shadow: inset 0 1px rgba(255,255,255,.025) !important;
        overflow: hidden !important;
      }
      .programShelfState {
        width: 22px !important;
        height: 36px !important;
        display: grid !important;
        place-items: center !important;
        border-right: 1px solid rgba(255,255,255,.05) !important;
        color: rgba(190,191,188,.48) !important;
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
      }
      .programShelfSlot.phase-locked .programShelfState,
      .programShelfSlot.phase-planning .programShelfState,
      .programShelfSlot.phase-rendering .programShelfState,
      .programShelfSlot.phase-finalizing .programShelfState {
        color: var(--pump-gold-hi) !important;
        text-shadow: 0 0 7px rgba(200,255,0,.22) !important;
      }
      .programShelfSlot.phase-planning::after,
      .programShelfSlot.phase-rendering::after,
      .programShelfSlot.phase-finalizing::after {
        content: "" !important;
        position: absolute !important;
        left: 7px !important;
        right: 7px !important;
        bottom: 0 !important;
        height: 1px !important;
        background: linear-gradient(90deg, transparent, var(--pump-gold-hi), transparent) !important;
        opacity: .7 !important;
        animation: programRailSweep 1.35s ease-in-out infinite alternate !important;
      }
      @keyframes programRailSweep {
        from { transform: translateX(-42%); opacity: .28; }
        to { transform: translateX(42%); opacity: .85; }
      }
      .programShelfCopy {
        min-width: 0 !important;
        display: flex !important;
        align-items: center !important;
        overflow: hidden !important;
      }
      .programShelfCopy > span {
        display: -webkit-box !important;
        -webkit-box-orient: vertical !important;
        -webkit-line-clamp: 2 !important;
        overflow: hidden !important;
        color: rgba(236,236,232,.72) !important;
        font-size: 8.5px !important;
        line-height: 1.16 !important;
      }
      .programShelfCopy > i {
        width: 32px !important;
        height: 1px !important;
        background: rgba(255,255,255,.08) !important;
      }
      .programShelfSlot > b {
        align-self: center !important;
        color: rgba(222,222,216,.58) !important;
        font-size: 9px !important;
        opacity: 1 !important;
      }
      .programShelfVisual,
      .programShelfPulse { display: none !important; }

      /* Proposal actions are readouts first, buttons second. */
      .proposalVote {
        min-width: 34px !important;
        height: 28px !important;
        padding: 0 3px !important;
        border: 0 !important;
        border-radius: 4px !important;
        background: transparent !important;
        box-shadow: none !important;
      }
      .proposalVote:hover {
        background: rgba(200,255,0,.055) !important;
      }
      .proposalVote > b {
        min-width: 14px !important;
        text-align: right !important;
        font: 700 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
      }
      .proposalVote svg {
        width: 10px !important;
        height: 10px !important;
        opacity: .7 !important;
      }
      .ownIdeaActions > button {
        width: 22px !important;
        height: 22px !important;
        border-color: transparent !important;
        background: transparent !important;
        box-shadow: none !important;
      }
      .ownIdeaActions > button:hover {
        border-color: rgba(255,255,255,.07) !important;
        background: rgba(255,255,255,.025) !important;
      }
      .proposalTotal {
        font: 700 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
      }
      .persistentProposalText > i > small {
        font: 650 7px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
        letter-spacing: .015em !important;
        opacity: .74 !important;
      }

      /* Closed dock: leader is the signal; supporting counters stay visually subordinate. */
      .participationBoard:not(.open) .dockIdeaSummary > span {
        color: rgba(237,237,232,.76) !important;
      }
      .participationBoard:not(.open) .dockIdeaSummary > b {
        font: 750 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
      }
      .participationBoard:not(.open) .proposalMetric,
      .participationBoard:not(.open) .viewerMetric {
        opacity: .72 !important;
      }

      /* v27: onboarding + score clarity. */
      .participationBoard:not(.open) .participationDock {
        grid-template-columns: auto auto minmax(0, 1fr) auto auto auto !important;
      }
      .participationBoard:not(.open) .boardToggle {
        width: auto !important;
        min-width: 78px !important;
        padding: 0 9px !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 6px !important;
        border: 1px solid rgba(200,255,0,.18) !important;
        background: rgba(200,255,0,.045) !important;
        color: rgba(241,211,132,.9) !important;
      }
      .boardToggle > span {
        font: 760 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace !important;
        letter-spacing: .07em !important;
        white-space: nowrap !important;
      }
      .boardToggle > svg {
        width: 12px !important;
        height: 12px !important;
      }
      .participationBoard.open .boardToggle > span { display: none !important; }
      .participationBoard.open .boardToggle > svg { transform: rotate(180deg) !important; }
      .persistentProposalText > i > small { display: none !important; }
      .persistentProposalText > i > code {
        font-size: 7.5px !important;
        opacity: .86 !important;
      }
      .proposalTotal {
        min-width: 36px !important;
        padding-inline: 5px !important;
        text-align: right !important;
        white-space: nowrap !important;
        cursor: help !important;
      }
      .proposalVote {
        min-width: 42px !important;
        flex: 0 0 auto !important;
      }
      .proposalVote > b {
        min-width: 22px !important;
        white-space: nowrap !important;
      }
      .walletMetric > b {
        max-width: 48px !important;
        overflow: hidden !important;
        text-overflow: ellipsis !important;
      }


      /* v33: interaction clarity. */
      .participationBoard svg .stroke {
        fill: none !important;
        stroke: currentColor !important;
        stroke-width: 1.8 !important;
        stroke-linecap: round !important;
        stroke-linejoin: round !important;
      }

      .persistentThreads {
        display: grid !important;
        align-content: start !important;
        gap: 0 !important;
        max-height: 150px !important;
        overflow-y: auto !important;
        overflow-x: hidden !important;
        padding-right: 3px !important;
        border-top: 1px solid rgba(255,255,255,.045) !important;
        scrollbar-width: thin !important;
      }
      .persistentThreadRow {
        display: grid !important;
        grid-template-columns: 18px minmax(0,1fr) !important;
        gap: 7px !important;
        align-items: start !important;
        padding: 7px 4px !important;
        border-bottom: 1px solid rgba(255,255,255,.045) !important;
        min-width: 0 !important;
      }
      .persistentThreadRow > em {
        margin-top: 1px !important;
        color: var(--pump-gold-low) !important;
        font: 700 7px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace !important;
        font-style: normal !important;
        text-align: center !important;
        opacity: .75 !important;
      }
      .persistentThreadRow > span {
        min-width: 0 !important;
        white-space: normal !important;
        overflow: visible !important;
        text-overflow: clip !important;
        color: rgba(237,237,232,.64) !important;
        font-size: 9px !important;
        line-height: 1.38 !important;
      }

      .persistentIdeaForm.editing {
        grid-template-columns: minmax(0,1fr) 34px 34px !important;
      }
      .persistentIdeaForm.editing > button {
        border-radius: 0 !important;
      }
      .persistentIdeaForm.editing > button:last-child {
        border-radius: 0 7px 7px 0 !important;
      }
      .persistentIdeaForm > button:not(:disabled) {
        color: var(--pump-gold-hi) !important;
        border-color: rgba(200,255,0,.28) !important;
        background: rgba(200,255,0,.045) !important;
      }
      .persistentIdeaForm > button:disabled {
        opacity: .22 !important;
      }
      .withdrawIdea {
        color: rgba(200,201,203,.52) !important;
        border-left-color: rgba(255,255,255,.06) !important;
      }
      .withdrawIdea:hover {
        color: rgba(255,255,255,.84) !important;
        background: rgba(255,255,255,.04) !important;
      }

      .persistentProposal.own {
        grid-template-columns: 24px minmax(0,1fr) auto !important;
      }
      .ownIdeaActions { display: none !important; }
      .proposalVote svg {
        display: block !important;
        flex: 0 0 auto !important;
        opacity: .9 !important;
      }
      .proposalVote:hover svg { color: var(--pump-gold-hi) !important; }

      .persistentIdeasHead {
        min-height: 24px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 0 2px 6px;
        color: rgba(226,226,220,.42);
        font: 750 8px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .1em;
      }
      .persistentIdeasHead > b { color: rgba(226,226,220,.58); font: inherit; }
      .persistentIdeasHead > span { white-space: nowrap; }
      .persistentIdeasHead strong { color: var(--pump-gold-hi); font: inherit; font-variant-numeric: tabular-nums; }

      /* v43: the final frame is an intentional participation state. */
      .mediaDeck .tvVideoLayer,
      .mediaDeck .tvPosterFallback {
        transition: filter 360ms ease, opacity 260ms ease !important;
      }
      .mediaDeck.intermission .tvVideoLayer.active,
      .mediaDeck.intermission .tvPosterFallback {
        filter: brightness(.42) saturate(.72) contrast(.94) !important;
      }
      .yourTurnOverlay {
        position: absolute;
        inset: 0;
        z-index: 18;
        display: grid;
        place-items: center;
        padding: clamp(14px, 3vw, 30px);
        pointer-events: none;
      }
      .yourTurnCard {
        width: min(270px, 72%);
        display: grid;
        justify-items: center;
        gap: 8px;
        padding: 16px 18px 15px;
        border: 1px solid rgba(200,255,0,.19);
        border-radius: 14px;
        background: rgba(8,9,10,.68);
        box-shadow: inset 0 1px rgba(255,255,255,.04), 0 16px 42px rgba(0,0,0,.3);
        backdrop-filter: blur(10px) saturate(.9);
        text-align: center;
        pointer-events: auto;
      }
      .yourTurnKicker {
        color: var(--pump-gold-hi);
        font: 800 9px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .2em;
      }
      .yourTurnCountdown {
        color: rgba(248,248,243,.98);
        font: 800 clamp(28px, 4vw, 40px)/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-variant-numeric: tabular-nums;
        letter-spacing: -.05em;
      }
      .yourTurnMeta {
        min-height: 11px;
        color: rgba(226,226,220,.52);
        font: 750 9px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .1em;
      }
      .yourTurnCard > button {
        min-height: 36px;
        margin-top: 1px;
        padding: 0 15px;
        border: 1px solid rgba(200,255,0,.3);
        border-radius: 9px;
        background: rgba(200,255,0,.1);
        color: var(--pump-gold-hi);
        box-shadow: inset 0 1px rgba(255,255,255,.05);
        font: 800 9px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .08em;
        cursor: pointer;
      }
      .yourTurnCard > button:active { transform: translateY(1px); }
      .generationPulse {
        position: absolute;
        left: 50%;
        bottom: clamp(18px, 4vw, 34px);
        z-index: 18;
        transform: translateX(-50%);
        display: inline-flex;
        align-items: center;
        gap: 7px;
        padding: 7px 10px;
        border: 1px solid rgba(255,255,255,.09);
        border-radius: 999px;
        background: rgba(8,9,10,.5);
        color: rgba(242,242,236,.7);
        backdrop-filter: blur(8px);
        pointer-events: none;
        font: 750 8px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        letter-spacing: .14em;
      }
      .generationPulse > i {
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: var(--pump-gold-hi);
        box-shadow: 0 0 10px rgba(200,255,0,.55);
        animation: generationPulse 1.15s ease-in-out infinite alternate;
      }
      @keyframes generationPulse {
        from { opacity: .35; transform: scale(.82); }
        to { opacity: 1; transform: scale(1.08); }
      }

      /* v47: one readable participation surface, no nested mini-scrolls. */
      .participationShade {
        position: fixed;
        inset: 0;
        z-index: 109;
        border: 0;
        padding: 0;
        background: rgba(0,0,0,.26);
        cursor: default;
      }
      .participationBoard.open .participationSheet {
        z-index: 110 !important;
      }
      .persistentProposal {
        align-items: start !important;
      }
      .persistentProposalText {
        min-width: 0 !important;
        cursor: help;
      }
      .persistentProposalText > span {
        display: block !important;
        white-space: normal !important;
        overflow: visible !important;
        text-overflow: clip !important;
        overflow-wrap: anywhere !important;
        word-break: break-word !important;
      }
      .persistentThreads {
        max-height: none !important;
        overflow: visible !important;
        padding-right: 0 !important;
        scrollbar-width: auto !important;
      }
      .persistentThreadRow > span {
        overflow-wrap: anywhere !important;
      }
      .winnerRewardNotice {
        position: fixed;
        left: 50%;
        top: max(18px, env(safe-area-inset-top));
        z-index: 180;
        transform: translateX(-50%);
        min-width: min(330px, calc(100vw - 28px));
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 5px 14px;
        padding: 13px 38px 13px 14px;
        border: 1px solid rgba(200,255,0,.28);
        border-radius: 14px;
        background: rgba(10,11,13,.94);
        box-shadow: 0 18px 48px rgba(0,0,0,.46), inset 0 1px rgba(255,255,255,.05);
        backdrop-filter: blur(18px);
      }
      .winnerRewardNotice > button {
        position: absolute;
        right: 9px;
        top: 8px;
        width: 24px;
        height: 24px;
        border: 0;
        background: transparent;
        color: rgba(255,255,255,.52);
        font-size: 18px;
        cursor: pointer;
      }
      .winnerRewardNotice > b {
        grid-column: 1 / -1;
        color: var(--pump-gold-hi);
        font: 800 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: .16em;
      }
      .winnerRewardNotice > strong {
        color: rgba(249,249,244,.98);
        font: 820 18px/1.05 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      .winnerRewardNotice > span {
        align-self: end;
        color: rgba(235,235,230,.52);
        font: 720 8px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: .1em;
      }
      .winnerRewardNotice.sent { border-color: rgba(140,215,158,.28); }
      .winnerRewardNotice.uncertain { border-color: rgba(225,165,96,.34); }

      @media (max-width: 820px) {
        html, body, #pumptv-page {
          min-height: 100dvh !important;
          max-width: 100vw !important;
          overflow-x: hidden !important;
        }
        .viewerApp {
          width: 100% !important;
          min-height: 100dvh !important;
          display: flex !important;
          flex-direction: column !important;
          align-items: stretch !important;
          overflow-x: hidden !important;
          padding-bottom: max(8px, env(safe-area-inset-bottom)) !important;
        }
        .watchDeck {
          width: 100% !important;
          min-width: 0 !important;
          min-height: 0 !important;
          padding-inline: 6px !important;
          box-sizing: border-box !important;
        }
        .tvCenter {
          width: 100% !important;
          min-width: 0 !important;
          margin-inline: auto !important;
          padding: 0 !important;
        }
        .tvShell {
          width: 100% !important;
          max-width: 100% !important;
          min-width: 0 !important;
          height: auto !important;
          min-height: 0 !important;
          aspect-ratio: 1.78 / 1 !important;
          margin: 0 auto !important;
          transform: none !important;
        }
        .minimalTop .wordmark { width: 48px !important; height: 48px !important; }
        .yourTurnOverlay { padding: 10px !important; }
        .yourTurnCard {
          width: min(82vw, 360px) !important;
          padding: 16px 14px 14px !important;
          gap: 7px !important;
          border-radius: 14px !important;
        }
        .yourTurnCountdown { font-size: clamp(28px, 10vw, 38px) !important; }
        .yourTurnCard > button { min-height: 42px !important; width: 100% !important; }
        .episodeShelf {
          position: relative !important;
          inset: auto !important;
          width: 100% !important;
          height: auto !important;
          max-height: none !important;
          min-height: 0 !important;
          flex-direction: row !important;
          align-items: center !important;
          gap: 6px !important;
          padding: 6px !important;
          order: 2 !important;
          overflow: hidden !important;
          box-sizing: border-box !important;
        }
        .episodeShelf > .liveCap {
          flex: 0 0 42px !important;
          width: 42px !important;
          height: 54px !important;
        }
        .episodeShelf > .episodeList {
          flex: 1 1 auto !important;
          width: auto !important;
          height: auto !important;
          min-height: 0 !important;
          display: flex !important;
          flex-direction: row !important;
          gap: 6px !important;
          overflow-x: auto !important;
          overflow-y: hidden !important;
          padding: 0 4px 2px !important;
          scroll-snap-type: x proximity;
        }
        .episodeList > .episodeCard,
        .episodeList > .programShelfSlot {
          flex: 0 0 104px !important;
          width: 104px !important;
          min-width: 104px !important;
          scroll-snap-align: center;
        }
        .participationBoard {
          width: calc(100vw - 12px) !important;
          margin: 7px auto 0 !important;
        }
        .participationSheet {
          position: fixed !important;
          left: 6px !important;
          right: 6px !important;
          bottom: max(6px, env(safe-area-inset-bottom)) !important;
          width: auto !important;
          height: min(78dvh, 680px) !important;
          max-height: min(78dvh, 680px) !important;
          min-height: 0 !important;
          z-index: 120 !important;
          border-radius: 18px !important;
        }
        .participationShade {
          z-index: 119 !important;
          background: rgba(0,0,0,.52) !important;
          backdrop-filter: blur(2px);
        }
        .participationBoard.open .participationSheet { z-index: 120 !important; }
        .participationSheet {
          overflow: hidden !important;
        }
        .participationColumns {
          display: block !important;
          height: 100% !important;
          min-height: 0 !important;
          overflow-y: auto !important;
          overflow-x: hidden !important;
          overscroll-behavior: contain !important;
          -webkit-overflow-scrolling: touch;
          padding-bottom: max(16px, env(safe-area-inset-bottom)) !important;
        }
        .persistentWorld,
        .persistentIdeas {
          min-height: auto !important;
          overflow: visible !important;
        }
        .persistentWorld {
          border-bottom: 1px solid rgba(255,255,255,.07) !important;
        }
        .persistentThreads {
          max-height: none !important;
          overflow: visible !important;
        }
        .persistentIdeaForm {
          position: sticky !important;
          top: 0 !important;
          z-index: 4 !important;
        }
        .persistentProposal {
          grid-template-columns: 22px minmax(0,1fr) auto !important;
          gap: 7px !important;
        }
        .persistentProposalText > span {
          font-size: 12px !important;
          line-height: 1.35 !important;
        }
        .winnerRewardNotice {
          top: max(10px, env(safe-area-inset-top)) !important;
          min-width: calc(100vw - 20px) !important;
        }
        .knobControl { width: 42px !important; height: 32px !important; min-width: 42px !important; min-height: 32px !important; }
        .participationBoard {
          width: calc(100vw - 24px);
        }
        .participationDock {
          grid-template-columns: auto auto minmax(0, 1fr) auto auto;
        }
        .participationBoard:not(.open) .boardToggle {
          min-width: 70px !important;
          padding-inline: 7px !important;
        }
        .proposalMetric { display: none; }
        .participationSheet {
          height: min(68vh, 620px) !important;
          max-height: min(68vh, 620px) !important;
          min-height: 360px;
        }
        .participationColumns {
          grid-template-columns: 1fr;
          overflow-y: auto;
        }
        .persistentWorld {
          border-right: 0;
          border-bottom: 1px solid rgba(255,255,255,.07);
          overflow: visible;
        }
        .persistentIdeas {
          overflow: visible;
        }
        .episodeShelf > .episodeList {
          height: auto !important;
        }
      }

      /* v48: authoritative adaptive sheet layout.
         Mobile gets one scroll owner, ideas first, and no sticky controls that
         can float across world/story content. Keep this block last so historic
         density experiments cannot reintroduce nested scrolling. */
      @media (max-width: 900px) {
        .participationSheet {
          position: fixed !important;
          left: 6px !important;
          right: 6px !important;
          bottom: max(6px, env(safe-area-inset-bottom)) !important;
          width: auto !important;
          height: min(86dvh, 760px) !important;
          max-height: calc(
            100dvh - max(14px, env(safe-area-inset-top)) -
            max(12px, env(safe-area-inset-bottom))
          ) !important;
          min-height: 0 !important;
          display: grid !important;
          grid-template-rows: auto minmax(0, 1fr) !important;
          overflow: hidden !important;
          overscroll-behavior: none !important;
          border-radius: 18px !important;
          z-index: 220 !important;
        }
        .participationBoard.open .participationSheet {
          z-index: 220 !important;
        }
        .participationShade {
          position: fixed !important;
          inset: 0 !important;
          z-index: 219 !important;
          display: block !important;
          width: 100vw !important;
          height: 100dvh !important;
          pointer-events: auto !important;
          touch-action: none !important;
          background: rgba(0,0,0,.56) !important;
          backdrop-filter: blur(2px);
        }
        .drawerGrab {
          position: relative !important;
          flex: none !important;
          height: 26px !important;
        }
        .participationColumns {
          display: flex !important;
          flex-direction: column !important;
          grid-template-columns: none !important;
          height: 100% !important;
          max-height: none !important;
          min-height: 0 !important;
          overflow-y: auto !important;
          overflow-x: hidden !important;
          overscroll-behavior-y: contain !important;
          -webkit-overflow-scrolling: touch !important;
          touch-action: pan-y !important;
          scrollbar-gutter: stable !important;
          padding: 0 0 max(20px, env(safe-area-inset-bottom)) !important;
        }

        /* Participation is the primary task on a phone. */
        .persistentIdeas {
          order: 1 !important;
          flex: 0 0 auto !important;
          width: 100% !important;
          min-height: 0 !important;
          max-height: none !important;
          overflow: visible !important;
          padding: 10px 10px 14px !important;
          border-bottom: 1px solid rgba(255,255,255,.07) !important;
        }
        .persistentIdeasHead,
        .persistentIdeaForm {
          position: static !important;
          inset: auto !important;
          top: auto !important;
          z-index: auto !important;
        }
        .persistentIdeaForm {
          margin: 0 0 8px !important;
          padding: 0 !important;
        }
        .persistentProposalList {
          max-height: none !important;
          overflow: visible !important;
        }
        .persistentProposal {
          align-items: start !important;
          grid-template-columns: 22px minmax(0,1fr) auto !important;
          min-height: 0 !important;
          padding-block: 9px !important;
        }
        .persistentProposalText {
          min-width: 0 !important;
        }
        .persistentProposalText > span {
          display: block !important;
          white-space: normal !important;
          overflow: visible !important;
          text-overflow: clip !important;
          overflow-wrap: anywhere !important;
          word-break: break-word !important;
          font-size: 12px !important;
          line-height: 1.38 !important;
        }

        /* World state is secondary reference material and follows ideas. */
        .persistentWorld {
          order: 2 !important;
          flex: 0 0 auto !important;
          width: 100% !important;
          min-height: 0 !important;
          max-height: none !important;
          overflow: visible !important;
          padding: 10px !important;
          border-right: 0 !important;
          border-bottom: 0 !important;
        }
        .persistentWorldItems {
          overflow: visible !important;
        }
        .persistentWorldItems > button {
          min-height: 0 !important;
          grid-template-columns: minmax(96px,.38fr) minmax(0,.62fr) !important;
          align-items: start !important;
          gap: 10px !important;
          padding-block: 8px !important;
        }
        .persistentWorldItems > button > b,
        .persistentWorldItems > button > span {
          min-width: 0 !important;
          white-space: normal !important;
          overflow: visible !important;
          text-overflow: clip !important;
          overflow-wrap: anywhere !important;
          word-break: break-word !important;
          text-align: left !important;
          line-height: 1.34 !important;
        }
        .persistentThreads {
          display: grid !important;
          max-height: none !important;
          min-height: 0 !important;
          overflow: visible !important;
          overscroll-behavior: auto !important;
          padding-right: 0 !important;
          scrollbar-width: auto !important;
        }
        .persistentThreadRow {
          min-height: 0 !important;
          padding-block: 9px !important;
        }
        .persistentThreadRow > span {
          white-space: normal !important;
          overflow: visible !important;
          text-overflow: clip !important;
          overflow-wrap: anywhere !important;
          word-break: break-word !important;
          font-size: 10px !important;
          line-height: 1.42 !important;
        }
      }

      @media (max-width: 560px) {
        .participationSheet {
          left: 4px !important;
          right: 4px !important;
          bottom: max(4px, env(safe-area-inset-bottom)) !important;
          height: min(88dvh, 760px) !important;
          border-radius: 16px !important;
        }
        .persistentWorldItems > button {
          grid-template-columns: 1fr !important;
          gap: 3px !important;
        }
        .persistentWorldItems > button > span {
          opacity: .58 !important;
        }
      }


      /* v52 — MEME TV: black / white / acid visual system from the supplied mark. */
      :root {
        --meme-acid: #c8ff00;
        --meme-acid-hi: #d9ff33;
        --meme-acid-low: #86ad00;
        --meme-ink: #000;
        --meme-panel: #080a07;
        --meme-white: #f7f8f4;
      }

      html,
      body,
      #pumptv-page,
      .viewerApp {
        background: #000 !important;
        color: var(--meme-white) !important;
      }

      .minimalTop .wordmark {
        width: 178px !important;
        height: 54px !important;
        overflow: visible !important;
        opacity: 1 !important;
      }
      .pumptvLogo {
        width: 100% !important;
        height: 100% !important;
        object-fit: contain !important;
        object-position: left center !important;
        mix-blend-mode: normal !important;
        filter: drop-shadow(0 5px 18px rgba(200,255,0,.08)) !important;
      }

      .participationDock,
      .participationSheet,
      .episodeShelf,
      .richHoverTooltip,
      .winnerRewardNotice {
        background-color: rgba(4,5,4,.965) !important;
        border-color: rgba(200,255,0,.12) !important;
      }

      .participationDock {
        background:
          linear-gradient(180deg, rgba(15,18,12,.96), rgba(3,4,3,.96)) !important;
        box-shadow:
          inset 0 1px rgba(255,255,255,.045),
          0 16px 42px rgba(0,0,0,.38) !important;
      }

      .drawerGrab > i {
        background: linear-gradient(
          90deg,
          transparent,
          var(--meme-acid),
          transparent
        ) !important;
      }

      .yourTurnCard {
        border-color: rgba(200,255,0,.28) !important;
        background: rgba(0,0,0,.78) !important;
        box-shadow:
          inset 0 1px rgba(255,255,255,.04),
          0 18px 50px rgba(0,0,0,.48),
          0 0 30px rgba(200,255,0,.035) !important;
      }
      .yourTurnKicker,
      .persistentIdeasHead strong,
      .proposalVote > b,
      .episodeCard.active > b,
      .dockIdeaSummary > b,
      .walletMetric.connected {
        color: var(--meme-acid-hi) !important;
      }
      .yourTurnCard > button,
      .persistentIdeaForm > button:not(:disabled) {
        border-color: var(--meme-acid) !important;
        background: var(--meme-acid) !important;
        color: #050604 !important;
        box-shadow:
          inset 0 1px rgba(255,255,255,.34),
          0 0 18px rgba(200,255,0,.08) !important;
      }
      .yourTurnCard > button:hover,
      .persistentIdeaForm > button:not(:disabled):hover {
        background: var(--meme-acid-hi) !important;
        color: #000 !important;
      }

      .persistentIdeaForm > input:focus,
      .ideaForm > input:focus {
        border-color: rgba(200,255,0,.52) !important;
        box-shadow: 0 0 0 2px rgba(200,255,0,.06) !important;
      }

      .proposalVote:hover,
      .boardToggle:hover,
      .participationBoard.open .boardToggle,
      .walletMetric:hover {
        border-color: rgba(200,255,0,.34) !important;
        color: var(--meme-acid-hi) !important;
      }

      .episodeCard.active {
        background: linear-gradient(
          90deg,
          rgba(200,255,0,.075),
          rgba(255,255,255,.012)
        ) !important;
      }
      .episodeCard.active::after {
        background: linear-gradient(
          180deg,
          var(--meme-acid-hi),
          var(--meme-acid-low)
        ) !important;
        box-shadow: 0 0 10px rgba(200,255,0,.28) !important;
      }

      .statusDot.ready,
      .statusDot.work,
      .powerLamp.ready,
      .powerLamp.work,
      .generationPulse > i {
        background: var(--meme-acid-hi) !important;
        box-shadow:
          0 0 0 1px rgba(200,255,0,.20),
          0 0 12px rgba(200,255,0,.32) !important;
      }

      .knobControl.on {
        border-color: rgba(200,255,0,.32) !important;
        color: var(--meme-acid-hi) !important;
        background:
          linear-gradient(180deg, rgba(200,255,0,.075), rgba(255,255,255,.01)),
          #0c0e0b !important;
      }
      .knobControl.on::after {
        background: var(--meme-acid-hi) !important;
        box-shadow: 0 0 7px rgba(200,255,0,.30) !important;
      }

      .tvShell {
        border-color: rgba(200,255,0,.10) !important;
        background:
          linear-gradient(145deg, #171b15 0%, #090b08 62%, #050605 100%) !important;
        box-shadow:
          inset 0 1px rgba(255,255,255,.045),
          inset 0 0 0 1px rgba(0,0,0,.72),
          0 24px 80px rgba(0,0,0,.46) !important;
      }
      .tvScreenFrame {
        border-color: rgba(200,255,0,.07) !important;
        background: #020302 !important;
      }

      .winnerRewardNotice > b,
      .winnerRewardNotice > a {
        color: var(--meme-acid-hi) !important;
      }

      @media (max-width: 820px) {
        .minimalTop .wordmark {
          width: 132px !important;
          height: 40px !important;
        }
      }

      @media (max-width: 560px) {
        .minimalTop .wordmark {
          width: 116px !important;
          height: 36px !important;
        }
      }

    `}</style>
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
