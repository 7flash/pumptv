import { render } from "tradjs/client";
import type {
  Clip,
  Directive,
  RoomState,
  StreamState,
} from "../src/shared/contracts.ts";

let timeline: Clip[] = [];
let current: Clip | null = null;
let room: RoomState | null = null;
let directives: Directive[] = [];
let queuedCount = 0;
let serverOffsetMs = 0;
let input = "";
let error: string | null = null;
let soundEnabled = false;
let transport = "CONNECTING";
let source: EventSource | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;

function redraw() {
  const root = document.getElementById("slop-root");
  if (root) render(<App />, root);
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok)
    throw new Error(payload.error || `Request failed: ${response.status}`);
  return payload as T;
}

function liveNowMs() {
  return Date.now() + serverOffsetMs;
}

function activeClipAt(nowMs: number) {
  return (
    timeline.find(
      (clip) =>
        clip.startsAtMs <= nowMs &&
        nowMs < clip.startsAtMs + clip.durationSeconds * 1000,
    ) || null
  );
}

function syncVideoClock() {
  if (!current) return;
  const video = document.querySelector(
    "video.video",
  ) as HTMLVideoElement | null;
  if (!video) return;

  const expected = Math.max(0, (liveNowMs() - current.startsAtMs) / 1000);
  if (expected >= current.durationSeconds) return;
  if (
    Number.isFinite(video.duration) &&
    Math.abs(video.currentTime - expected) > 0.7
  ) {
    video.currentTime = Math.min(expected, Math.max(0, video.duration - 0.05));
  }
  video.muted = !soundEnabled;
  void video.play().catch(() => {});
}

function syncActiveClip(forceRedraw = false) {
  const next = activeClipAt(liveNowMs());
  const changed = next?.id !== current?.id;
  current = next;

  if (changed || forceRedraw) {
    redraw();
    queueMicrotask(syncVideoClock);
  } else {
    syncVideoClock();
  }
}

function applyState(state: StreamState) {
  serverOffsetMs = state.serverNowMs - Date.now();
  room = state.room;
  timeline = state.timeline;
  directives = state.recentDirectives;
  queuedCount = state.queuedCount;
  transport = "LIVE FEED";
  error = null;
  syncActiveClip(true);
}

async function boot() {
  try {
    applyState(await json<StreamState>("/api/state"));
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : "Could not load the stream.";
    transport = "OFFLINE";
    redraw();
  }

  source = new EventSource("/api/events");
  source.onopen = () => {
    transport = "LIVE FEED";
    redraw();
  };
  source.onmessage = (event) => {
    try {
      applyState(JSON.parse(event.data) as StreamState);
    } catch {
      error = "Received an invalid room update.";
      redraw();
    }
  };
  source.onerror = () => {
    transport = "RECONNECTING";
    redraw();
  };

  clockTimer = setInterval(() => syncActiveClip(false), 250);
}

async function submitDirective(event: SubmitEvent) {
  event.preventDefault();
  const text = input.trim().slice(0, 500);
  if (!text) return;
  input = "";
  redraw();

  try {
    await json<Directive>("/api/directives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : "Could not queue directive.";
    redraw();
  }
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  redraw();
  queueMicrotask(syncVideoClock);
}

function streamStatus() {
  if (!room) return transport;
  if (!room.running) return "PAUSED · generator stopped";
  if (room.workerState === "error") return "DEGRADED · retrying";
  if (current) return "LIVE";
  if (timeline.length) return "BUFFERING · generator catching up";
  return room.workerState === "generating"
    ? "GENERATING OPENING"
    : "WAITING FOR WORKER";
}

function bufferLabel() {
  if (!room?.bufferedUntilMs) return "0.0s BUFFER";
  const seconds = Math.max(0, room.bufferedUntilMs - liveNowMs()) / 1000;
  return `${seconds.toFixed(1)}s BUFFER`;
}

function directiveLabel(directive: Directive) {
  if (directive.status === "queued") return "QUEUED";
  if (directive.status === "generating") {
    return `GENERATING${directive.usedEpisode !== null ? ` · EP ${directive.usedEpisode + 1}` : ""}`;
  }
  return `USED${directive.usedEpisode !== null ? ` · EP ${directive.usedEpisode + 1}` : ""}`;
}

function App() {
  return (
    <>
      <section className="stage">
        {current ? (
          <video
            key={current.id}
            className="video"
            src={current.videoUrl}
            autoPlay
            muted={!soundEnabled}
            playsInline
            onLoadedMetadata={syncVideoClock}
            onEnded={() => syncActiveClip(true)}
          />
        ) : (
          <div className="void">
            <div className="spinner" />
            <p>{streamStatus()}</p>
          </div>
        )}

        <div className="grain" />
        <header className="topbar">
          <div className="brand">
            <span className="liveDot" />
            SLOP TV
          </div>
          <div className="meta">
            <span>{streamStatus()}</span>
            <span>EP {current ? current.episode + 1 : "—"}</span>
            <span>{room?.resolution || "—"}</span>
            <span>{bufferLabel()}</span>
            <button className="soundToggle" onClick={toggleSound}>
              {soundEnabled ? "SOUND ON" : "ENABLE SOUND"}
            </button>
          </div>
        </header>

        <div className="lowerThird">
          <p className="nowPlaying">
            {current?.directive || "The room worker is manufacturing reality…"}
          </p>
          {room?.lastError ? <p className="error">{room.lastError}</p> : null}
          {error ? <p className="error">{error}</p> : null}
        </div>
      </section>

      <aside className="chatPanel">
        <div className="chatHeader">
          <div>
            <h1>WRITE THE NEXT SCENE</h1>
            <p>
              Everyone watches one authoritative timeline. Your message enters
              its persistent FIFO future.
            </p>
          </div>
          <div className={`workerBadge ${room?.workerState || "idle"}`}>
            {room?.workerState || transport}
          </div>
        </div>

        <div className="messages">
          <div className="systemMessage">
            <span>SHARED ROOM</span>
            One server worker owns generation through a renewable SQLite lease.
            Viewers only watch and enqueue directives.
          </div>
          {directives.map((directive) => (
            <div className={`message ${directive.status}`} key={directive.id}>
              <span>{directiveLabel(directive)}</span>
              {directive.text}
            </div>
          ))}
        </div>

        <form className="composer" onSubmit={submitDirective as any}>
          <textarea
            value={input}
            onInput={(event: any) => {
              input = (event.currentTarget as HTMLTextAreaElement).value;
            }}
            placeholder="the raccoon realizes the VHS tape is predicting chat messages five seconds early…"
            maxLength={500}
            rows={3}
            onKeyDown={(event: any) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                (
                  event.currentTarget as HTMLTextAreaElement
                ).form?.requestSubmit();
              }
            }}
          />
          <div className="composerBottom">
            <div className="qualityReadout">
              {room?.resolution || "—"} · SERVER OWNED
            </div>
            <div className="queueCount">{queuedCount} queued</div>
            <button type="submit">SEND TO FUTURE ↗</button>
          </div>
        </form>

        <footer>
          <span>TradJS + sqlite-zod-orm + measure-fn</span>
          <span>{transport} · H3 Max on fal</span>
        </footer>
      </aside>
    </>
  );
}

export default function mount() {
  redraw();
  void boot();

  return () => {
    source?.close();
    source = null;
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
    const root = document.getElementById("slop-root");
    if (root) render(null, root);
  };
}
