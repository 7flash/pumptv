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
let nextClip: Clip | null = null;
let currentDirective: Directive | null = null;
let nextDirective: Directive | null = null;
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

function upcomingClipAt(nowMs: number) {
  return timeline.find((clip) => clip.startsAtMs > nowMs) || null;
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

function syncTemporalUi() {
  if (arena) {
    const roundNode = document.querySelector(
      "[data-round-countdown]",
    ) as HTMLElement | null;
    if (roundNode) {
      if (arena.status !== "open") {
        roundNode.textContent = "LOCKED";
      } else {
        const remaining = Math.max(0, arena.closesAtMs - liveNowMs());
        roundNode.textContent =
          remaining > 0 ? `${(remaining / 1000).toFixed(1)}s` : "LOCKING…";
      }
    }
  }

  const sceneProgress = document.querySelector(
    "[data-current-progress]",
  ) as HTMLProgressElement | null;
  if (sceneProgress && current) {
    sceneProgress.max = current.durationSeconds;
    sceneProgress.value = Math.min(
      current.durationSeconds,
      Math.max(0, (liveNowMs() - current.startsAtMs) / 1000),
    );
  }

  const nextNodes = document.querySelectorAll("[data-next-countdown]");
  if (nextNodes.length) {
    const upcoming = nextClip || upcomingClipAt(liveNowMs());
    let label = "VOTING NOW";
    if (upcoming) {
      const remaining = Math.max(0, upcoming.startsAtMs - liveNowMs());
      label =
        remaining > 0 ? `PLAYS IN ${(remaining / 1000).toFixed(1)}s` : "READY";
    } else if (nextDirective?.status === "generating") {
      label = "RENDERING NOW";
    } else if (nextDirective) {
      label = "LOCKED · WAITING FOR GPU";
    }
    nextNodes.forEach((node) => {
      node.textContent = label;
    });
  }
}

function syncActiveClip(forceRedraw = false) {
  const now = liveNowMs();
  const active = activeClipAt(now);
  const upcoming = upcomingClipAt(now);
  const changed = active?.id !== current?.id || upcoming?.id !== nextClip?.id;
  current = active;
  nextClip = upcoming;

  if (changed || forceRedraw) {
    redraw();
    queueMicrotask(() => {
      syncVideoClock();
      syncTemporalUi();
    });
  } else {
    syncVideoClock();
    syncTemporalUi();
  }
}

function applyState(state: StreamState) {
  serverOffsetMs = state.serverNowMs - Date.now();
  room = state.room;
  timeline = state.timeline;
  current = state.currentClip;
  nextClip = state.nextClip;
  currentDirective = state.currentDirective;
  nextDirective = state.nextDirective;
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

  clockTimer = setInterval(() => syncActiveClip(false), 200);
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
  if (!room.running) return "PAUSED";
  if (room.workerState === "error") return "DEGRADED";
  if (current) return "LIVE";
  if (timeline.length) return "BUFFERING";
  return room.workerState === "generating" ? "GENERATING" : "BOOTING";
}

function bufferLabel() {
  if (!room?.bufferedUntilMs) return "0.0s BUF";
  const seconds = Math.max(0, room.bufferedUntilMs - liveNowMs()) / 1000;
  return `${seconds.toFixed(1)}s BUF`;
}

function shortAddress(value: string | null) {
  if (!value) return null;
  if (value.length <= 12) return value;
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

function authorName(directive: Directive | null) {
  if (!directive) return "SLOP AI";
  if (directive.author)
    return directive.author.startsWith("@")
      ? directive.author
      : `@${directive.author}`;
  return (
    shortAddress(directive.authorAddress) ||
    (directive.source === "pumpfun" ? "PUMP ANON" : "WEB ANON")
  );
}

function sourceName(directive: Directive | null) {
  if (!directive) return "AUTOPILOT";
  return directive.source === "pumpfun" ? "PUMP.FUN CHAT" : "WEB CHAT";
}

function attribution(directive: Directive | null) {
  const votes =
    directive?.voteCount == null
      ? ""
      : ` · ${directive.voteCount} ${directive.voteCount === 1 ? "VOTE" : "VOTES"}`;
  const proposal = directive?.proposalId ? ` · #${directive.proposalId}` : "";
  return `${authorName(directive)} · ${sourceName(directive)}${proposal}${votes}`;
}

function directiveLabel(directive: Directive) {
  const state =
    directive.status === "queued"
      ? "LOCKED NEXT"
      : directive.status === "generating"
        ? "RENDERING"
        : "PLAYED";
  return `${state} · ${attribution(directive)}`;
}

function pumpfunLabel() {
  if (!room?.pumpfun.enabled) return "PUMP CHAT OFF";
  const propose = room.pumpfun.prefix || "ALL CHAT";
  const vote = room.pumpfun.votePrefix || "VOTES OFF";
  return `PUMP ${room.pumpfun.state.toUpperCase()} · ${propose} · ${vote}`;
}

function proposalSource(proposal: PromptProposal) {
  const who = proposal.author
    ? proposal.author.startsWith("@")
      ? proposal.author
      : `@${proposal.author}`
    : shortAddress(proposal.authorAddress) || "ANON";
  return proposal.source === "pumpfun" ? `PUMP · ${who}` : `WEB · ${who}`;
}

function roundIsOpen() {
  return Boolean(
    arena && arena.status === "open" && liveNowMs() < arena.closesAtMs,
  );
}

function candidateClass(proposal: PromptProposal, rank: number) {
  const selected = arena ? localVotes.get(arena.id) === proposal.id : false;
  return `candidate${selected ? " myVote" : ""}${proposal.status === "selected" ? " winner" : ""}${rank === 0 ? " leader" : ""}`;
}

function nextPromptText() {
  return (
    nextDirective?.text ||
    nextClip?.directive ||
    "Chat is still cooking the next mutation…"
  );
}

function currentPromptText() {
  return (
    current?.directive ||
    "The GPU cauldron is manufacturing the opening reality…"
  );
}

function App() {
  const open = roundIsOpen();
  const candidates = arena?.proposals || [];
  const totalVotes = candidates.reduce((sum, item) => sum + item.voteCount, 0);
  const currentDirectiveId = current?.directiveId ?? null;
  const nextDirectiveId = nextClip?.directiveId ?? null;
  const activeDirective = currentDirectiveId
    ? currentDirective?.id === currentDirectiveId
      ? currentDirective
      : directives.find((item) => item.id === currentDirectiveId) || null
    : null;
  const upcomingDirective = nextDirectiveId
    ? nextDirective?.id === nextDirectiveId
      ? nextDirective
      : directives.find((item) => item.id === nextDirectiveId) || nextDirective
    : nextDirective;
  const nextLocked = Boolean(upcomingDirective || nextClip);
  const currentByline = current?.directiveId
    ? attribution(activeDirective)
    : "SLOP AI · OPENING / AUTOPILOT";
  const nextByline = upcomingDirective
    ? attribution(upcomingDirective)
    : nextClip?.directiveId
      ? "LOCKED FROM CHAT"
      : "SLOP AI · AUTOPILOT";

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
            <div className="coinLoader">
              <span>$SLOP</span>
            </div>
            <strong>GENERATING REALITY</strong>
            <p>{streamStatus()} · do not refresh your brain</p>
          </div>
        )}

        <div className="videoWash" />
        <div className="grain" />
        <div className="scanlines" />

        <div className="tickerTape" aria-hidden="true">
          <div>
            <span>🟢 $SLOP PLOT CAP: ∞</span>
            <span>💬 CHAT IS THE DEV</span>
            <span>🧠 BRAINROT ENGINE: MAX</span>
            <span>🎥 5 SEC CANDLES ONLY</span>
            <span>🪙 NO ROADMAP · ONLY LORE</span>
            <span>🚀 NEXT PROMPT ALWAYS LOADING</span>
            <span>🟢 $SLOP PLOT CAP: ∞</span>
            <span>💬 CHAT IS THE DEV</span>
          </div>
        </div>

        <header className="topbar">
          <div className="brandLockup">
            <div className="coinMark">
              <span>S</span>
            </div>
            <div>
              <div className="brand">
                <span className="liveDot" />
                SLOP TV
              </div>
              <div className="brandSub">$SLOP · infinite story market</div>
            </div>
          </div>
          <div className="meta">
            <span className={`liveState ${streamStatus().toLowerCase()}`}>
              {streamStatus()}
            </span>
            <span>EP {current ? current.episode + 1 : "—"}</span>
            <span>{room?.resolution || "—"}</span>
            <span>{bufferLabel()}</span>
            <button className="soundToggle" onClick={toggleSound}>
              {soundEnabled ? "🔊 SOUND ON" : "🔇 UNMUTE"}
            </button>
          </div>
        </header>

        <div className="sceneHud">
          <article className="nowCard">
            <div className="cardEyebrow">
              <span className="statusChip liveChip">● NOW PLAYING</span>
              <span>EP {current ? current.episode + 1 : "—"}</span>
            </div>
            <h2>{currentPromptText()}</h2>
            <div className="promptAttribution">
              <span>SUGGESTED BY</span>
              <strong>{currentByline}</strong>
            </div>
            <progress
              className="sceneProgress"
              data-current-progress
              max={current?.durationSeconds || 5}
              value={
                current
                  ? Math.max(0, (liveNowMs() - current.startsAtMs) / 1000)
                  : 0
              }
            />
          </article>

          <article className={`nextCard ${nextLocked ? "locked" : "open"}`}>
            <div className="cardEyebrow">
              <span
                className={`statusChip ${nextLocked ? "nextChip" : "voteChip"}`}
              >
                {nextLocked ? "🔒 LOCKED NEXT" : "🗳️ NEXT PROMPT"}
              </span>
              <strong data-next-countdown>
                {nextLocked ? "READY" : "VOTING NOW"}
              </strong>
            </div>
            <p>
              {upcomingDirective?.text ||
                nextClip?.directive ||
                nextPromptText()}
            </p>
            <div className="nextMeta">{nextByline}</div>
          </article>
        </div>

        {room?.lastError ? (
          <p className="error stageError">{room.lastError}</p>
        ) : null}
        {room?.pumpfun.lastError ? (
          <p className="error stageError pumpError">
            Pump.fun: {room.pumpfun.lastError}
          </p>
        ) : null}
        {error ? <p className="error stageError clientError">{error}</p> : null}
      </section>

      <aside className="chatPanel">
        <div className="chatHeader">
          <div>
            <div className="panelKicker">LIVE PLOT TERMINAL</div>
            <h1>WHAT HAPPENS NEXT?</h1>
            <p>Drop brainrot. One identity = one vote. Winner becomes canon.</p>
          </div>
          <div className={`workerBadge ${room?.workerState || "idle"}`}>
            {room?.workerState || transport}
          </div>
        </div>

        <section
          className={`lockedNextPanel ${nextLocked ? "hasNext" : "waiting"}`}
        >
          <div className="lockedTopline">
            <span>
              {nextLocked ? "🔒 NEXT PROMPT LOCKED" : "🟢 NEXT PROMPT IS LIVE"}
            </span>
            <b data-next-countdown>{nextLocked ? "READY" : "VOTING NOW"}</b>
          </div>
          <strong>
            {upcomingDirective?.text || nextClip?.directive || nextPromptText()}
          </strong>
          <div className="lockedByline">{nextByline}</div>
        </section>

        <div className="messages">
          <section className="arena">
            <div className="arenaHeader">
              <div>
                <span>
                  {arena
                    ? `NEXT PROMPT QUEUE · ROUND #${arena.id}`
                    : "NEXT PROMPT QUEUE"}
                </span>
                <strong>
                  {open
                    ? "VOTING OPEN"
                    : arena
                      ? "QUEUE LOCKED"
                      : "BOOTING BALLOT"}
                </strong>
              </div>
              <div className="roundNumbers">
                <b data-round-countdown>
                  {arena?.status === "open" ? "…" : "LOCKED"}
                </b>
                <em>
                  {totalVotes} {totalVotes === 1 ? "VOTE" : "VOTES"}
                </em>
              </div>
            </div>

            <div className="queueLegend">
              <span>RANK</span>
              <span>PROMPT</span>
              <span>VOTES</span>
            </div>

            <div className="candidates">
              {candidates.length ? (
                candidates.map((proposal, rank) => (
                  <button
                    type="button"
                    className={candidateClass(proposal, rank)}
                    key={proposal.id}
                    disabled={!open || proposal.status !== "open"}
                    onClick={() => voteProposal(proposal.id)}
                  >
                    <span className="rankBadge">
                      {String(rank + 1).padStart(2, "0")}
                    </span>
                    <span className="candidateBody">
                      <span className="candidateMeta">
                        <em>
                          #{proposal.id} · {proposalSource(proposal)}
                        </em>
                        {rank === 0 && proposal.voteCount > 0 ? (
                          <i>LEADING</i>
                        ) : null}
                        {arena && localVotes.get(arena.id) === proposal.id ? (
                          <i>YOUR VOTE</i>
                        ) : null}
                      </span>
                      <span className="candidateText">{proposal.text}</span>
                      <progress
                        className="voteMeter"
                        value={proposal.voteCount}
                        max={Math.max(1, totalVotes)}
                      />
                    </span>
                    <span className="voteStack">
                      <strong>{proposal.voteCount}</strong>
                      <small>
                        {proposal.voteCount === 1 ? "VOTE" : "VOTES"}
                      </small>
                    </span>
                  </button>
                ))
              ) : (
                <div className="emptyBallot">
                  <b>QUEUE EMPTY</b>
                  {open
                    ? "Be first. Submit the next mutation below."
                    : "The next ballot opens as soon as playback has safe generation headroom."}
                </div>
              )}
            </div>
          </section>

          <details className="canonLog">
            <summary>
              RECENT CANON / WINNERS <span>{directives.length}</span>
            </summary>
            <div className="canonItems">
              {directives.map((directive) => (
                <div
                  className={`message ${directive.status}`}
                  key={directive.id}
                >
                  <span>{directiveLabel(directive)}</span>
                  {directive.text}
                </div>
              ))}
            </div>
          </details>

          <div className="systemMessage">
            <span>{pumpfunLabel()}</span>
            Pump.fun: <b>!next your idea</b> proposes + votes. <b>!vote 42</b>{" "}
            moves your vote. Duplicate ideas merge instead of clogging the lore.
          </div>
        </div>

        <form className="composer" onSubmit={submitProposal as any}>
          <div className="composerTitle">
            <span>CREATE NEXT PROMPT</span>
            <em>{open ? "LIVE" : "LOCKED"}</em>
          </div>
          <textarea
            value={input}
            disabled={!open}
            onInput={(event: any) => {
              input = (event.currentTarget as HTMLTextAreaElement).value;
            }}
            placeholder={
              open
                ? "make the raccoon ape into a cursed vending machine coin and the machine starts screaming tomorrow's chat…"
                : "round locked — the winner is becoming reality…"
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
              {room?.resolution || "—"} · 1 WALLET / 1 VOTE
            </div>
            <div className="queueCount">
              {queuedCount
                ? `${queuedCount} WINNER LOCKED`
                : `${candidates.length} IN QUEUE`}
            </div>
            <button type="submit" disabled={!open}>
              SEND IT ↗
            </button>
          </div>
        </form>

        <footer>
          <span>tradjs · jsx-ai · sqlite-zod-orm</span>
          <span>{transport} · H3 MAX</span>
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
