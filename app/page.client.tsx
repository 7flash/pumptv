import { render } from "tradjs/client";
import type {
  Clip,
  Directive,
  Resolution,
  StreamState,
} from "../src/shared/contracts.ts";

let current: Clip | null = null;
let next: Clip | null = null;
let running = true;
let generating = false;
let waitingToAdvance = false;
let ended = false;
let status = "Booting the infinite slop machine…";
let input = "";
let resolution: Resolution = "768P";
let error: string | null = null;
let directives: Directive[] = [];
let queuedCount = 0;

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

async function captureLastFrame(videoUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    const cleanup = () => {
      video.pause();
      video.removeAttribute("src");
      video.load();
    };

    video.onerror = () => {
      cleanup();
      reject(new Error("Could not load the previous clip for continuity."));
    };
    video.onloadedmetadata = () => {
      video.currentTime = Math.max(0, video.duration - 0.08);
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 1344;
        canvas.height = video.videoHeight || 768;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas unavailable");
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = canvas.toDataURL("image/jpeg", 0.88);
        cleanup();
        resolve(frame);
      } catch (cause) {
        cleanup();
        reject(cause);
      }
    };
    video.src = videoUrl;
  });
}

async function refreshState() {
  const state = await json<StreamState>("/api/state");
  directives = state.recentDirectives;
  queuedCount = state.queuedCount;
  if (!current && state.latestClip) current = state.latestClip;
  redraw();
}

async function generate(anchor: string | null) {
  return json<Clip>("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageDataUrl: anchor, resolution }),
  });
}

async function queueNext(fromClip: Clip) {
  if (!running || generating || next) return;
  generating = true;
  error = null;
  status = "Generating the next five seconds…";
  redraw();

  try {
    const frame = await captureLastFrame(fromClip.videoUrl);
    next = await generate(frame);
    status = next.inferenceSeconds
      ? `Next clip buffered · ${next.inferenceSeconds.toFixed(2)}s inference`
      : "Next clip buffered";
    await refreshState();

    if (waitingToAdvance) advance();
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : "Could not generate the next clip.";
    status = "Generation stalled";
  } finally {
    generating = false;
    redraw();
    if (running && current && !next && !waitingToAdvance) {
      queueMicrotask(() => {
        if (current) void queueNext(current);
      });
    }
  }
}

async function boot() {
  try {
    const state = await json<StreamState>("/api/state");
    directives = state.recentDirectives;
    queuedCount = state.queuedCount;

    if (state.latestClip) {
      current = state.latestClip;
      status = "LIVE · restored timeline";
    } else {
      generating = true;
      status = "Generating opening shot…";
      redraw();
      current = await generate(null);
      generating = false;
      status = "LIVE · prebuffering next clip";
    }
    redraw();
    if (current) void queueNext(current);
  } catch (cause) {
    generating = false;
    error =
      cause instanceof Error ? cause.message : "Could not start the stream.";
    status = "Offline";
    redraw();
  }
}

function advance() {
  ended = true;
  if (!running) return;

  if (next) {
    const buffered = next;
    next = null;
    current = buffered;
    waitingToAdvance = false;
    ended = false;
    status = "LIVE · prebuffering next clip";
    redraw();
    void queueNext(buffered);
  } else {
    waitingToAdvance = true;
    status = "Buffering the timeline…";
    redraw();
  }
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
    await refreshState();
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : "Could not queue directive.";
    redraw();
  }
}

function toggleRunning() {
  running = !running;
  status = running
    ? "LIVE · resuming generation"
    : "PAUSED · no new clips will be generated";
  redraw();

  if (!running) return;
  if (ended && next) advance();
  else if (current && !next) void queueNext(current);
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
            playsInline
            crossOrigin="anonymous"
            onEnded={advance}
          />
        ) : (
          <div className="void">
            <div className="spinner" />
            <p>{status}</p>
          </div>
        )}

        <div className="grain" />
        <header className="topbar">
          <div className="brand">
            <span className="liveDot" />
            SLOP TV
          </div>
          <div className="meta">
            <span>{status}</span>
            <span>EP {current ? current.episode + 1 : "—"}</span>
            <span>{resolution}</span>
          </div>
        </header>

        <div className="lowerThird">
          <p className="nowPlaying">
            {current?.directive || "Generating reality…"}
          </p>
          {error ? <p className="error">{error}</p> : null}
        </div>
      </section>

      <aside className="chatPanel">
        <div className="chatHeader">
          <div>
            <h1>WRITE THE NEXT SCENE</h1>
            <p>
              Anything you type is persisted and consumed by the timeline in
              FIFO order.
            </p>
          </div>
          <button
            className={running ? "pause" : "resume"}
            onClick={toggleRunning}
          >
            {running ? "STOP BURN" : "GO LIVE"}
          </button>
        </div>

        <div className="messages">
          <div className="systemMessage">
            <span>STREAM</span>
            SQLite keeps the canon and viewer queue. The previous final frame
            becomes the next opening frame.
          </div>
          {directives.map((directive) => (
            <div className={`message ${directive.status}`} key={directive.id}>
              <span>
                {directive.status === "queued"
                  ? "QUEUED"
                  : `USED${directive.usedEpisode !== null ? ` · EP ${directive.usedEpisode + 1}` : ""}`}
              </span>
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
            placeholder="the raccoon opens the tape and it contains footage of this exact livestream…"
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
            <label>
              QUALITY
              <select
                value={resolution}
                onChange={(event: any) => {
                  resolution = (event.currentTarget as HTMLSelectElement)
                    .value as Resolution;
                  redraw();
                }}
              >
                <option value="480P">480P · cheaper</option>
                <option value="768P">768P · prettier</option>
              </select>
            </label>
            <div className="queueCount">{queuedCount} queued</div>
            <button type="submit">SEND TO FUTURE ↗</button>
          </div>
        </form>

        <footer>
          <span>TradJS + sqlite-zod-orm + measure-fn</span>
          <span>H3 Max on fal · safety checker on</span>
        </footer>
      </aside>
    </>
  );
}

export default function mount() {
  redraw();
  void boot();

  return () => {
    const root = document.getElementById("slop-root");
    if (root) render(null, root);
  };
}
