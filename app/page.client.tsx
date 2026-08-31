import { render } from "tradjs/client";
import type {
  Clip,
  Directive,
  RoomState,
  StreamState,
} from "../src/shared/contracts.ts";

let timeline: Clip[] = [];
let room: RoomState | null = null;
let nextDirective: Directive | null = null;
let serverOffsetMs = 0;
let replayClipId: number | null = null;
let source: EventSource | null = null;
let viewerId = "";
let transport: "connecting" | "live" | "reconnecting" = "connecting";
let error: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

let soundEnabled = false;
let captionsEnabled = true;
let nextCueEnabled = true;
let activeVideoSlot = 0;
let activeVideoClipId: number | null = null;
let swappingVideo = false;

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

function nextScheduledClip() {
  const now = liveNowMs();
  return timeline.find((clip) => clip.startsAtMs > now) || null;
}

function clipAfter(clip: Clip | null) {
  if (!clip) return null;
  const ordered = replayClipId == null ? timeline : publishedTimeline();
  const index = ordered.findIndex((candidate) => candidate.id === clip.id);
  return index >= 0 ? ordered[index + 1] || null : null;
}

function redraw() {
  const root = document.getElementById("pumptv-root");
  if (root) render(<App />, root);
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
  if (
    replayClipId != null &&
    !timeline.some((clip) => clip.id === replayClipId)
  )
    replayClipId = null;
  error = null;
  redraw();
  queueMicrotask(syncVideoDeck);
}

function readPref(key: string, fallback: boolean) {
  const value = localStorage.getItem(key);
  return value == null ? fallback : value === "1";
}

function writePref(key: string, value: boolean) {
  localStorage.setItem(key, value ? "1" : "0");
}

function ensureViewerIdAndPrefs() {
  const key = "pumptv-viewer-id";
  viewerId = localStorage.getItem(key) || "";
  if (!viewerId) {
    viewerId = crypto.randomUUID();
    localStorage.setItem(key, viewerId);
  }

  soundEnabled = readPref("pumptv-sound", false);
  captionsEnabled = readPref("pumptv-captions", true);
  nextCueEnabled = readPref("pumptv-next-cue", true);
}

async function boot() {
  ensureViewerIdAndPrefs();
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
    queueMicrotask(syncVideoDeck);
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

  // Playback timing is deliberately separate from UI rendering. The video deck
  // can swap on the exact episode boundary without rerendering the whole app.
  timer = setInterval(syncVideoDeck, 100);
}

function videoNodes() {
  return [0, 1].map(
    (slot) =>
      document.querySelector(
        `video.tvVideoLayer[data-slot="${slot}"]`,
      ) as HTMLVideoElement | null,
  );
}

function clipPoster(clip: Clip | null) {
  if (!clip) return "";
  return clip.anchorFrameUrl || clip.startFrameUrl || clip.endFrameUrl || "";
}

function configureVideo(video: HTMLVideoElement, clip: Clip, slot: number) {
  if (video.dataset.clipId === String(clip.id) && video.src) return;

  video.pause();
  video.classList.remove("active");
  video.dataset.clipId = String(clip.id);
  video.dataset.ready = "0";
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

function targetTimeFor(clip: Clip) {
  if (replayClipId != null) return 0;
  const duration = Math.max(0.1, clip.durationSeconds);
  const age = Math.max(0, (liveNowMs() - clip.startsAtMs) / 1000);
  // When chat is quiet the newest episode is the channel loop. Keep it moving
  // while waiting, but a newly scheduled clip can still take over immediately.
  return age % duration;
}

function activateVideoSlot(
  slot: number,
  clip: Clip,
  video: HTMLVideoElement,
  nodes: Array<HTMLVideoElement | null>,
) {
  const alreadyActive =
    slot === activeVideoSlot &&
    activeVideoClipId === clip.id &&
    video.classList.contains("active");
  if (alreadyActive) {
    video.muted = !soundEnabled;
    if (video.paused) void video.play().catch(() => {});
    return;
  }
  if (swappingVideo) return;
  swappingVideo = true;

  const previous = nodes[activeVideoSlot];
  const changedClip = activeVideoClipId !== clip.id;

  if (changedClip) {
    try {
      video.currentTime = targetTimeFor(clip);
    } catch {}
  } else if (replayClipId == null) {
    const target = targetTimeFor(clip);
    if (Math.abs(video.currentTime - target) > 0.9) {
      try {
        video.currentTime = target;
      } catch {}
    }
  }

  video.muted = !soundEnabled;
  void video
    .play()
    .then(() => {
      // The incoming deck becomes visible only after play() succeeds. The outgoing
      // deck therefore remains the visual fallback throughout network/decode delay.
      video.classList.add("active");
      video.setAttribute("aria-hidden", "false");
      if (previous && previous !== video) {
        previous.classList.remove("active");
        previous.setAttribute("aria-hidden", "true");
        previous.muted = true;
        previous.pause();
      }

      activeVideoSlot = slot;
      const didChange = activeVideoClipId !== clip.id;
      activeVideoClipId = clip.id;
      swappingVideo = false;
      if (didChange) redraw();
      queueMicrotask(syncVideoDeck);
    })
    .catch(() => {
      swappingVideo = false;
    });
}

function syncVideoDeck() {
  const wanted = desiredClip();
  const nodes = videoNodes();
  if (!nodes[0] || !nodes[1]) return;

  if (!wanted) {
    for (const video of nodes) {
      if (!video) continue;
      video.pause();
      video.classList.remove("active");
      video.muted = true;
    }
    activeVideoClipId = null;
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
      wantedVideo.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
    if (ready) activateVideoSlot(wantedSlot, wanted, wantedVideo, nodes);
  }

  const activeClip =
    activeVideoClipId == null
      ? null
      : timeline.find((clip) => clip.id === activeVideoClipId) || wanted;
  const preload = clipAfter(activeClip);
  if (preload && preload.id !== wanted.id) {
    const preloadSlot = 1 - activeVideoSlot;
    const preloadVideo = nodes[preloadSlot];
    if (preloadVideo && preloadVideo.dataset.clipId !== String(preload.id)) {
      configureVideo(preloadVideo, preload, preloadSlot);
    }
  }

  const active = nodes[activeVideoSlot];
  if (active && activeVideoClipId === wanted.id) {
    active.muted = !soundEnabled;
    if (
      replayClipId == null &&
      active.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
    ) {
      const target = targetTimeFor(wanted);
      if (Math.abs(active.currentTime - target) > 1.1) {
        try {
          active.currentTime = target;
        } catch {}
      }
    }
  }
}

function handleDeckEnded(slot: number, clipId: number) {
  if (slot !== activeVideoSlot || clipId !== activeVideoClipId) return;

  if (replayClipId != null) {
    const published = publishedTimeline();
    const index = published.findIndex((clip) => clip.id === replayClipId);
    const following = index >= 0 ? published[index + 1] : null;
    const live = latestPublishedClip();
    if (following && following.id !== live?.id) {
      replayClipId = following.id;
    } else {
      replayClipId = null;
    }
    redraw();
    queueMicrotask(syncVideoDeck);
    return;
  }

  const current = timeline.find((clip) => clip.id === clipId) || null;
  const following = clipAfter(current);
  if (following && following.startsAtMs <= liveNowMs() + 250) {
    syncVideoDeck();
    return;
  }

  // No next Pump.fun episode is ready yet. Loop the latest episode without ever
  // clearing the current frame; the second deck remains free for preloading.
  const active = videoNodes()[slot];
  if (active) {
    try {
      active.currentTime = 0;
    } catch {}
    active.muted = !soundEnabled;
    void active.play().catch(() => {});
  }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  writePref("pumptv-sound", soundEnabled);
  redraw();
  queueMicrotask(syncVideoDeck);
}

function toggleCaptions() {
  captionsEnabled = !captionsEnabled;
  writePref("pumptv-captions", captionsEnabled);
  redraw();
}

function toggleNextCue() {
  nextCueEnabled = !nextCueEnabled;
  writePref("pumptv-next-cue", nextCueEnabled);
  redraw();
}

async function toggleFullscreen() {
  const target = document.querySelector(".tvShell") as HTMLElement | null;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (target?.requestFullscreen) await target.requestFullscreen();
  } catch {}
}

function jumpToEpisode(id: number) {
  const live = latestPublishedClip();
  replayClipId = live?.id === id ? null : id;
  redraw();
  queueMicrotask(syncVideoDeck);
}

function returnLive() {
  replayClipId = null;
  redraw();
  queueMicrotask(syncVideoDeck);
}

function shortAddress(value: string | null | undefined) {
  if (!value) return null;
  if (value.length <= 12) return value;
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

function clipAuthor(clip: Clip) {
  if (clip.directiveAuthor)
    return clip.directiveAuthor.startsWith("@")
      ? clip.directiveAuthor
      : `@${clip.directiveAuthor}`;
  return (
    shortAddress(clip.directiveAuthorAddress) ||
    (clip.directiveSource === "pumpfun" ? "pump.fun" : "pumptv")
  );
}

function directiveAuthor(directive: Directive | null) {
  if (!directive) return null;
  if (directive.author)
    return directive.author.startsWith("@")
      ? directive.author
      : `@${directive.author}`;
  return shortAddress(directive.authorAddress) || "pump.fun";
}

function nextPrompt() {
  const scheduled = nextScheduledClip();
  if (scheduled) {
    return {
      text: scheduled.directive,
      author: clipAuthor(scheduled),
      generating: false,
    };
  }
  if (nextDirective) {
    return {
      text: nextDirective.text,
      author: directiveAuthor(nextDirective),
      generating: nextDirective.status === "generating",
    };
  }
  return null;
}

function engineState() {
  if (!room) return "boot";
  if (!room.workerOnline) return "off";
  if (room.generation.paused) return "pause";
  if (room.workerState === "generating") return "work";
  return "ready";
}

function tooltipStatus() {
  if (!room) return "PumpTV is starting";
  if (!room.workerOnline) return "Generation worker offline";
  if (room.generation.paused)
    return room.generation.reason || "Generation paused";
  if (!room.pumpfun.enabled) return "Pump.fun chat is not configured";
  if (room.pumpfun.state !== "live")
    return `Pump.fun chat: ${room.pumpfun.state}`;
  if (room.workerState === "generating") return "Generating from Pump.fun chat";
  return "Waiting for the next Pump.fun prompt";
}

function ControlButton(props: {
  active?: boolean;
  title: string;
  glyph: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`hardwareToggle ${props.active ? "on" : ""}`}
      type="button"
      onClick={props.onClick}
      title={props.title}
      aria-label={props.title}
      aria-pressed={Boolean(props.active)}
    >
      {props.glyph}
    </button>
  );
}

function TactileTV({ clip }: { clip: Clip | null }) {
  const state = engineState();
  const isReplay = replayClipId != null;
  const prompt = nextPrompt();
  const poster = clipPoster(clip);

  return (
    <div className="tvShell">
      <div className="tvScrew screwA" />
      <div className="tvScrew screwB" />
      <div className="tvScrew screwC" />
      <div className="tvScrew screwD" />

      <div className="tvScreenFrame">
        <div className="tvGlass">
          {poster ? (
            <img className="tvPosterFallback" src={poster} alt="" />
          ) : null}
          <video
            className="tvVideoLayer"
            data-slot="0"
            preload="auto"
            playsInline
            aria-hidden="true"
          />
          <video
            className="tvVideoLayer"
            data-slot="1"
            preload="auto"
            playsInline
            aria-hidden="true"
          />

          {!clip ? (
            <div className="tvIdle" title={tooltipStatus()}>
              <div className={`idleOrb ${state}`}>
                <span>●</span>
              </div>
            </div>
          ) : null}

          <div className="glassGlow" />

          {clip && captionsEnabled ? (
            <div
              className="currentPrompt"
              title={`Episode ${clip.episode + 1} · ${clipAuthor(clip)}`}
            >
              <span className="promptText">{clip.directive}</span>
              <span className="promptAuthor">{clipAuthor(clip)}</span>
            </div>
          ) : null}

          {isReplay ? (
            <button
              className="liveReturn"
              type="button"
              onClick={returnLive}
              title="Return to live"
              aria-label="Return to live"
            >
              ●
            </button>
          ) : null}

          {nextCueEnabled && prompt ? (
            <div
              className={`nextChip ${prompt.generating ? "working" : ""}`}
              title="Next prompt from Pump.fun chat"
            >
              <span className="nextArrow">↗</span>
              <span className="nextText">{prompt.text}</span>
              <span className="nextAuthor">{prompt.author}</span>
            </div>
          ) : nextCueEnabled ? (
            <div
              className="nextEmpty"
              title="Waiting for the next Pump.fun prompt"
            >
              •••
            </div>
          ) : null}
        </div>
      </div>

      <div className="tvHardware">
        <button
          className={`powerLamp ${state}`}
          title={tooltipStatus()}
          aria-label={tooltipStatus()}
        />
        <button
          className={`knob ${soundEnabled ? "on" : ""}`}
          type="button"
          onClick={toggleSound}
          title={soundEnabled ? "Mute" : "Unmute"}
          aria-label={soundEnabled ? "Mute" : "Unmute"}
          aria-pressed={soundEnabled}
        >
          <span />
        </button>

        <div className="hardwareControls">
          <ControlButton
            active={captionsEnabled}
            title={
              captionsEnabled ? "Hide prompt caption" : "Show prompt caption"
            }
            glyph="▤"
            onClick={toggleCaptions}
          />
          <ControlButton
            active={nextCueEnabled}
            title={nextCueEnabled ? "Hide next prompt" : "Show next prompt"}
            glyph="↗"
            onClick={toggleNextCue}
          />
          <ControlButton
            title="Fullscreen"
            glyph="⛶"
            onClick={toggleFullscreen}
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

function EpisodeShelf() {
  const published = [...publishedTimeline()].reverse();
  const shown = visibleClip();
  const live = latestPublishedClip();

  return (
    <aside className="episodeShelf" aria-label="Episodes">
      <div className="brandStamp" title="PumpTV">
        <span>P</span>
      </div>
      <div className="viewerBadge" title="Watching now">
        <span>◉</span>
        <b>{room?.viewerCount ?? 0}</b>
      </div>
      <div className="episodeList">
        {published.map((clip) => {
          const active = shown?.id === clip.id;
          const isLive = live?.id === clip.id && replayClipId == null;
          const thumb = clip.startFrameUrl || clip.endFrameUrl;
          return (
            <button
              className={`episodeCard ${active ? "active" : ""} ${isLive ? "live" : ""}`}
              type="button"
              onClick={() => jumpToEpisode(clip.id)}
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

function App() {
  const clip = visibleClip();
  const state = engineState();

  return (
    <main className="viewerApp">
      <section className="watchDeck">
        <div className="minimalTop">
          <div className="wordmark">
            <span>P</span>
            <b>PUMPTV</b>
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
