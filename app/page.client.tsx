import { render } from "tradjs/client";
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

let timeline: Clip[] = [];
let room: RoomState | null = null;
let nextDirective: Directive | null = null;
let program: LiveProgramState | null = null;
let worldState: WorldState | null = null;
let serverOffsetMs = 0;
let replayClipId: number | null = null;
let source: EventSource | null = null;
let viewerId = "";
let transport: "connecting" | "live" | "reconnecting" = "connecting";
let error: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

let soundEnabled = false;
let captionsEnabled = true;
let liveOverlayEnabled = true;
let infoOpen = false;

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

async function json<T>(url: string): Promise<T> {
  const response = await fetch(url);
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
  if (
    replayClipId != null &&
    !timeline.some((clip) => clip.id === replayClipId)
  )
    replayClipId = null;
  error = null;
  redraw();
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
  html.dataset.pumptvMode = replayClipId == null ? "live" : "replay";
  html.dataset.pumptvSlot = replayClipId == null ? liveSlotState : "replay";

  document
    .querySelectorAll<HTMLElement>("[data-control]")
    .forEach((control) => {
      const name = control.dataset.control;
      const active =
        name === "sound"
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
  prompt.setAttribute(
    "title",
    clip ? `Episode ${clip.episode + 1} · ${clipAuthor(clip)}` : "",
  );
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
  }

  soundEnabled = readPref("pumptv-v25-sound", false);
  captionsEnabled = readPref("pumptv-v25-captions", true);
  liveOverlayEnabled = readPref("pumptv-v25-live-overlay", true);
}

async function boot() {
  ensureViewerIdAndPrefs();
  installInteractionLayer();
  syncLocalUiState();
  redraw();
  try {
    applyState(await json<StreamState>("/api/state"));
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "offline";
    redraw();
  }

  source = new EventSource(
    `/api/events?viewerId=${encodeURIComponent(viewerId)}`,
  );
  source.onopen = () => {
    transport = "live";
    redraw();
  };
  source.onmessage = (event) => {
    try {
      applyState(JSON.parse(event.data) as StreamState);
    } catch {
      error = "invalid stream state";
      redraw();
    }
  };
  source.onerror = () => {
    transport = "reconnecting";
    redraw();
  };

  timer = setInterval(() => {
    syncVideoDeck();
    updateLiveMeters();
  }, 100);
}

function configureVideo(video: HTMLVideoElement, clip: Clip, slot: number) {
  if (video.dataset.clipId === String(clip.id) && video.src) return;

  video.pause();
  video.classList.remove("active", "retiring");
  video.dataset.clipId = String(clip.id);
  video.dataset.ready = "0";
  video.dataset.resumePending = "0";
  video.preload = "auto";
  video.playsInline = true;
  video.muted = true;
  video.poster = clipPoster(clip);
  video.src = clip.videoUrl;
  video.oncanplay = () => {
    video.dataset.ready = "1";
    syncVideoDeck();
  };
  video.onloadeddata = () => {
    video.dataset.ready = "1";
    syncVideoDeck();
  };
  video.onended = () => handleDeckEnded(slot, clip.id);
  video.load();
}

function targetTimeFor(_clip: Clip) {
  // Publication decides which episode is live. Playback always reveals a newly
  // selected/published episode from frame 0 so transitions never jump into the
  // middle of a clip.
  return 0;
}

function bufferedFromStart(video: HTMLVideoElement) {
  for (let index = 0; index < video.buffered.length; index += 1) {
    const start = video.buffered.start(index);
    const end = video.buffered.end(index);
    if (start <= 0.08) return Math.max(0, end);
  }
  return 0;
}

function smoothStartGoal(video: HTMLVideoElement) {
  const duration = video.duration;
  if (Number.isFinite(duration) && duration > 0) {
    // PumpTV episodes are currently ~5 seconds. Fully buffer short episodes on
    // a cold page load so the viewer never watches network/decode warm-up as
    // visible stutter. Longer future formats only require a healthy runway.
    if (duration <= 8) return Math.max(1.25, duration - 0.15);
    return Math.max(2.5, Math.min(4, duration * 0.4));
  }
  return 2.5;
}

async function waitForSmoothStartBuffer(video: HTMLVideoElement) {
  const goal = smoothStartGoal(video);
  const startedAt = performance.now();
  const hardTimeoutMs = 8_000;

  while (bufferedFromStart(video) < goal) {
    if (video.error)
      throw new Error(`media error ${video.error.code} while buffering`);
    if (performance.now() - startedAt >= hardTimeoutMs) {
      const buffered = bufferedFromStart(video);
      // Never fail forever on servers/browsers that do not aggressively honor
      // preload=auto. We still require a meaningful runway before revealing.
      if (
        buffered >= 1.25 ||
        video.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA
      )
        return;
      throw new Error(
        `timed out warming playback buffer (${buffered.toFixed(2)}s buffered)`,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

async function rewindForReveal(video: HTMLVideoElement) {
  if (video.currentTime <= 0.03) {
    try {
      video.currentTime = 0;
    } catch {}
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      video.removeEventListener("seeked", finish);
      resolve();
    };
    const timeout = setTimeout(finish, 1_000);
    video.addEventListener("seeked", finish, { once: true });
    try {
      video.currentTime = 0;
    } catch {
      finish();
    }
  });
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

  const previous = nodes[activeVideoSlot];

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
    const coldBootstrap = activeVideoClipId == null && previous === video;
    if (coldBootstrap) {
      if (replayClipId == null && liveSlotState !== "transitioning") {
        liveSlotState = "transitioning";
        syncLocalUiState();
      }
      // A fresh page load has no already-warm outgoing deck. Start the hidden
      // video muted to make the browser fetch/decode aggressively, wait for a
      // real playback runway, then rewind before the viewer sees frame 0.
      await video.play();
      await waitForSmoothStartBuffer(video);
      video.pause();
      await rewindForReveal(video);
    }
    await video.play();
    await waitForPaint(video);
  } catch (cause) {
    console.warn(
      `[pumptv/media] activation failed for EP ${clip.episode + 1}`,
      cause,
      video.error,
    );
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

      if (action === "sound") toggleSound();
      else if (action === "captions") toggleCaptions();
      else if (action === "overlay") toggleLiveOverlay();
      else if (action === "info") toggleInfo();
      else if (action === "close-info") {
        if (infoOpen) {
          infoOpen = false;
          syncLocalUiState();
        }
      } else if (action === "fullscreen") void toggleFullscreen();
      else if (action === "live") returnLive();
      else if (action === "episode") {
        const id = Number(control.dataset.episodeId);
        if (Number.isFinite(id)) jumpToEpisode(id);
      }
    },
    true,
  );

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && infoOpen) {
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
  if (!room.pumpfun.enabled) return "Pump.fun chat is not configured";
  if (room.pumpfun.state !== "live")
    return `Pump.fun chat: ${room.pumpfun.state}`;
  if (program.phase === "voting")
    return "Pump.fun is choosing the next episode";
  if (program.phase === "locked") return "Next episode locked";
  if (
    program.phase === "planning" ||
    program.phase === "rendering" ||
    program.phase === "finalizing"
  )
    return "Generating next PumpTV episode";
  if (program.phase === "ready") return "Next episode ready";
  return "Waiting for Pump.fun suggestions";
}

type ControlIconName = "sound" | "captions" | "overlay" | "info" | "fullscreen";
type ControlAction = "sound" | "captions" | "overlay" | "info" | "fullscreen";

function ControlIcon({ name }: { name: ControlIconName }) {
  if (name === "sound")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 9v6h4l5 4V5L8 9H4Z" />
        <path
          className="stroke"
          d="M16 9.2c1.1 1.1 1.1 4.5 0 5.6M18.5 7c2.6 2.5 2.6 7.5 0 10"
        />
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
      title={props.title}
      aria-label={props.title}
      aria-pressed={Boolean(props.active)}
    >
      <span className="knobNeedle" />
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
}: {
  round: PromptRound | null;
  limit?: number;
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
            className={`rankRow ${selected ? "winner" : ""}`}
            key={candidate.id}
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
      title={props.title}
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

function CurrentPrompt({ clip }: { clip: Clip | null }) {
  return (
    <div
      className="currentPrompt"
      data-current-prompt
      data-empty={clip ? undefined : ""}
      title={clip ? `Episode ${clip.episode + 1} · ${clipAuthor(clip)}` : ""}
    >
      <span data-current-prompt-text>{clip?.directive || ""}</span>
      <i data-current-prompt-author>{clip ? clipAuthor(clip) : ""}</i>
    </div>
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
            <div className="tvIdle" title={tooltipStatus()}>
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
              title="Return to live"
              aria-label="Return to live"
            >
              ●
            </button>
          ) : null}
        </div>
      </div>

      <div className="tvHardware">
        <button
          className={`powerLamp ${state}`}
          title={tooltipStatus()}
          aria-label={tooltipStatus()}
        />
        <div className="knobStack">
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
  const round = program.votingRound || program.decisionRound;
  const candidateCount = round?.proposals.length || 0;
  const phase = program.phase;
  const title =
    program.reason ||
    (phase === "voting"
      ? `Voting for episode ${program.targetEpisode + 1}`
      : phase === "planning" || phase === "rendering" || phase === "finalizing"
        ? `Generating episode ${program.targetEpisode + 1}`
        : phase === "locked"
          ? `Episode ${program.targetEpisode + 1} locked`
          : phase === "ready"
            ? `Episode ${program.targetEpisode + 1} ready`
            : `Waiting for episode ${program.targetEpisode + 1}`);
  return (
    <div
      className={`programShelfSlot phase-${phase}`}
      title={title}
      aria-label={title}
    >
      <span className="programShelfVisual">
        <i className="programShelfPulse" />
        {candidateCount > 0 ? <small>{candidateCount}</small> : null}
      </span>
      <b>{program.targetEpisode + 1}</b>
    </div>
  );
}

function EpisodeShelf() {
  const published = [...publishedTimeline()].reverse();
  const shown = visibleClip();
  const live = latestPublishedClip();

  return (
    <aside className="episodeShelf" aria-label="Episodes">
      <div className="brandStamp" title="PumpTV">
        <span>P</span>
      </div>
      <button
        className={`liveCap ${replayClipId == null ? "active" : ""}`}
        type="button"
        data-action="live"
        title="Live"
        aria-label="Live"
      >
        <span>●</span>
        <b>{room?.viewerCount ?? 0}</b>
      </button>
      <div className="episodeList">
        <ProgramShelfSlot />
        {published.map((clip) => {
          const active = shown?.id === clip.id;
          const isLive = live?.id === clip.id && replayClipId == null;
          const thumb =
            clip.startFrameUrl || clip.endFrameUrl || clip.anchorFrameUrl;
          return (
            <button
              className={`episodeCard ${active ? "active" : ""} ${isLive ? "live" : ""}`}
              type="button"
              data-action="episode"
              data-episode-id={clip.id}
              title={`Episode ${clip.episode + 1} · ${clip.directive}`}
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
      <div
        className={`pumpLink ${room?.pumpfun.state || "disabled"}`}
        title={
          room?.pumpfun.enabled
            ? `Pump.fun chat: ${room.pumpfun.state}`
            : "Pump.fun mint not configured"
        }
      >
        $
      </div>
    </aside>
  );
}

function OutsideInterfaceStyles() {
  return (
    <style>{`
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

      @media (max-width: 760px) {
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
          <div className="wordmark" title="PumpTV" aria-label="PumpTV">
            <span>P</span>
          </div>
          <div className="tinyStatus">
            <i className={`statusDot ${state}`} title={tooltipStatus()} />
            {transport !== "live" ? (
              <i className="transportDot" title={transport} />
            ) : null}
          </div>
        </div>
        <div className="tvCenter">
          <TactileTV clip={clip} />
        </div>
        <OutsideConsole />
        {error ? (
          <div className="fatalBadge" title={error}>
            !
          </div>
        ) : null}
        {room?.generation.paused ? (
          <div
            className="fatalBadge warning"
            title={room.generation.reason || "Generation paused"}
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
