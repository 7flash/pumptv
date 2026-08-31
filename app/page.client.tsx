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
let soundEnabled = false;
let replayClipId: number | null = null;
let source: EventSource | null = null;
let viewerId = "";
let transport: "connecting" | "live" | "reconnecting" = "connecting";
let error: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

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

function displayClip() {
  return replayClip() || latestPublishedClip();
}

function nextScheduledClip() {
  const now = liveNowMs();
  return timeline.find((clip) => clip.startsAtMs > now) || null;
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
  queueMicrotask(syncVideo);
}

function ensureViewerId() {
  const key = "pumptv-viewer-id";
  viewerId = localStorage.getItem(key) || "";
  if (!viewerId) {
    viewerId = crypto.randomUUID();
    localStorage.setItem(key, viewerId);
  }
}

async function boot() {
  ensureViewerId();
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
    redraw();
    queueMicrotask(syncVideo);
  }, 500);
}

function syncVideo() {
  const clip = displayClip();
  const video = document.querySelector(
    "video.tvVideo",
  ) as HTMLVideoElement | null;
  if (!clip || !video) return;

  video.muted = !soundEnabled;

  // Live follows the newest published clip. When no newer Pump.fun prompt exists,
  // keep the last episode looping instead of showing a dead screen.
  if (replayClipId == null) {
    const age = Math.max(0, (liveNowMs() - clip.startsAtMs) / 1000);
    if (age < clip.durationSeconds && Math.abs(video.currentTime - age) > 0.8) {
      video.currentTime = age;
    }
  }

  void video.play().catch(() => {});
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  redraw();
  queueMicrotask(syncVideo);
}

function jumpToEpisode(id: number) {
  const live = latestPublishedClip();
  replayClipId = live?.id === id ? null : id;
  redraw();
  queueMicrotask(syncVideo);
}

function returnLive() {
  replayClipId = null;
  redraw();
  queueMicrotask(syncVideo);
}

function handleEnded(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  if (replayClipId != null) {
    const published = publishedTimeline();
    const index = published.findIndex((clip) => clip.id === replayClipId);
    const following = index >= 0 ? published[index + 1] : null;
    const live = latestPublishedClip();
    if (following && following.id !== live?.id) {
      replayClipId = following.id;
      redraw();
      queueMicrotask(syncVideo);
      return;
    }
    replayClipId = null;
    redraw();
    queueMicrotask(syncVideo);
    return;
  }

  video.currentTime = 0;
  void video.play().catch(() => {});
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

function TactileTV({ clip }: { clip: Clip | null }) {
  const state = engineState();
  const isReplay = replayClipId != null;
  const prompt = nextPrompt();

  return (
    <div className="tvShell">
      <div className="tvScrew screwA" />
      <div className="tvScrew screwB" />
      <div className="tvScrew screwC" />
      <div className="tvScrew screwD" />

      <div className="tvScreenFrame">
        <div className="tvGlass">
          {clip ? (
            <video
              className="tvVideo"
              src={clip.videoUrl}
              autoplay
              playsInline
              muted={!soundEnabled}
              onEnded={handleEnded as any}
            />
          ) : (
            <div className="tvIdle" title={tooltipStatus()}>
              <div className={`idleOrb ${state}`}>
                <span>●</span>
              </div>
            </div>
          )}

          <div className="glassGlow" />

          {clip ? (
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
            >
              ●
            </button>
          ) : null}

          {prompt ? (
            <div
              className={`nextChip ${prompt.generating ? "working" : ""}`}
              title="Next prompt from Pump.fun chat"
            >
              <span className="nextArrow">↗</span>
              <span className="nextText">{prompt.text}</span>
              <span className="nextAuthor">{prompt.author}</span>
            </div>
          ) : (
            <div
              className="nextEmpty"
              title="Waiting for the next Pump.fun prompt"
            >
              •••
            </div>
          )}
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
        >
          <span />
        </button>
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
  const shown = displayClip();
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
  const clip = displayClip();
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
