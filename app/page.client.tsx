import { render } from "tradjs/client";
import { createMeasure } from "measure-fn";
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

function clientErrorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : String(error ?? "Unknown error");
}

let timeline: Clip[] = [];
let room: RoomState | null = null;
let nextDirective: Directive | null = null;
let program: LiveProgramState | null = null;
let worldState: WorldState | null = null;
let serverOffsetMs = 0;
let replayClipId: number | null = null;
let longPollAbort: AbortController | null = null;
let streamRevision = 0;
let viewerId = "";
let proposalOwnerId = "";
let initialCatchupPending = false;
const NEW_VIEWER_HISTORY_OFFSET = 7;
let transport: "connecting" | "live" | "reconnecting" = "connecting";
let error: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

let soundEnabled = false;
let captionsEnabled = true;
let liveOverlayEnabled = true;
let infoOpen = false;
let playbackPaused = false;
let pausedClipId: number | null = null;

type TrayView = "ideas" | "world";
type WalletState = "idle" | "connecting" | "connected" | "missing" | "error";

let trayOpen = false;
let trayView: TrayView = "ideas";
let walletState: WalletState = "idle";
let walletAddress: string | null = null;
let walletTokenBalance = 0;
let walletPower = 1;
let walletScoreLoading = false;
let ideaDraft = "";
let ideaSubmitting = false;
let votePendingId: number | null = null;
let participationError: string | null = null;
let worldDetailId: string | null = null;
let worldDetailKind: "location" | "character" | "prop" | null = null;

type PhantomPublicKey = { toString(): string };
type PhantomProvider = {
  isPhantom?: boolean;
  isConnected?: boolean;
  publicKey?: PhantomPublicKey | null;
  connect(options?: {
    onlyIfTrusted?: boolean;
  }): Promise<{ publicKey: PhantomPublicKey }>;
  on?(
    event: "connect" | "disconnect" | "accountChanged",
    handler: (value?: PhantomPublicKey | null) => void,
  ): void;
};

type LiveSlotState = "playing" | "intermission" | "transitioning";
let liveSlotState: LiveSlotState = "playing";

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
  return timeline.filter((clip) => clip.startsAtMs <= now);
}

function latestPublishedClip() {
  const published = publishedTimeline();
  return published.length ? published[published.length - 1] : null;
}

function replayClip() {
  return replayClipId == null
    ? null
    : timeline.find((clip) => clip.id === replayClipId) || null;
}

function desiredClip() {
  if (playbackPaused && pausedClipId != null)
    return (
      timeline.find((clip) => clip.id === pausedClipId) ||
      replayClip() ||
      latestPublishedClip()
    );
  return replayClip() || latestPublishedClip();
}

function visibleClip() {
  return (
    (activeVideoClipId == null
      ? null
      : timeline.find((clip) => clip.id === activeVideoClipId)) || desiredClip()
  );
}

function clipAfter(clip: Clip | null) {
  if (!clip) return null;
  const ordered = replayClipId == null ? timeline : publishedTimeline();
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

function redraw() {
  const root = document.getElementById("pumptv-root");
  if (!root) return;

  // The media deck lives in a sibling host that TradJS never renders into.
  // UI redraws therefore cannot detach, replace, or repaint the video elements.
  render(<App />, root);
  queueMicrotask(() => {
    ensureMediaDeck();
    observeMediaTarget();
    syncVideoDeck();
    syncLocalPresentation();
    updateLiveMeters();
    centerSelectedEpisode();
  });
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
  room = state.room;
  timeline = state.timeline;
  nextDirective = state.nextDirective;
  program = state.program;
  worldState = state.worldState;

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
      replayClipId =
        target && latest && target.id !== latest.id ? target.id : null;
      initialCatchupPending = false;
      localStorage.removeItem("pumptv-new-viewer-catchup");
    }
  }

  if (
    replayClipId != null &&
    !timeline.some((clip) => clip.id === replayClipId)
  )
    replayClipId = null;
  error = null;
  redraw();
}

function phantomProvider(): PhantomProvider | null {
  const provider = (window as any).phantom?.solana as
    PhantomProvider | undefined;
  return provider?.isPhantom ? provider : null;
}

function walletFromPublicKey(value?: PhantomPublicKey | null) {
  const address = value?.toString?.().trim() || "";
  walletAddress = address || null;
  walletState = walletAddress ? "connected" : "idle";
}

let phantomEventsInstalled = false;
function installPhantomEvents() {
  if (phantomEventsInstalled) return;
  const provider = phantomProvider();
  if (!provider?.on) return;
  phantomEventsInstalled = true;
  provider.on("connect", (publicKey) => {
    walletFromPublicKey(publicKey || provider.publicKey || null);
    participationError = null;
    redraw();
    void refreshWalletScore();
  });
  provider.on("disconnect", () => {
    walletAddress = null;
    walletState = "idle";
    redraw();
  });
  provider.on("accountChanged", (publicKey) => {
    walletFromPublicKey(publicKey || provider.publicKey || null);
    walletTokenBalance = 0;
    walletPower = 1;
    redraw();
    if (walletAddress) void refreshWalletScore();
  });
}

async function connectPhantom(interactive: boolean) {
  const provider = phantomProvider();
  if (!provider) {
    walletAddress = null;
    walletState = "missing";
    if (interactive)
      window.open("https://phantom.app/", "_blank", "noopener,noreferrer");
    redraw();
    return false;
  }

  installPhantomEvents();
  walletState = "connecting";
  participationError = null;
  redraw();
  try {
    const result = await provider.connect(
      interactive ? undefined : { onlyIfTrusted: true },
    );
    walletFromPublicKey(result?.publicKey || provider.publicKey || null);
    redraw();
    if (walletAddress) await refreshWalletScore();
    return Boolean(walletAddress);
  } catch (cause: any) {
    walletAddress = null;
    const rejected = Number(cause?.code) === 4001;
    walletState = interactive && !rejected ? "error" : "idle";
    if (interactive && !rejected)
      participationError =
        cause instanceof Error ? cause.message : "Wallet connection failed";
    redraw();
    return false;
  }
}

async function refreshStreamState() {
  try {
    applyState(await json<StreamState>("/api/state"));
  } catch {}
}

function ownerKey() {
  return walletAddress ? `wallet:${walletAddress}` : `web:${proposalOwnerId}`;
}

function currentBoardRound() {
  return program?.votingRound || null;
}

function ownProposal() {
  return (
    currentBoardRound()?.proposals.find(
      (proposal) =>
        proposal.source === "web" && proposal.sourceId === ownerKey(),
    ) || null
  );
}

async function refreshWalletScore() {
  if (!walletAddress || walletScoreLoading) return;
  walletScoreLoading = true;
  participationError = null;
  redraw();
  try {
    const result = await json<{ tokenBalance: number; power: number }>(
      "/api/wallet/score",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          viewerId,
          ownerId: proposalOwnerId,
          walletAddress,
        }),
      },
    );
    walletTokenBalance = Number(result.tokenBalance || 0);
    walletPower = Math.max(1, Number(result.power || 1));
    await refreshStreamState();
  } catch (cause) {
    walletTokenBalance = 0;
    walletPower = 1;
    participationError =
      cause instanceof Error ? cause.message : "Could not read token balance";
  } finally {
    walletScoreLoading = false;
    redraw();
  }
}

async function submitIdea() {
  if (ideaSubmitting) return;
  const text = ideaDraft.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!text) return;

  ideaSubmitting = true;
  participationError = null;
  redraw();
  try {
    await json("/api/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        viewerId,
        ownerId: proposalOwnerId,
        walletAddress,
      }),
    });
    ideaDraft = "";
    await refreshStreamState();
  } catch (cause) {
    participationError =
      cause instanceof Error ? cause.message : "Could not save idea";
  } finally {
    ideaSubmitting = false;
    redraw();
  }
}

function editOwnIdea() {
  const own = ownProposal();
  if (!own) return;
  ideaDraft = own.text;
  redraw();
  queueMicrotask(() => {
    const input = document.querySelector<HTMLInputElement>("[data-idea-input]");
    input?.focus();
    input?.select();
  });
}

async function cancelOwnIdea() {
  if (ideaSubmitting || !ownProposal()) return;
  ideaSubmitting = true;
  participationError = null;
  redraw();
  try {
    await json("/api/proposals", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        viewerId,
        ownerId: proposalOwnerId,
        walletAddress,
      }),
    });
    ideaDraft = "";
    await refreshStreamState();
  } catch (cause) {
    participationError =
      cause instanceof Error ? cause.message : "Could not cancel idea";
  } finally {
    ideaSubmitting = false;
    redraw();
  }
}

async function voteForProposal(proposalId: number) {
  if (!Number.isSafeInteger(proposalId) || proposalId <= 0 || votePendingId)
    return;

  votePendingId = proposalId;
  participationError = null;
  redraw();
  try {
    await json("/api/votes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proposalId,
        viewerId,
        ownerId: proposalOwnerId,
        walletAddress,
      }),
    });
    await refreshStreamState();
  } catch (cause) {
    participationError =
      cause instanceof Error ? cause.message : "Could not vote";
  } finally {
    votePendingId = null;
    redraw();
  }
}

function toggleTray() {
  const opening = !trayOpen;
  trayOpen = opening;
  if (opening) trayView = "ideas";
  redraw();
  if (opening)
    queueMicrotask(() =>
      document.querySelector<HTMLInputElement>("[data-idea-input]")?.focus(),
    );
}

function openTray(view: TrayView) {
  if (trayOpen && trayView === view) trayOpen = false;
  else {
    trayOpen = true;
    trayView = view;
  }
  redraw();
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
  html.dataset.pumptvSound = soundEnabled ? "on" : "off";
  html.dataset.pumptvCaptions = captionsEnabled ? "on" : "off";
  html.dataset.pumptvOverlay = liveOverlayEnabled ? "on" : "off";
  html.dataset.pumptvInfo = infoOpen ? "open" : "closed";
  html.dataset.pumptvPlayback = playbackPaused ? "paused" : "playing";
  html.dataset.pumptvMode = replayClipId == null ? "live" : "replay";
  html.dataset.pumptvSlot = replayClipId == null ? liveSlotState : "replay";

  document
    .querySelectorAll<HTMLElement>("[data-control]")
    .forEach((control) => {
      const name = control.dataset.control;
      const active =
        name === "playback"
          ? !playbackPaused
          : name === "sound"
            ? soundEnabled
            : name === "captions"
              ? captionsEnabled
              : name === "overlay"
                ? liveOverlayEnabled
                : name === "info"
                  ? infoOpen
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
        video.muted = !soundEnabled;
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
        Number.isFinite(id) && id === liveId && replayClipId == null,
      );
    });
  const liveCap = document.querySelector<HTMLElement>(".liveCap");
  if (liveCap) liveCap.classList.toggle("active", replayClipId == null);
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
  if (!prompt) return;
  if (clip) prompt.removeAttribute("data-empty");
  else prompt.setAttribute("data-empty", "");
  if (text) text.textContent = clip?.directive || "";
  if (author) author.textContent = clip ? clipAuthor(clip) : "";
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

  soundEnabled = readPref("pumptv-v25-sound", false);
  captionsEnabled = readPref("pumptv-v25-captions", true);
  liveOverlayEnabled = readPref("pumptv-v25-live-overlay", true);
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
      else error = null;
      retryMs = 850;
      if (transport !== "live") {
        transport = "live";
        redraw();
      }
    } catch (cause) {
      if (controller.signal.aborted) break;
      transport = "reconnecting";
      error = cause instanceof Error ? cause.message : "state reconnecting";
      redraw();
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
  installPhantomEvents();
  syncLocalUiState();
  redraw();
  void connectPhantom(false);
  try {
    applyState(await json<StreamState>("/api/state"));
    transport = "live";
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "offline";
    redraw();
  }

  void runStateLongPoll();

  timer = setInterval(() => {
    syncVideoDeck();
    updateLiveMeters();
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
    replayClipId != null ||
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
    replayClipId != null ||
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
    replayClipId != null ||
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
  const hardTimeoutMs = 5_000;
  const callback = (video as any).requestVideoFrameCallback;

  if (typeof callback === "function") {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(
        () =>
          finish(new Error("timed out waiting for a presented video frame")),
        hardTimeoutMs,
      );
      callback.call(video, () => finish());
    });
    return;
  }

  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        video.removeEventListener("loadeddata", onLoaded);
        video.removeEventListener("error", onError);
      };
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("video failed before its first frame was available"));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for video data"));
      }, hardTimeoutMs);
      video.addEventListener("loadeddata", onLoaded, { once: true });
      video.addEventListener("error", onError, { once: true });
    });
  }

  // Browsers without requestVideoFrameCallback cannot prove compositor
  // presentation. Two animation frames after HAVE_CURRENT_DATA is the safest
  // fallback; importantly, an arbitrary short timeout is never treated as a
  // successful paint anymore.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
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
      replayClipId == null && liveSlotState === "intermission";
    if (playbackPaused) {
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
          if (activeVideoClipId === clip.id) video.muted = !soundEnabled;
        })
        .catch(() => {
          video.dataset.resumePending = "0";
        });
    } else if (!video.paused) {
      video.muted = !soundEnabled;
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
    if (activeVideoClipId == null && replayClipId == null) {
      liveSlotState = "transitioning";
      syncLocalUiState();
    }
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
    replayClipId == null && liveSlotState === "intermission";
  if (replayClipId == null) {
    liveSlotState = revealingFromIntermission ? "transitioning" : "playing";
    syncLocalUiState();
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
  video.muted = !soundEnabled;

  if (previous && previous !== video) {
    previous.classList.add("retiring");
    previous.muted = true;
  }

  activeVideoSlot = slot;
  activeVideoClipId = clip.id;
  syncPoster();
  if (changed) syncLocalPresentation();

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

      if (replayClipId == null && liveSlotState === "transitioning") {
        liveSlotState = "playing";
        syncLocalUiState();
      }
    }
  } else {
    video.classList.remove("entering", "reveal");
  }

  queueMicrotask(syncVideoDeck);
}

function syncVideoDeck() {
  const wanted = desiredClip();
  const nodes = videoNodes();
  if (!nodes[0] || !nodes[1]) return;

  if (
    wanted &&
    activeVideoClipId == null &&
    replayClipId == null &&
    !playbackPaused
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
    if (replayClipId == null) {
      liveSlotState = "intermission";
      syncLocalUiState();
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
  if (active && activeVideoClipId === wanted.id) active.muted = !soundEnabled;
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
  video.muted = !soundEnabled;
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

  if (replayClipId != null) {
    // An outgoing deck can finish while a different replay episode is loading.
    // Never let that stale `ended` event advance/replace the newly requested
    // replay target. Only the replay episode that is *currently selected* owns
    // replay auto-advance semantics.
    if (replayClipId !== clipId) return;

    const published = publishedTimeline();
    const index = published.findIndex((clip) => clip.id === clipId);
    const following = index >= 0 ? published[index + 1] : null;
    const live = latestPublishedClip();
    if (following && following.id !== live?.id) replayClipId = following.id;
    else replayClipId = null;
    switchSerial += 1;
    pendingActivation = null;
    syncLocalUiState();
    syncEpisodeSelection();
    syncVideoDeck();
    return;
  }

  const current = timeline.find((clip) => clip.id === clipId) || null;
  const following = clipAfter(current);
  if (following && following.startsAtMs <= liveNowMs() + 250) {
    syncVideoDeck();
    return;
  }

  // Live TV is intentionally finite at the edge of the archive. Once the
  // newest published episode ends we stop on its final painted frame and let
  // the empty next-program slot carry voting / generation status. We never
  // cover a still-playing episode with that UI and we never silently loop it.
  liveSlotState = "intermission";
  syncLocalUiState();
  const active = videoNodes()[slot];
  if (active) {
    active.pause();
    active.muted = true;
  }
}

function togglePlayback() {
  if (!playbackPaused) {
    playbackPaused = true;
    pausedClipId = visibleClip()?.id ?? desiredClip()?.id ?? null;
    const active = videoNodes()[activeVideoSlot];
    if (active && !active.paused) active.pause();
    syncLocalUiState();
    redraw();
    return;
  }

  playbackPaused = false;
  pausedClipId = null;
  if (replayClipId == null) liveSlotState = "playing";
  switchSerial += 1;
  pendingActivation = null;
  syncLocalUiState();
  primeDesiredPlaybackFromGesture();
  syncVideoDeck();
  redraw();
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  writePref("pumptv-v25-sound", soundEnabled);
  syncLocalUiState();
}

function toggleCaptions() {
  captionsEnabled = !captionsEnabled;
  writePref("pumptv-v25-captions", captionsEnabled);
  syncLocalUiState();
}

function toggleLiveOverlay() {
  liveOverlayEnabled = !liveOverlayEnabled;
  writePref("pumptv-v25-live-overlay", liveOverlayEnabled);
  syncLocalUiState();
}

function toggleInfo() {
  infoOpen = !infoOpen;
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
  if (vote && program?.countdownEndsAtMs)
    vote.textContent = formatClock(program.countdownEndsAtMs - liveNowMs());
  const futureVote = document.querySelector(
    "[data-future-vote-countdown]",
  ) as HTMLElement | null;
  if (futureVote && program?.votingRound?.closesAtMs)
    futureVote.textContent = formatClock(
      program.votingRound.closesAtMs - liveNowMs(),
    );
  const gen = document.querySelector(
    "[data-generation-elapsed]",
  ) as HTMLElement | null;
  if (gen && program?.generationStartedAtMs)
    gen.textContent = formatClock(liveNowMs() - program.generationStartedAtMs);
}

function jumpToEpisode(id: number) {
  if (!timeline.some((clip) => clip.id === id)) return;
  playbackPaused = false;
  pausedClipId = null;
  const live = latestPublishedClip();
  replayClipId = live?.id === id ? null : id;
  if (replayClipId == null) liveSlotState = "playing";
  switchSerial += 1;
  pendingActivation = null;
  syncLocalUiState();
  syncEpisodeSelection();
  centerSelectedEpisode("smooth");
  primeDesiredPlaybackFromGesture();
  syncVideoDeck();
}

function returnLive() {
  playbackPaused = false;
  pausedClipId = null;
  replayClipId = null;
  // Returning to live starts the latest archive episode cleanly. The ended
  // edge will switch back to intermission when that episode actually finishes.
  liveSlotState = "playing";
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
        if (infoOpen) {
          infoOpen = false;
          syncLocalUiState();
        }
      } else if (action === "tray-toggle") toggleTray();
      else if (action === "tray-ideas") openTray("ideas");
      else if (action === "tray-world") openTray("world");
      else if (action === "wallet") void connectPhantom(true);
      else if (action === "submit-idea") void submitIdea();
      else if (action === "edit-own") editOwnIdea();
      else if (action === "cancel-own") void cancelOwnIdea();
      else if (action === "world-detail") {
        const kind = control.dataset.worldKind as
          "location" | "character" | "prop" | undefined;
        worldDetailKind = kind || null;
        worldDetailId = control.dataset.worldId || null;
        redraw();
      } else if (action === "close-world-detail") {
        worldDetailKind = null;
        worldDetailId = null;
        redraw();
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
    if (worldDetailKind) {
      worldDetailKind = null;
      worldDetailId = null;
      redraw();
      return;
    }
    if (trayOpen) {
      trayOpen = false;
      redraw();
      return;
    }
    if (infoOpen) {
      infoOpen = false;
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

function directiveAuthor(directive: Directive | null) {
  return directive
    ? authorLabel(directive.author, directive.authorAddress)
    : "@?";
}

function engineState() {
  if (!program) return "boot";
  if (program.phase === "starting") return "boot";
  if (program.phase === "offline") return "off";
  if (program.phase === "setup" || program.phase === "paused") return "pause";
  if (
    program.phase === "planning" ||
    program.phase === "rendering" ||
    program.phase === "finalizing"
  )
    return "work";
  return "ready";
}

function tooltipStatus() {
  if (!program || !room) return "PumpTV is starting";
  if (program.reason) return program.reason;
  if (program.phase === "starting") return "Generation worker is starting";
  if (program.phase === "locked")
    return "Next episode is triggered and waiting for the worker";
  if (
    program.phase === "planning" ||
    program.phase === "rendering" ||
    program.phase === "finalizing"
  )
    return `Generating episode ${program.targetEpisode + 1}`;
  if (program.phase === "ready")
    return `Episode ${program.targetEpisode + 1} ready`;
  const proposals = program.votingRound?.proposals.length || 0;
  return proposals
    ? `${proposals} active suggestion${proposals === 1 ? "" : "s"}; waiting for trigger`
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
        {playbackPaused ? (
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
        {soundEnabled ? (
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
            className={`rankRow ${selected ? "winner" : ""} ${interactive ? "interactive" : ""} ${votePendingId === candidate.id ? "pending" : ""}`}
            key={candidate.id}
            data-action={interactive ? "vote" : undefined}
            data-proposal-id={interactive ? candidate.id : undefined}
            role={interactive ? "button" : undefined}
            tabIndex={interactive ? 0 : undefined}
          >
            <em>{index + 1}</em>
            <div className="rankIdea">
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
  if (!program || !liveOverlayEnabled) return null;

  const phase = program.phase;
  const generating =
    phase === "planning" || phase === "rendering" || phase === "finalizing";
  const voting = phase === "voting";
  const ready = phase === "ready";
  const locked = phase === "locked";
  const decisionRound = program.decisionRound;
  const votingRound = program.votingRound;
  const primaryRound = voting ? votingRound : decisionRound;
  const futureRound =
    !voting &&
    votingRound &&
    votingRound.targetEpisode !== program.targetEpisode
      ? votingRound
      : null;

  return (
    <section
      className={`outsideProgram phase-${phase} ${generating ? "generating" : ""} ${ready ? "ready" : ""}`}
      title={program.reason || tooltipStatus()}
      aria-label="Next episode status"
    >
      <div className="outsideProgramHead">
        <span className="outsideProgramGlyph" aria-hidden="true">
          {stageGlyph(phase)}
        </span>
        <b>{program.targetEpisode + 1}</b>
        {voting && program.countdownEndsAtMs ? (
          <strong data-vote-countdown>
            {formatClock(program.countdownEndsAtMs - liveNowMs())}
          </strong>
        ) : null}
        {generating && program.generationStartedAtMs ? (
          <strong data-generation-elapsed>
            {formatClock(liveNowMs() - program.generationStartedAtMs)}
          </strong>
        ) : null}
      </div>

      {program.directive && (generating || locked || ready) ? (
        <div className="outsideWinner">
          <span>{program.directive.text}</span>
          <i>{directiveAuthor(program.directive)}</i>
        </div>
      ) : null}

      {voting ? <CandidateRows round={primaryRound} /> : null}

      {futureRound?.proposals.length ? (
        <div className="outsideFuture">
          <div className="outsideFutureHead">
            <span>◉</span>
            <b>{futureRound.targetEpisode + 1}</b>
            {futureRound.votingStartedAtMs &&
            futureRound.closesAtMs > liveNowMs() ? (
              <strong data-future-vote-countdown>
                {formatClock(futureRound.closesAtMs - liveNowMs())}
              </strong>
            ) : null}
          </div>
          <CandidateRows round={futureRound} limit={3} />
        </div>
      ) : null}
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
  if (!infoOpen) return null;
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

      {worldState ? (
        <div className="outsideWorldBody">
          <div className="outsideWorldLocation">
            <b>{worldState.location || "—"}</b>
            {worldState.locationDetails ? (
              <p>{worldState.locationDetails}</p>
            ) : null}
            {worldState.lastEndingBeat ? (
              <em>{worldState.lastEndingBeat}</em>
            ) : null}
          </div>

          {worldState.characters.length ? (
            <div className="outsideWorldGroup">
              {worldState.characters.map((item) => (
                <article key={item.id}>
                  <b>{item.name}</b>
                  <span>{item.status}</span>
                  {item.position ? <small>{item.position}</small> : null}
                </article>
              ))}
            </div>
          ) : null}

          {worldState.props.length ? (
            <div className="outsideWorldGroup compact">
              {worldState.props.map((item) => (
                <article key={item.id}>
                  <b>{item.name}</b>
                  <span>{item.status}</span>
                  {item.position ? <small>{item.position}</small> : null}
                </article>
              ))}
            </div>
          ) : null}

          {worldState.openThreads.length ? (
            <div className="outsideThreads">
              {worldState.openThreads.slice(0, 6).map((item) => (
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
          active={liveOverlayEnabled}
          icon="overlay"
          action="overlay"
          title={liveOverlayEnabled ? "Hide next episode" : "Show next episode"}
        />
        <OutsideTool
          active={infoOpen}
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
  return program?.votingRound || null;
}

function ParticipationIdeas() {
  const round = trayRound();
  const candidates = sortedCandidates(round);
  const canVote = Boolean(round?.status === "open");
  const generating =
    program?.phase === "planning" ||
    program?.phase === "rendering" ||
    program?.phase === "finalizing";

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
          disabled={ideaSubmitting}
        />
        <button
          type="submit"
          data-action="submit-idea"
          disabled={ideaSubmitting || !ideaDraft.trim()}
          title="Submit"
          aria-label="Submit idea"
        >
          <TrayIcon name="send" />
        </button>
      </form>

      {program?.directive &&
      (generating ||
        program.phase === "locked" ||
        program.phase === "ready") ? (
        <div className="trayLocked">
          <span>{program.directive.text}</span>
          <i>{directiveAuthor(program.directive)}</i>
        </div>
      ) : null}

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
  if (!worldState) return null;
  return (
    <div className="trayWorld">
      <div className="trayWorldLocation">
        <b>{worldState.location || "—"}</b>
        {worldState.locationDetails ? (
          <p>{worldState.locationDetails}</p>
        ) : null}
        {worldState.lastEndingBeat ? (
          <em>{worldState.lastEndingBeat}</em>
        ) : null}
      </div>

      {worldState.characters.length ? (
        <div className="trayWorldGrid">
          {worldState.characters.map((item) => (
            <article key={item.id}>
              <b>{item.name}</b>
              <span>{item.status}</span>
              {item.position ? <small>{item.position}</small> : null}
            </article>
          ))}
        </div>
      ) : null}

      {worldState.props.length ? (
        <div className="trayWorldGrid compact">
          {worldState.props.map((item) => (
            <article key={item.id}>
              <b>{item.name}</b>
              <span>{item.status}</span>
              {item.position ? <small>{item.position}</small> : null}
            </article>
          ))}
        </div>
      ) : null}

      {worldState.openThreads.length ? (
        <div className="trayThreads">
          {worldState.openThreads.slice(0, 8).map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ParticipationTray() {
  const round = trayRound();
  const phase = program?.phase || "idle";
  const targetEpisode = round?.targetEpisode ?? program?.targetEpisode ?? 0;
  const candidateCount = round?.proposals.length || 0;
  const walletTitle =
    walletState === "missing"
      ? "Install Phantom"
      : walletAddress
        ? walletAddress
        : walletState === "connecting"
          ? "Connecting Phantom"
          : "Connect Phantom";

  return (
    <section className={`participationTray ${trayOpen ? "open" : ""}`}>
      <div className="trayBar">
        <button
          className="trayToggle"
          type="button"
          data-action="tray-toggle"
          title={trayOpen ? "Collapse" : "Open"}
          aria-label={
            trayOpen ? "Collapse participation" : "Open participation"
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
            className={`trayAction wallet ${walletAddress ? "on" : ""} ${walletState}`}
            type="button"
            data-action="wallet"
            title={walletTitle}
            aria-label={walletTitle}
          >
            <TrayIcon name="wallet" />
            {walletAddress ? <span>{shortAddress(walletAddress)}</span> : null}
          </button>
          <button
            className={`trayAction ${trayOpen && trayView === "ideas" ? "on" : ""}`}
            type="button"
            data-action="tray-ideas"
            title="Ideas"
            aria-label="Ideas and voting"
          >
            <TrayIcon name="ideas" />
          </button>
          <button
            className={`trayAction ${trayOpen && trayView === "world" ? "on" : ""}`}
            type="button"
            data-action="tray-world"
            title="World"
            aria-label="World state"
          >
            <TrayIcon name="world" />
          </button>
        </div>
      </div>

      {trayOpen ? (
        <div className="trayBody">
          {participationError ? (
            <div
              className="trayError"
              title={participationError}
              aria-label={participationError}
            >
              !
            </div>
          ) : null}
          {trayView === "world" ? (
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
  return (
    <div
      className="currentPrompt"
      data-current-prompt
      data-empty={clip ? undefined : ""}
    >
      <span data-current-prompt-text>{clip?.directive || ""}</span>
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
    maximumFractionDigits: 6,
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
  const pending = votePendingId === proposal.id;
  return (
    <div
      className={`persistentProposal ${rank === 1 ? "leader" : ""} ${own ? "own" : ""} ${pending ? "pending" : ""}`}
      data-proposal-id={proposal.id}
    >
      <em className="proposalRank">{rank}</em>
      <div className="persistentProposalText">
        <span>{proposal.text}</span>
        <i>
          <code>#{proposal.id}</code>
          {proposal.author || proposal.authorAddress ? (
            <>{authorLabel(proposal.author, proposal.authorAddress)}</>
          ) : null}
        </i>
      </div>
      {own ? (
        <>
          <b
            className="proposalTotal"
            data-rich-tooltip="1"
            data-tooltip-kicker={`SCORE · #${proposal.id}`}
            data-tooltip-body={proposalScoreTooltip(proposal)}
          >
            {formatScore(proposal.voteCount)}
          </b>
          <div className="ownIdeaActions">
            <button type="button" data-action="edit-own" aria-label="Edit idea">
              <BoardIcon name="edit" />
            </button>
            <button
              type="button"
              data-action="cancel-own"
              aria-label="Cancel idea"
            >
              <BoardIcon name="cancel" />
            </button>
          </div>
        </>
      ) : (
        <button
          type="button"
          className="proposalVote"
          data-action="vote"
          data-proposal-id={proposal.id}
          disabled={pending}
          aria-label={`Vote with score ${formatScore(walletPower)}. Current total ${formatScore(proposal.voteCount)}`}
          data-rich-tooltip="1"
          data-tooltip-kicker={`SCORE · #${proposal.id}`}
          data-tooltip-body={proposalScoreTooltip(proposal)}
          data-tooltip-meta={`Your vote adds ${formatExactScore(walletPower)}`}
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
  return (
    <section className="persistentIdeas" aria-label="Suggestions">
      <form className="persistentIdeaForm" data-idea-form>
        <input
          data-idea-input
          value={ideaDraft}
          maxLength={500}
          autoComplete="off"
          spellCheck="true"
          placeholder={own ? "edit your idea" : "what happens next?"}
          aria-label="Your idea"
          disabled={ideaSubmitting}
        />
        <button
          type="submit"
          data-action="submit-idea"
          disabled={ideaSubmitting || !ideaDraft.trim()}
          aria-label={own ? "Save idea" : "Submit idea"}
        >
          <BoardIcon name="send" />
        </button>
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
  if (!worldState || !worldDetailKind) return null;
  if (worldDetailKind === "location")
    return {
      title: worldState.location,
      lines: [
        worldState.locationDetails,
        worldState.lastEndingBeat,
        ...worldState.openThreads,
      ].filter(Boolean),
    };
  if (worldDetailKind === "character") {
    const item = worldState.characters.find(
      (character) => character.id === worldDetailId,
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
  const item = worldState.props.find((prop) => prop.id === worldDetailId);
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
  if (!worldState) return <section className="persistentWorld" />;
  return (
    <section className="persistentWorld" aria-label="World state">
      <button
        type="button"
        className="worldLocationCard"
        data-action="world-detail"
        data-world-kind="location"
        data-world-id="location"
        data-rich-tooltip="1"
        data-tooltip-kicker={worldState.location || "WORLD"}
        data-tooltip-body={
          worldState.locationDetails || worldState.lastEndingBeat || ""
        }
        data-tooltip-meta={worldState.lastEndingBeat || ""}
      >
        <b>{worldState.location || "—"}</b>
        {worldState.lastEndingBeat ? (
          <span>{worldState.lastEndingBeat}</span>
        ) : null}
      </button>
      {worldState.characters.length ? (
        <div className="persistentWorldItems">
          {worldState.characters.map((item) => (
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
      {worldState.props.length ? (
        <div className="persistentWorldItems props">
          {worldState.props.map((item) => (
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
      {worldState.openThreads.length ? (
        <div className="persistentThreads">
          {worldState.openThreads.slice(0, 2).map((thread) => (
            <span key={thread}>{thread}</span>
          ))}
          {worldState.openThreads.length > 2 ? (
            <button
              type="button"
              data-action="world-detail"
              data-world-kind="location"
              data-world-id="location"
              aria-label={`${worldState.openThreads.length - 2} more open threads`}
            >
              +{worldState.openThreads.length - 2}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ParticipationBoard() {
  const round = currentBoardRound();
  const candidates = sortedCandidates(round);
  const leader = candidates[0] || null;
  const walletTitle = walletAddress
    ? `${shortAddress(walletAddress)} · ${formatExactScore(walletTokenBalance)} tokens · power ${formatExactScore(walletPower)}`
    : "Connect Phantom";
  const own = ownProposal();

  return (
    <section className={`participationBoard ${trayOpen ? "open" : ""}`}>
      <div className="participationDock">
        <button
          className="boardToggle"
          type="button"
          data-action="tray-toggle"
          aria-label={
            trayOpen ? "Close ideas" : own ? "Open my idea" : "Add an idea"
          }
          aria-expanded={trayOpen}
        >
          <span>{own ? "MY IDEA" : "ADD IDEA"}</span>
          <TrayIcon name="chevron" />
        </button>

        <span
          className="viewerMetric"
          aria-label={`${room?.viewerCount ?? 0} viewers`}
        >
          <BoardIcon name="viewer" />
          <b>{room?.viewerCount ?? 0}</b>
        </span>

        <button
          className="dockIdeaSummary"
          type="button"
          data-action="tray-toggle"
          aria-label="Open suggestions and world state"
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
          className={`walletMetric ${walletAddress ? "connected" : ""}`}
          data-action="wallet"
          aria-label={walletTitle}
          data-rich-tooltip={walletAddress ? "1" : undefined}
          data-tooltip-kicker={walletAddress ? "TOKEN POWER" : undefined}
          data-tooltip-body={
            walletAddress
              ? `Balance ${formatExactScore(walletTokenBalance)}\nVoting power ${formatExactScore(walletPower)}`
              : undefined
          }
          data-tooltip-meta={
            walletAddress ? shortAddress(walletAddress) : undefined
          }
        >
          <BoardIcon name="wallet" />
          {walletAddress ? (
            <b>{walletScoreLoading ? "…" : formatScore(walletPower)}</b>
          ) : null}
        </button>

        {participationError ? (
          <i
            className="participationError"
            data-rich-tooltip="1"
            data-tooltip-kicker="ERROR"
            data-tooltip-body={participationError}
          >
            !
          </i>
        ) : null}
      </div>

      <div className="participationSheet" aria-hidden={!trayOpen}>
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

function TactileTV({ clip }: { clip: Clip | null }) {
  const state = engineState();
  const isReplay = replayClipId != null;

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
          <CurrentPrompt clip={clip} />
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
            active={!playbackPaused}
            title={playbackPaused ? "Play" : "Pause"}
            icon="playback"
            action="playback"
          />
          <KnobControl
            active={soundEnabled}
            title={soundEnabled ? "Mute" : "Unmute"}
            icon="sound"
            action="sound"
          />
          <KnobControl
            active={captionsEnabled}
            title={
              captionsEnabled ? "Hide prompt captions" : "Show prompt captions"
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
  if (!program) return null;
  const phase = program.phase;
  const candidateCount = program.votingRound?.proposals.length || 0;
  if (phase === "ready") return null; // the real future clip card is already in the rail
  if (phase === "idle" && candidateCount === 0) return null;
  const episode = program.targetEpisode + 1;
  const directiveText = program.directive?.text?.trim() || "";
  const title =
    program.reason ||
    (phase === "voting"
      ? `Voting for episode ${episode}`
      : phase === "planning" || phase === "rendering" || phase === "finalizing"
        ? `Generating episode ${episode}`
        : phase === "locked"
          ? `Episode ${episode} locked`
          : `Waiting for episode ${episode}`);
  const copy =
    directiveText ||
    (candidateCount
      ? `${candidateCount} idea${candidateCount === 1 ? "" : "s"}`
      : "");
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
  const episodes = [...timeline]
    .filter((clip) => Boolean(clip.videoUrl))
    .sort((a, b) => b.episode - a.episode || b.id - a.id);
  const shown = visibleClip();
  const live = latestPublishedClip();

  return (
    <aside className="episodeShelf" aria-label="Episodes">
      <button
        className={`liveCap ${replayClipId == null ? "active" : ""}`}
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
          const isLive = live?.id === clip.id && replayClipId == null;
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
        --pump-gold: #d7a43b;
        --pump-gold-hi: #f3cc72;
        --pump-gold-low: #8f661f;
        --pump-silver: #c8c9cb;
        --pump-silver-dim: #7d8085;
        --pump-black: #090a0b;
        --pump-panel: #111214;
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
        box-shadow: 0 0 0 1px rgba(215,164,59,.22), 0 0 12px rgba(215,164,59,.28) !important;
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
        border-color: rgba(215,164,59,.48) !important;
        background:
          linear-gradient(180deg, rgba(215,164,59,.12), rgba(255,255,255,.015)),
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
        background: linear-gradient(90deg, rgba(215,164,59,.09), rgba(200,201,203,.025)) !important;
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
        text-shadow: 0 0 8px rgba(215,164,59,.45) !important;
      }
      .episodeCard.active .episodeThumb {
        border-color: rgba(215,164,59,.32) !important;
        box-shadow:
          inset 0 1px rgba(255,255,255,.07),
          0 7px 20px rgba(0,0,0,.30),
          -3px 0 0 rgba(215,164,59,.72) !important;
      }
      .liveCap.active { color: var(--pump-gold-hi) !important; }

      .programShelfSlot {
        border-color: rgba(215,164,59,.24) !important;
        background: linear-gradient(180deg, rgba(215,164,59,.07), rgba(255,255,255,.012)) !important;
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
        border-color: rgba(215,164,59,.26) !important;
        background: linear-gradient(180deg, rgba(215,164,59,.055), rgba(255,255,255,.015)) !important;
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
        color: rgba(243,204,114,.72) !important;
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
        border-color: rgba(215,164,59,.38) !important;
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
        box-shadow: 0 0 5px rgba(243,204,114,.26);
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
        border-color: rgba(215,164,59,.34) !important;
        background:
          linear-gradient(180deg, rgba(215,164,59,.09), rgba(255,255,255,.012) 58%, rgba(0,0,0,.09)),
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
        background: linear-gradient(90deg, rgba(215,164,59,.07), rgba(255,255,255,.022)) !important;
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
        box-shadow: 0 0 7px rgba(215,164,59,.20) !important;
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
        border-color: rgba(215,164,59,.18) !important;
        background: linear-gradient(90deg, rgba(215,164,59,.045), rgba(255,255,255,.016)) !important;
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
        box-shadow: 0 1px 5px rgba(215,164,59,.24) !important;
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
        box-shadow: 0 1px 4px rgba(215,164,59,.18) !important;
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
        border: 1px solid rgba(215,164,59,.18) !important;
        border-radius: 5px !important;
        background: rgba(215,164,59,.045) !important;
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
        border-color: rgba(215,164,59,.28) !important;
        background: rgba(215,164,59,.045) !important;
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
        border-color: rgba(215,164,59,.12) !important;
        border-radius: 9px !important;
        background:
          linear-gradient(180deg, rgba(215,164,59,.025), transparent 58%),
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
        text-shadow: 0 0 7px rgba(215,164,59,.22) !important;
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
        background: rgba(215,164,59,.055) !important;
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
        border: 1px solid rgba(215,164,59,.18) !important;
        background: rgba(215,164,59,.045) !important;
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

      @media (max-width: 820px) {
        .minimalTop .wordmark { width: 58px !important; height: 58px !important; }
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
            <img className="pumptvLogo" src="/api/logo" alt="PumpTV" />
          </div>
          <div className="tinyStatus">
            <i
              className={`statusDot ${state}`}
              data-rich-tooltip="1"
              data-tooltip-kicker="STATUS"
              data-tooltip-body={tooltipStatus()}
            />
            {transport !== "live" ? (
              <i className="transportDot" aria-label={transport} />
            ) : null}
          </div>
        </div>
        <div className="tvCenter">
          <TactileTV clip={clip} />
        </div>
        <ParticipationBoard />
        {error ? (
          <div
            className="fatalBadge"
            data-rich-tooltip="1"
            data-tooltip-kicker="ERROR"
            data-tooltip-body={error}
          >
            !
          </div>
        ) : null}
        {room?.generation.paused ? (
          <div
            className="fatalBadge warning"
            data-rich-tooltip="1"
            data-tooltip-kicker="GENERATION"
            data-tooltip-body={room.generation.reason || "Generation paused"}
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
