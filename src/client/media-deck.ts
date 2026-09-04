import { createMeasure } from "measure-fn";
import { createInvalidationQueue } from "./signals.ts";
import type { Clip } from "../shared/contracts.ts";

const mediaMeasure = createMeasure("media");

export type LiveSlotState = "playing" | "intermission" | "transitioning";

export type MediaDeckState = {
  timeline: Clip[];
  replayClipId: number | null;
  playbackPaused: boolean;
  pausedClipId: number | null;
  soundEnabled: boolean;
  liveSlotState: LiveSlotState;
  lastEndedLiveClipId: number | null;
};

export type MediaSelectionState = Pick<
  MediaDeckState,
  "timeline" | "replayClipId" | "playbackPaused" | "pausedClipId"
>;

export function publishedClips(timeline: Clip[], nowMs: number) {
  return timeline.filter((clip) => clip.startsAtMs <= nowMs);
}

export function latestPublishedClipFor(timeline: Clip[], nowMs: number) {
  const published = publishedClips(timeline, nowMs);
  return published.length ? published[published.length - 1] : null;
}

export function desiredClipFor(state: MediaSelectionState, nowMs: number) {
  const replay =
    state.replayClipId == null
      ? null
      : state.timeline.find((clip) => clip.id === state.replayClipId) || null;
  const latest = latestPublishedClipFor(state.timeline, nowMs);
  if (state.playbackPaused && state.pausedClipId != null)
    return (
      state.timeline.find((clip) => clip.id === state.pausedClipId) ||
      replay ||
      latest
    );
  return replay || latest;
}

export function clipAfterFor(
  timeline: Clip[],
  clip: Clip | null,
  nowMs: number,
  replayMode: boolean,
) {
  if (!clip) return null;
  const ordered = replayMode ? publishedClips(timeline, nowMs) : timeline;
  const index = ordered.findIndex((candidate) => candidate.id === clip.id);
  return index >= 0 ? ordered[index + 1] || null : null;
}

type MediaDeckOptions = {
  state: MediaDeckState;
  nowMs: () => number;
  refreshStreamState: () => Promise<unknown>;
  syncLocalUiState: () => void;
  syncLocalPresentation: () => void;
  syncEpisodeSelection: () => void;
  centerSelectedEpisode: (behavior?: ScrollBehavior) => void;
  scheduleViewRender: (reason: string) => void;
};

function clientErrorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : String(error ?? "Unknown error");
}

export function createMediaDeckController(options: MediaDeckOptions) {
  const view = options.state;
  function setLiveSlotState(
    next: LiveSlotState,
    reason: string,
    detail: Record<string, unknown> = {},
  ) {
    if (view.liveSlotState === next) {
      options.syncLocalUiState();
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
    options.syncLocalUiState();
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
  let pendingActivation: {
    clipId: number;
    slot: number;
    serial: number;
  } | null = null;
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
    return options.nowMs();
  }

  function publishedTimeline(now = liveNowMs()) {
    return publishedClips(view.timeline, now);
  }

  function latestPublishedClip() {
    return latestPublishedClipFor(view.timeline, liveNowMs());
  }

  function desiredClip() {
    return desiredClipFor(view, liveNowMs());
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
    void options.refreshStreamState();
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
    return clipAfterFor(
      view.timeline,
      clip,
      liveNowMs(),
      view.replayClipId != null,
    );
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

  function attachVideoSource(
    video: HTMLVideoElement,
    clip: Clip,
    slot: number,
  ) {
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

  function startColdLivePrime(
    clip: Clip,
    nodes: Array<HTMLVideoElement | null>,
  ) {
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
        revealingFromIntermission
          ? "incoming-first-frame"
          : "video-first-frame",
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
    if (changed) options.syncLocalPresentation();
    options.scheduleViewRender("media:presentation");
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

      if (
        crossfade?.serial === serial &&
        crossfade.incomingClipId === clip.id
      ) {
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
          setLiveSlotState("playing", "crossfade-complete", {
            clipId: clip.id,
          });
        }
      }
    } else {
      video.classList.remove("entering", "reveal");
    }

    invalidate("crossfade-settled");
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
              if (pendingActivation?.serial === serial)
                pendingActivation = null;
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
      options.syncLocalUiState();
      options.syncEpisodeSelection();
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
      options.syncLocalUiState();
      return;
    }

    view.playbackPaused = false;
    view.pausedClipId = null;
    if (view.replayClipId == null)
      setLiveSlotState("playing", "manual-playback-resume");
    switchSerial += 1;
    pendingActivation = null;
    options.syncLocalUiState();
    primeDesiredPlaybackFromGesture();
    syncVideoDeck();
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
    options.syncLocalUiState();
    options.syncEpisodeSelection();
    options.centerSelectedEpisode("smooth");
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
    options.syncLocalUiState();
    options.syncEpisodeSelection();
    options.centerSelectedEpisode("smooth");
    primeDesiredPlaybackFromGesture();
    syncVideoDeck();
  }

  const syncQueue = createInvalidationQueue((reasons) => {
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

  function invalidate(reason: string) {
    syncQueue.invalidate(reason);
  }

  function applyUiState() {
    mediaDeck?.classList.toggle(
      "intermission",
      view.replayClipId == null && view.liveSlotState === "intermission",
    );
    if (!mediaDeck) return;
    const nodes = Array.from(
      mediaDeck.querySelectorAll("video"),
    ) as HTMLVideoElement[];
    for (const video of nodes) {
      if (video.dataset.clipId === String(activeVideoClipId))
        video.muted = !view.soundEnabled;
      else video.muted = true;
    }
  }

  function activeClip() {
    return activeVideoClipId == null
      ? null
      : view.timeline.find((clip) => clip.id === activeVideoClipId) || null;
  }

  function status() {
    return {
      activeClipId: activeVideoClipId,
      desiredClipId: desiredClip()?.id ?? null,
      liveSlot: view.liveSlotState,
    };
  }

  return {
    activeClip,
    applyUiState,
    desiredClip,
    ensureMediaDeck,
    incomingLiveClipPending,
    invalidate,
    jumpToEpisode,
    latestPublishedClip,
    observeMediaTarget,
    positionMediaDeck,
    publishedTimeline,
    reconcileLiveEdge,
    returnLive,
    status,
    syncNow: syncVideoDeck,
    syncPoster,
    togglePlayback,
    visibleClip,
  };
}
