import { render } from "tradjs/client";
import type {
  Clip,
  Directive,
  PromptProposal,
  PromptRound,
  RoomState,
  StreamState,
  WorldState,
  WorldStateAudit,
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
let worldState: WorldState | null = null;
let worldStateEpisode: number | null = null;
let worldStateAudit: WorldStateAudit | null = null;
let serverOffsetMs = 0;
let input = "";
let error: string | null = null;
let soundEnabled = false;
let replayClipId: number | null = null;
let transport = "CONNECTING";
let source: EventSource | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let voterId = "";
const localVotes = new Map<number, number>();

function redraw() {
  const root = document.getElementById("pumptv-root");
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

function publishedTimeline(nowMs = liveNowMs()) {
  return timeline.filter((clip) => clip.startsAtMs <= nowMs);
}

function replayClip() {
  return replayClipId == null
    ? null
    : timeline.find((clip) => clip.id === replayClipId) || null;
}

function displayClip() {
  const replay = replayClip();
  if (replay) return replay;
  if (current) return current;
  const published = publishedTimeline();
  return published.length ? published[published.length - 1] : null;
}

function isArchivePlayback() {
  return replayClipId != null || (!current && Boolean(displayClip()));
}

function syncVideoClock() {
  const clip = displayClip();
  if (!clip) return;
  const video = document.querySelector(
    "video.video",
  ) as HTMLVideoElement | null;
  if (!video) return;

  if (!isArchivePlayback()) {
    const expected = Math.max(0, (liveNowMs() - clip.startsAtMs) / 1000);
    if (
      expected < clip.durationSeconds &&
      Number.isFinite(video.duration) &&
      Math.abs(video.currentTime - expected) > 0.7
    ) {
      video.currentTime = Math.min(
        expected,
        Math.max(0, video.duration - 0.05),
      );
    }
  }

  video.muted = !soundEnabled;
  void video.play().catch(() => {});
}

function syncEpisodeRail() {
  const active = document.querySelector(
    ".episodeTick.active",
  ) as HTMLElement | null;
  active?.scrollIntoView({
    behavior: "auto",
    block: "nearest",
    inline: "center",
  });
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
  const shown = displayClip();
  if (sceneProgress && shown) {
    sceneProgress.max = shown.durationSeconds;
    const video = document.querySelector(
      "video.video",
    ) as HTMLVideoElement | null;
    sceneProgress.value =
      isArchivePlayback() && video
        ? Math.min(shown.durationSeconds, Math.max(0, video.currentTime))
        : Math.min(
            shown.durationSeconds,
            Math.max(0, (liveNowMs() - shown.startsAtMs) / 1000),
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
      syncEpisodeRail();
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
  if (
    replayClipId != null &&
    !timeline.some((clip) => clip.id === replayClipId)
  )
    replayClipId = null;
  current = state.currentClip;
  nextClip = state.nextClip;
  currentDirective = state.currentDirective;
  nextDirective = state.nextDirective;
  directives = state.recentDirectives;
  arena = state.arena;
  worldState = state.worldState;
  worldStateEpisode = state.worldStateEpisode;
  worldStateAudit = state.worldStateAudit;
  queuedCount = state.queuedCount;
  transport = "LIVE FEED";
  error = null;
  syncActiveClip(true);
}

function ensureVoterId() {
  const key = "pumptv-voter-id";
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

  source = new EventSource(
    `/api/events?viewerId=${encodeURIComponent(voterId)}`,
  );
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

function jumpToEpisode(clipId: number) {
  replayClipId = current?.id === clipId ? null : clipId;
  redraw();
  queueMicrotask(() => {
    syncVideoClock();
    syncEpisodeRail();
  });
}

function returnToLive() {
  replayClipId = null;
  redraw();
  queueMicrotask(() => {
    syncVideoClock();
    syncEpisodeRail();
  });
}

function handleVideoEnded(event: Event) {
  const shown = displayClip();
  if (!shown) return syncActiveClip(true);

  if (replayClipId != null) {
    const published = publishedTimeline();
    const index = published.findIndex((clip) => clip.id === shown.id);
    const following = index >= 0 ? published[index + 1] : null;
    if (following && following.id !== current?.id) {
      replayClipId = following.id;
      redraw();
      queueMicrotask(() => {
        syncVideoClock();
        syncEpisodeRail();
      });
      return;
    }
    if (current) {
      returnToLive();
      return;
    }
  }

  if (!current) {
    const video = event.currentTarget as HTMLVideoElement | null;
    if (video) {
      video.currentTime = 0;
      void video.play().catch(() => {});
    }
    return;
  }

  syncActiveClip(true);
}

function streamStatus() {
  if (replayClipId != null) return "REWATCH";
  if (!room) return transport;
  if (!room.running) return "PAUSED";
  if (room.generation.kind === "funds")
    return current ? "LIVE · FUNDS LOW" : "ARCHIVE MODE";
  if (room.generation.paused && !current) return "ARCHIVE MODE";
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

function bufferModeLabel() {
  if (!room) return "BUFFER SYNC";
  if (room.buffer.mode === "full") return "🟢 FULL BRAIN";
  if (room.buffer.mode === "fast") return "🟡 FAST RECOVERY";
  return "🔴 EMERGENCY MODE";
}

function bufferHealthLabel() {
  if (!room) return "SYNCING";
  const clips = room.buffer.bufferMs / 5000;
  return `${clips.toFixed(1)} CLIPS BANKED / ${room.buffer.desiredClipsAhead} TARGET`;
}

function latencyLabel() {
  if (!room) return "NO LATENCY DATA";
  const p90 = room.buffer.p90TotalMs;
  const h3 = room.buffer.p50H3Ms;
  if (p90 == null) return "LEARNING GPU SPEED";
  const parts = [`P90 ${(p90 / 1000).toFixed(1)}s`];
  if (h3 != null) parts.push(`H3 ${(h3 / 1000).toFixed(1)}s`);
  parts.push(`LEAD ${(room.buffer.adaptiveLeadMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}

function shortAddress(value: string | null) {
  if (!value) return null;
  if (value.length <= 12) return value;
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

function authorName(directive: Directive | null) {
  if (!directive) return "PUMPTV AI";
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
  return displayClip()?.directive || "Opening scene is rendering…";
}

function clipAttribution(clip: Clip | null) {
  if (!clip || !clip.directiveId) return "PUMPTV AI · OPENING / AUTOPILOT";
  const author = clip.directiveAuthor
    ? clip.directiveAuthor.startsWith("@")
      ? clip.directiveAuthor
      : `@${clip.directiveAuthor}`
    : shortAddress(clip.directiveAuthorAddress) ||
      (clip.directiveSource === "pumpfun" ? "PUMP ANON" : "WEB ANON");
  const source =
    clip.directiveSource === "pumpfun" ? "PUMP.FUN CHAT" : "WEB CHAT";
  const proposal = clip.directiveProposalId
    ? ` · #${clip.directiveProposalId}`
    : "";
  const votes =
    clip.directiveVoteCount == null
      ? ""
      : ` · ${clip.directiveVoteCount} ${clip.directiveVoteCount === 1 ? "VOTE" : "VOTES"}`;
  return `${author} · ${source}${proposal}${votes}`;
}

function generationPauseLabel() {
  if (!room?.generation.paused) return null;
  if (room.generation.kind === "config") return "⚙ CONFIG REQUIRED";
  if (room.generation.kind === "funds")
    return "💸 GENERATION PAUSED · TOP UP WHEN READY";
  if (room.generation.kind === "cooldown") return "⏳ NEXT DROP DELAYED";
  if (room.generation.kind === "rate_limit") return "🚦 PROVIDER COOLDOWN";
  return "🛟 GENERATION RECOVERY";
}

function generationRetryLabel() {
  if (room?.generation.kind === "config") return "RESTART AFTER CONFIG CHANGE";
  const retryAt = room?.generation.retryAtMs;
  if (!retryAt) return "AUTO RETRY";
  const seconds = Math.max(0, retryAt - liveNowMs()) / 1000;
  return seconds > 0
    ? `RETRY IN ${seconds.toFixed(seconds < 10 ? 1 : 0)}s`
    : "RETRYING…";
}

function canonEntityCount() {
  if (!worldState) return 0;
  return worldState.characters.length + worldState.props.length;
}

function canonCharacterLabel(character: WorldState["characters"][number]) {
  const detail = [character.status, character.position]
    .filter(Boolean)
    .join(" · ");
  return `${character.name}${detail ? ` — ${detail}` : ""}`;
}

function canonPropLabel(prop: WorldState["props"][number]) {
  const detail = [prop.status, prop.position].filter(Boolean).join(" · ");
  return `${prop.name}${detail ? ` — ${detail}` : ""}`;
}

function realityCheckLabel() {
  if (!worldStateAudit) return "VISION PENDING";
  if (worldStateAudit.status === "verified") return "👁 VISION VERIFIED";
  if (worldStateAudit.status === "corrected")
    return `👁 CANON PATCHED · ${worldStateAudit.drift.length} DRIFT`;
  if (worldStateAudit.status === "skipped") return "👁 VISION OFF";
  return "👁 VISION FALLBACK";
}

function App() {
  const open = roundIsOpen();
  const candidates = arena?.proposals || [];
  const totalVotes = candidates.reduce((sum, item) => sum + item.voteCount, 0);
  const shown = displayClip();
  const replaying = isArchivePlayback();
  const published = publishedTimeline();
  const currentDirectiveId = shown?.directiveId ?? null;
  const nextDirectiveId = nextClip?.directiveId ?? null;
  const activeDirective = currentDirectiveId
    ? shown?.id === current?.id && currentDirective?.id === currentDirectiveId
      ? currentDirective
      : directives.find((item) => item.id === currentDirectiveId) || null
    : null;
  const upcomingDirective = nextDirectiveId
    ? nextDirective?.id === nextDirectiveId
      ? nextDirective
      : directives.find((item) => item.id === nextDirectiveId) || nextDirective
    : nextDirective;
  const nextLocked = Boolean(upcomingDirective || nextClip);
  const currentByline = shown?.directiveId
    ? activeDirective
      ? attribution(activeDirective)
      : clipAttribution(shown)
    : "PUMPTV AI · OPENING";
  const nextByline = upcomingDirective
    ? attribution(upcomingDirective)
    : nextClip?.directiveId
      ? "LOCKED FROM CHAT"
      : "PUMPTV AI · AUTOPILOT";
  const workerProcess = room?.workerProcess;
  const workerStarting = Boolean(
    room &&
    !room.workerOnline &&
    (workerProcess?.state === "starting" || workerProcess?.state === "running"),
  );
  const workerOffline = Boolean(room && !room.workerOnline && !workerStarting);
  const configRequired = room?.generation.kind === "config";
  const status = configRequired
    ? "SETUP REQUIRED"
    : workerStarting
      ? "STARTING ENGINE"
      : workerOffline
        ? published.length
          ? "ARCHIVE"
          : "ENGINE OFFLINE"
        : streamStatus();

  return (
    <>
      <section className="stage">
        {shown ? (
          <video
            key={shown.id}
            className="video"
            src={shown.videoUrl}
            autoPlay
            muted={!soundEnabled}
            playsInline
            onLoadedMetadata={syncVideoClock}
            onEnded={handleVideoEnded as any}
          />
        ) : (
          <div className={`void${workerOffline ? " offline" : ""}`}>
            <div className="pumpOrb">
              <span>▶</span>
            </div>
            <strong>
              {configRequired
                ? "FAL KEY REQUIRED"
                : workerStarting
                  ? "STARTING GENERATION ENGINE"
                  : workerOffline
                    ? "GENERATION ENGINE OFFLINE"
                    : room?.generation.paused
                      ? "GENERATION PAUSED"
                      : "MAKING EPISODE 1"}
            </strong>
            <p>
              {configRequired
                ? "Set [fal].key in the repo-root .config.toml, then restart the managed PumpTV process so the worker is refreshed with the new config."
                : workerStarting
                  ? "PumpTV is starting the generation worker through bgrun. This normally takes a moment."
                  : workerOffline
                    ? workerProcess?.error ||
                      "PumpTV could not start the managed generation worker. Check the pumptv-worker bgrun logs."
                    : room?.generation.paused
                      ? room.generation.reason ||
                        "Existing episodes stay available while generation waits."
                      : "The first five seconds are rendering. Voting opens while the next scene is prepared."}
            </p>
          </div>
        )}

        <div className="videoShade" />

        <header className="topbar">
          <div className="brandLockup">
            <div className="coinMark">P</div>
            <div>
              <div className="brand">
                PUMP<span>TV</span>
              </div>
              <div className="brandSub">infinite live story</div>
            </div>
          </div>
          <div className="meta">
            <span className={`liveState ${workerOffline ? "offline" : ""}`}>
              <i />
              {status}
            </span>
            <span>EP {shown ? shown.episode + 1 : "—"}</span>
            <span className="viewerCount">
              {room?.viewerCount ?? 0} watching
            </span>
            <button className="soundToggle" onClick={toggleSound}>
              {soundEnabled ? "Sound on" : "Unmute"}
            </button>
          </div>
        </header>

        {room?.generation.paused ? (
          <div
            className={`generationPause ${room.generation.kind || "provider"}`}
          >
            <strong>{generationPauseLabel()}</strong>
            <span>{generationRetryLabel()}</span>
            <p>
              {room.generation.reason ||
                "Replays stay online while generation waits."}
            </p>
          </div>
        ) : workerStarting ? (
          <div className="generationPause starting">
            <strong>STARTING ENGINE</strong>
            <span>
              BGRUN ·{" "}
              {workerProcess?.pid ? `PID ${workerProcess.pid}` : "SPAWNING"}
            </span>
            <p>
              The web process is ensuring <code>pumptv-worker</code> through the
              bgrun SDK.
            </p>
          </div>
        ) : workerOffline ? (
          <div className="generationPause offline">
            <strong>ENGINE OFFLINE</strong>
            <span>BGRUN WORKER FAILED</span>
            <p>
              {workerProcess?.error ||
                "Check `bunx bgrun pumptv-worker --logs` for the worker startup error."}
            </p>
          </div>
        ) : null}

        {shown ? (
          <article className="nowOverlay">
            <div className="nowTopline">
              <span className={replaying ? "replayPill" : "livePill"}>
                {replaying ? "REWATCH" : "NOW"}
              </span>
              <span>EP {shown.episode + 1}</span>
              {replaying ? (
                <button
                  type="button"
                  onClick={returnToLive}
                  disabled={!current}
                >
                  Return to live
                </button>
              ) : null}
            </div>
            <h1>{currentPromptText()}</h1>
            <div className="promptAttribution">{currentByline}</div>
            <progress
              className="sceneProgress"
              data-current-progress
              max={shown.durationSeconds || 5}
              value={
                !replaying
                  ? Math.max(0, (liveNowMs() - shown.startsAtMs) / 1000)
                  : 0
              }
            />
          </article>
        ) : null}

        <nav className="episodeRail" aria-label="Episode replay timeline">
          <div className="episodeRailHead">
            <span>EPISODES</span>
            <b>
              {replayClipId != null
                ? `Rewatching EP ${(shown?.episode ?? 0) + 1}`
                : current
                  ? "Live edge"
                  : published.length
                    ? "Archive"
                    : "Waiting for first episode"}
            </b>
            <em>{published.length ? `${published.length} available` : ""}</em>
          </div>
          <div className="episodeTrack">
            {published.length ? (
              published.map((clip) => {
                const active = shown?.id === clip.id;
                const live = current?.id === clip.id && replayClipId == null;
                return (
                  <button
                    type="button"
                    key={clip.id}
                    className={`episodeTick${active ? " active" : ""}${live ? " live" : ""}`}
                    onClick={() => jumpToEpisode(clip.id)}
                    title={`EP ${clip.episode + 1}: ${clip.directive}`}
                  >
                    <i />
                    <span>{clip.episode + 1}</span>
                  </button>
                );
              })
            ) : (
              <div className="episodeEmpty">
                Episode history will appear here.
              </div>
            )}
          </div>
        </nav>

        {room?.lastError && !configRequired ? (
          <p className="error stageError">{room.lastError}</p>
        ) : null}
        {error ? <p className="error stageError clientError">{error}</p> : null}
      </section>

      <aside className="chatPanel">
        <header className="chatHeader">
          <div>
            <div className="panelKicker">NEXT SCENE</div>
            <h2>What happens next?</h2>
          </div>
          <div className="roundClock" data-round-countdown>
            {arena?.status === "open" ? "…" : "—"}
          </div>
        </header>

        <section
          className={`lockedNextPanel ${nextLocked ? "hasNext" : "waiting"}`}
        >
          <div className="lockedTopline">
            <span>
              {nextLocked ? "LOCKED NEXT" : open ? "VOTING NOW" : "WAITING"}
            </span>
            <b data-next-countdown>{nextLocked ? "READY" : "VOTING NOW"}</b>
          </div>
          <strong>
            {upcomingDirective?.text || nextClip?.directive || nextPromptText()}
          </strong>
          <div className="lockedByline">{nextByline}</div>
        </section>

        <section className="queueSection">
          <div className="queueHeader">
            <div>
              <span>VOTE QUEUE</span>
              <strong>{arena ? `EP ${arena.targetEpisode + 1}` : "—"}</strong>
            </div>
            <em>
              {totalVotes} {totalVotes === 1 ? "vote" : "votes"}
            </em>
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
                  <span className="rankBadge">{rank + 1}</span>
                  <span className="candidateBody">
                    <span className="candidateText">{proposal.text}</span>
                    <span className="candidateMeta">
                      #{proposal.id} · {proposalSource(proposal)}
                    </span>
                    <span className="voteBar">
                      <i
                        style={{
                          width: `${totalVotes ? Math.max(5, (proposal.voteCount / totalVotes) * 100) : 0}%`,
                        }}
                      />
                    </span>
                  </span>
                  <span className="voteStack">
                    <strong>{proposal.voteCount}</strong>
                    <small>
                      {arena && localVotes.get(arena.id) === proposal.id
                        ? "YOURS"
                        : rank === 0 && proposal.voteCount
                          ? "LEAD"
                          : "VOTES"}
                    </small>
                  </span>
                </button>
              ))
            ) : (
              <div className="emptyBallot">
                <b>
                  {configRequired
                    ? "SETUP REQUIRED"
                    : workerStarting
                      ? "ENGINE STARTING"
                      : workerOffline
                        ? "ENGINE OFFLINE"
                        : open
                          ? "BE FIRST"
                          : "QUEUE OPENS SOON"}
                </b>
                <span>
                  {configRequired
                    ? "Add your fal key to .config.toml. The worker is online; video generation is intentionally paused until credentials exist."
                    : workerStarting
                      ? "The managed generation worker is starting through bgrun."
                      : workerOffline
                        ? workerProcess?.error ||
                          "The managed generation worker failed to start. Check its bgrun logs."
                        : open
                          ? "Drop the next scene below. Your submission also casts your vote."
                          : "PumpTV opens voting as soon as the generation buffer is safe."}
                </span>
              </div>
            )}
          </div>
        </section>

        <details className="canonMini">
          <summary>
            <span>Canon brain</span>
            <b>
              {worldState
                ? `${worldState.characters.length} cast · ${worldState.openThreads.length} threads`
                : "booting"}
            </b>
          </summary>
          {worldState ? (
            <div className="canonMiniBody">
              <strong>{worldState.location || "Unknown location"}</strong>
              <p>{worldState.lastEndingBeat || worldState.locationDetails}</p>
              <div>{realityCheckLabel()}</div>
            </div>
          ) : (
            <div className="canonMiniBody">
              <p>Canon starts after episode 1.</p>
            </div>
          )}
        </details>

        <form className="composer" onSubmit={submitProposal as any}>
          <textarea
            value={input}
            disabled={!open}
            onInput={(event: any) => {
              input = (event.currentTarget as HTMLTextAreaElement).value;
            }}
            placeholder={
              open
                ? "make the next scene unreasonably specific…"
                : configRequired
                  ? "add [fal].key to .config.toml first…"
                  : workerStarting
                    ? "generation engine is starting…"
                    : workerOffline
                      ? "generation engine is offline"
                      : "waiting for the next vote round…"
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
            <span>
              {room?.pumpfun.enabled
                ? pumpfunLabel()
                : "WEB + PUMP.FUN PROMPTS"}
            </span>
            <button type="submit" disabled={!open}>
              Suggest + vote
            </button>
          </div>
        </form>

        <footer>
          <span>
            {room?.buffer.mode.toUpperCase() || "FULL"} · {bufferLabel()}
          </span>
          <span>{room?.viewerCount ?? 0} watching</span>
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
    const root = document.getElementById("pumptv-root");
    if (root) render(null, root);
  };
}
