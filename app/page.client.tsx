import { render } from "tradjs/client";
import type {
  Clip,
  Directive,
  PromptProposal,
  PromptRound,
  RoomState,
  StreamState,
} from "../src/shared/contracts.ts";

let timeline: Clip[] = [];
let current: Clip | null = null;
let room: RoomState | null = null;
let directives: Directive[] = [];
let arena: PromptRound | null = null;
let queuedCount = 0;
let serverOffsetMs = 0;
let input = "";
let error: string | null = null;
let soundEnabled = false;
let transport = "CONNECTING";
let source: EventSource | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let voterId = "";
const localVotes = new Map<number, number>();

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

function syncRoundClock() {
  const node = document.querySelector(
    "[data-round-countdown]",
  ) as HTMLElement | null;
  if (!node || !arena) return;
  if (arena.status !== "open") {
    node.textContent = "LOCKED";
    return;
  }
  const remaining = Math.max(0, arena.closesAtMs - liveNowMs());
  node.textContent =
    remaining > 0 ? `${(remaining / 1000).toFixed(1)}s` : "LOCKING…";
}

function syncActiveClip(forceRedraw = false) {
  const next = activeClipAt(liveNowMs());
  const changed = next?.id !== current?.id;
  current = next;

  if (changed || forceRedraw) {
    redraw();
    queueMicrotask(() => {
      syncVideoClock();
      syncRoundClock();
    });
  } else {
    syncVideoClock();
    syncRoundClock();
  }
}

function applyState(state: StreamState) {
  serverOffsetMs = state.serverNowMs - Date.now();
  room = state.room;
  timeline = state.timeline;
  directives = state.recentDirectives;
  arena = state.arena;
  queuedCount = state.queuedCount;
  transport = "LIVE FEED";
  error = null;
  syncActiveClip(true);
}

function ensureVoterId() {
  const key = "slopstream-voter-id";
  voterId = localStorage.getItem(key) || "";
  if (!voterId) {
    voterId = crypto.randomUUID();
    localStorage.setItem(key, voterId);
  }
}

async function boot() {
  ensureVoterId();
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

function findSubmittedProposal(round: PromptRound, text: string) {
  const normalized = text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return round.proposals.find(
    (proposal) =>
      proposal.text.replace(/\s+/g, " ").trim().toLocaleLowerCase() ===
      normalized,
  );
}

async function submitProposal(event: SubmitEvent) {
  event.preventDefault();
  const text = input.trim().slice(0, 500);
  if (!text || !voterId) return;
  input = "";
  redraw();

  try {
    const nextArena = await json<PromptRound>("/api/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voterId }),
    });
    arena = nextArena;
    const proposal = findSubmittedProposal(nextArena, text);
    if (proposal) localVotes.set(nextArena.id, proposal.id);
    redraw();
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : "Could not submit proposal.";
    redraw();
  }
}

async function voteProposal(proposalId: number) {
  if (!arena || arena.status !== "open" || !voterId) return;
  try {
    const nextArena = await json<PromptRound>("/api/votes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proposalId, voterId }),
    });
    arena = nextArena;
    localVotes.set(nextArena.id, proposalId);
    redraw();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Could not cast vote.";
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
  const source =
    directive.source === "pumpfun"
      ? `PUMP.FUN${directive.author ? ` · @${directive.author}` : ""}`
      : "WEB";

  if (directive.status === "queued") return `${source} · WINNER QUEUED`;
  if (directive.status === "generating") {
    return `${source} · WINNER GENERATING${directive.usedEpisode !== null ? ` · EP ${directive.usedEpisode + 1}` : ""}`;
  }
  return `${source} · WINNER USED${directive.usedEpisode !== null ? ` · EP ${directive.usedEpisode + 1}` : ""}`;
}

function pumpfunLabel() {
  if (!room?.pumpfun.enabled) return "PUMP.FUN OFF";
  const propose = room.pumpfun.prefix || "ALL CHAT";
  const vote = room.pumpfun.votePrefix || "VOTES OFF";
  return `PUMP.FUN ${room.pumpfun.state.toUpperCase()} · ${propose} · ${vote}`;
}

function proposalSource(proposal: PromptProposal) {
  if (proposal.source === "pumpfun") {
    return `PUMP${proposal.author ? ` · @${proposal.author}` : ""}`;
  }
  return "WEB";
}

function roundIsOpen() {
  return Boolean(
    arena && arena.status === "open" && liveNowMs() < arena.closesAtMs,
  );
}

function candidateClass(proposal: PromptProposal) {
  const selected = arena ? localVotes.get(arena.id) === proposal.id : false;
  return `candidate${selected ? " myVote" : ""}${proposal.status === "selected" ? " winner" : ""}`;
}

function App() {
  const open = roundIsOpen();
  const candidates = arena?.proposals.slice(0, 8) || [];

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

        {arena ? (
          <div className="voteOverlay">
            <span>NEXT SCENE · EP {arena.targetEpisode + 1}</span>
            <strong data-round-countdown>
              {arena.status === "open" ? "…" : "LOCKED"}
            </strong>
            <em>{arena.proposals.length} ideas</em>
          </div>
        ) : null}

        <div className="lowerThird">
          <p className="nowPlaying">
            {current?.directive || "The room worker is manufacturing reality…"}
          </p>
          {room?.lastError ? <p className="error">{room.lastError}</p> : null}
          {room?.pumpfun.lastError ? (
            <p className="error">Pump.fun: {room.pumpfun.lastError}</p>
          ) : null}
          {error ? <p className="error">{error}</p> : null}
        </div>
      </section>

      <aside className="chatPanel">
        <div className="chatHeader">
          <div>
            <h1>VOTE THE NEXT SCENE</h1>
            <p>
              Each ballot creates one canonical winner. Losing ideas expire
              instead of becoming backlog.
            </p>
          </div>
          <div className={`workerBadge ${room?.workerState || "idle"}`}>
            {room?.workerState || transport}
          </div>
        </div>

        <div className="messages">
          <div className="systemMessage">
            <span>SHARED BALLOT · {pumpfunLabel()}</span>
            Pump.fun: <b>!next idea</b> proposes and auto-votes; <b>!vote 42</b>{" "}
            moves your wallet's one vote. Exact duplicate ideas merge into one
            candidate.
          </div>

          <section className="arena">
            <div className="arenaHeader">
              <div>
                <span>
                  {arena
                    ? `BALLOT #${arena.id} · TARGET EP ${arena.targetEpisode + 1}`
                    : "BALLOT BOOTING"}
                </span>
                <strong>
                  {open
                    ? "VOTING OPEN"
                    : arena
                      ? "BALLOT LOCKED"
                      : "WAITING FOR OPENING"}
                </strong>
              </div>
              {arena ? (
                <b>
                  {arena.proposals.reduce(
                    (sum, item) => sum + item.voteCount,
                    0,
                  )}{" "}
                  votes
                </b>
              ) : null}
            </div>

            <div className="candidates">
              {candidates.length ? (
                candidates.map((proposal) => (
                  <button
                    type="button"
                    className={candidateClass(proposal)}
                    key={proposal.id}
                    disabled={!open || proposal.status !== "open"}
                    onClick={() => voteProposal(proposal.id)}
                  >
                    <span className="candidateMeta">
                      <b>#{proposal.id}</b>
                      <em>{proposalSource(proposal)}</em>
                      <strong>
                        {proposal.voteCount}{" "}
                        {proposal.voteCount === 1 ? "VOTE" : "VOTES"}
                      </strong>
                    </span>
                    <span className="candidateText">{proposal.text}</span>
                  </button>
                ))
              ) : (
                <div className="emptyBallot">
                  {open
                    ? "No proposals yet. First idea gets the board."
                    : "The next ballot opens after the opening clip is buffered."}
                </div>
              )}
            </div>
          </section>

          <div className="canonDivider">RECENT WINNERS</div>
          {directives.map((directive) => (
            <div className={`message ${directive.status}`} key={directive.id}>
              <span>
                {directiveLabel(directive)}
                {directive.proposalId ? ` · #${directive.proposalId}` : ""}
              </span>
              {directive.text}
            </div>
          ))}
        </div>

        <form className="composer" onSubmit={submitProposal as any}>
          <textarea
            value={input}
            disabled={!open}
            onInput={(event: any) => {
              input = (event.currentTarget as HTMLTextAreaElement).value;
            }}
            placeholder={
              open
                ? "the raccoon realizes the VHS tape is predicting chat messages five seconds early…"
                : "ballot locked — next round opens automatically…"
            }
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
              {room?.resolution || "—"} · ONE VOTE / VIEWER
            </div>
            <div className="queueCount">
              {queuedCount
                ? `${queuedCount} winner queued`
                : `${arena?.proposals.length || 0} candidates`}
            </div>
            <button type="submit" disabled={!open}>
              PROPOSE + VOTE ↗
            </button>
          </div>
        </form>

        <footer>
          <span>TradJS + sqlite-zod-orm + measure-fn</span>
          <span>
            {transport} · {pumpfunLabel()} · H3 Max on fal
          </span>
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
