import { hostname } from "node:os";
import {
  castProposalVote,
  ensurePromptRound,
  submitPromptProposal,
} from "./arbitration.ts";
import { sanitizeLine } from "./prompt.ts";
import {
  acquirePumpChatLease,
  releasePumpChatLease,
  renewPumpChatLease,
  setPumpChatLeaseState,
} from "./pumpfun-lease.ts";
import { runPumpfunSocket, type PumpfunMessage } from "./pumpfun-socket.ts";
import { getLatestClip, getRoomRow, setPumpChatState } from "./repository.ts";
import { arbitrationMeasure, pumpMeasure } from "./observability.ts";

const MINT = (process.env.SLOP_PUMPFUN_MINT || "").trim();
const PREFIX = process.env.SLOP_PUMPFUN_PREFIX ?? "!next";
const VOTE_PREFIX = process.env.SLOP_PUMPFUN_VOTE_PREFIX ?? "!vote";
const LEASE_TTL_MS = Number(process.env.SLOP_PUMPFUN_LEASE_TTL_MS || 30_000);
const POLL_MS = Number(process.env.SLOP_PUMPFUN_LEASE_POLL_MS || 1_000);
const MAX_TEXT = Number(process.env.SLOP_PUMPFUN_MAX_PROMPT_LENGTH || 500);
const USER_COOLDOWN_MS = Number(process.env.SLOP_PUMPFUN_USER_COOLDOWN_MS || 0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const owner = `pump:${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
const lastAcceptedByUser = new Map<string, number>();
let stopping = false;
let activeAbort: AbortController | null = null;

type PumpCommand =
  { kind: "proposal"; text: string } | { kind: "vote"; proposalId: number };

function extractCommand(message: PumpfunMessage): PumpCommand | null {
  const line = sanitizeLine(
    String(message.message || ""),
    MAX_TEXT + PREFIX.length + 64,
  );
  if (!line) return null;

  if (VOTE_PREFIX && line.toLowerCase().startsWith(VOTE_PREFIX.toLowerCase())) {
    const rawId = line
      .slice(VOTE_PREFIX.length)
      .trim()
      .split(/\s+/, 1)[0]
      .replace(/^#/, "");
    const proposalId = Number.parseInt(rawId || "", 10);
    return Number.isSafeInteger(proposalId) && proposalId > 0
      ? { kind: "vote", proposalId }
      : null;
  }

  if (!PREFIX) return { kind: "proposal", text: sanitizeLine(line, MAX_TEXT) };
  if (!line.toLowerCase().startsWith(PREFIX.toLowerCase())) return null;

  const text = sanitizeLine(line.slice(PREFIX.length).trim(), MAX_TEXT);
  return text ? { kind: "proposal", text } : null;
}

function durableSourceId(message: PumpfunMessage) {
  if (message.id) return `${message.roomId || MINT}:${message.id}`;
  return [
    message.roomId || MINT,
    message.timestamp || "unknown-time",
    message.userAddress || message.username || "anonymous",
    message.message || "",
  ].join(":");
}

function userIdentity(message: PumpfunMessage) {
  return sanitizeLine(
    String(
      message.userAddress ||
        message.username ||
        `message:${durableSourceId(message)}`,
    ),
    180,
  );
}

function cooldownAllows(message: PumpfunMessage) {
  if (USER_COOLDOWN_MS <= 0) return true;
  const key = userIdentity(message);
  const now = Date.now();
  const previous = lastAcceptedByUser.get(key) || 0;
  if (now - previous < USER_COOLDOWN_MS) return false;
  lastAcceptedByUser.set(key, now);
  return true;
}

async function currentRound() {
  const latest = await getLatestClip();
  if (!latest) return null;
  const bufferUntilMs = latest.startsAtMs + latest.durationSeconds * 1000;
  return arbitrationMeasure.measure("Ensure Pump.fun scene ballot", () =>
    ensurePromptRound(latest.episode + 1, bufferUntilMs),
  );
}

async function ingestMessage(message: PumpfunMessage) {
  const command = extractCommand(message);
  if (!command || !cooldownAllows(message)) return;

  const round = await currentRound();
  if (!round || Date.now() >= round.closesAtMs) return;

  const sourceId = durableSourceId(message);
  const voterKey = `pumpfun:${userIdentity(message)}`;

  if (command.kind === "vote") {
    // IDs are shown in the stream overlay. A vote can only target the current
    // round, so stale chat commands cannot affect a future scene accidentally.
    await pumpMeasure.measure(
      {
        label: "Ingest Pump.fun vote",
        room: MINT,
        proposalId: command.proposalId,
      },
      () =>
        castProposalVote({
          roundId: round.id,
          proposalId: command.proposalId,
          voterKey,
          source: "pumpfun",
          sourceId,
        }),
    );
    return;
  }

  await pumpMeasure.measure(
    {
      label: "Ingest Pump.fun proposal",
      room: MINT,
      messageId: message.id || null,
    },
    () =>
      submitPromptProposal({
        roundId: round.id,
        text: command.text,
        source: "pumpfun",
        sourceId,
        author: sanitizeLine(String(message.username || ""), 80) || null,
        authorAddress:
          sanitizeLine(String(message.userAddress || ""), 120) || null,
        sourceRoom: sanitizeLine(String(message.roomId || MINT), 160) || MINT,
        voterKey,
      }),
  );
}

async function runLeasedSession() {
  if (!acquirePumpChatLease(owner, LEASE_TTL_MS)) return false;

  const abort = new AbortController();
  activeAbort = abort;
  const heartbeatMs = Math.max(1_000, Math.floor(LEASE_TTL_MS / 3));
  const heartbeat = setInterval(() => {
    if (!renewPumpChatLease(owner, LEASE_TTL_MS)) abort.abort();
  }, heartbeatMs);

  try {
    setPumpChatLeaseState(owner, "connecting", null);
    await runPumpfunSocket({
      mint: MINT,
      signal: abort.signal,
      onMessage(message) {
        void ingestMessage(message).catch((error) => {
          // Invalid/stale votes and closed ballot races are expected in live chat.
          console.warn(
            "[pumpfun] ignored chat command",
            error instanceof Error ? error.message : error,
          );
        });
      },
      onState(state, error) {
        if (state === "live") console.log(`[pumpfun] connected to ${MINT}`);
        setPumpChatLeaseState(owner, state, error || null);
      },
    });
    return true;
  } finally {
    clearInterval(heartbeat);
    if (activeAbort === abort) activeAbort = null;
    abort.abort();
    releasePumpChatLease(owner);
  }
}

export async function runPumpfunChatIngestor() {
  await getRoomRow();

  if (!MINT) {
    await setPumpChatState("disabled", null);
    console.log(
      "[pumpfun] disabled; set SLOP_PUMPFUN_MINT to ingest live chat",
    );
    return;
  }

  console.log(
    `[pumpfun] adapter ${owner} watching ${MINT} · proposals ${PREFIX ? JSON.stringify(PREFIX) : "ALL CHAT"} · votes ${JSON.stringify(VOTE_PREFIX)}`,
  );

  while (!stopping) {
    const owned = await pumpMeasure.measure("Pump.fun lease session", () =>
      runLeasedSession(),
    );
    if (!owned) await sleep(POLL_MS);
    else if (!stopping) await sleep(500);
  }

  releasePumpChatLease(owner);
}

export function stopPumpfunChatIngestor() {
  stopping = true;
  activeAbort?.abort();
  releasePumpChatLease(owner);
}
