import { hostname } from "node:os";
import { sanitizeLine } from "./prompt.ts";
import {
  acquirePumpChatLease,
  releasePumpChatLease,
  renewPumpChatLease,
  setPumpChatLeaseState,
} from "./pumpfun-lease.ts";
import { runPumpfunSocket, type PumpfunMessage } from "./pumpfun-socket.ts";
import {
  castPumpfunVoteByHandle,
  getRoomRow,
  submitPumpfunProposal,
  setPumpChatState,
} from "./repository.ts";
import { pumpMeasure } from "./observability.ts";

const MINT = (process.env.PUMPTV_PUMPFUN_MINT || "").trim();
const PREFIX = process.env.PUMPTV_PUMPFUN_PREFIX ?? "!next";
const VOTE_PREFIX = process.env.PUMPTV_PUMPFUN_VOTE_PREFIX ?? "!vote";
const LEASE_TTL_MS = Number(process.env.PUMPTV_PUMPFUN_LEASE_TTL_MS || 30_000);
const POLL_MS = Number(process.env.PUMPTV_PUMPFUN_LEASE_POLL_MS || 1_000);
const MAX_TEXT = Number(process.env.PUMPTV_PUMPFUN_MAX_PROMPT_LENGTH || 500);
const USER_COOLDOWN_MS = Number(
  process.env.PUMPTV_PUMPFUN_USER_COOLDOWN_MS || 0,
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const owner = `pump:${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
const lastAcceptedByUser = new Map<string, number>();
let stopping = false;
let activeAbort: AbortController | null = null;

function commandFromMessage(
  message: PumpfunMessage,
):
  { kind: "proposal"; text: string } | { kind: "vote"; handle: string } | null {
  const line = sanitizeLine(
    String(message.message || ""),
    MAX_TEXT + Math.max(PREFIX.length, VOTE_PREFIX.length) + 32,
  );
  if (!line) return null;

  if (VOTE_PREFIX && line.toLowerCase().startsWith(VOTE_PREFIX.toLowerCase())) {
    const handle = sanitizeLine(
      line.slice(VOTE_PREFIX.length).trim(),
      80,
    ).replace(/^@+/, "");
    return handle ? { kind: "vote", handle } : null;
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

async function ingestMessage(message: PumpfunMessage) {
  const command = commandFromMessage(message);
  if (!command || !cooldownAllows(message)) return;

  const sourceId = durableSourceId(message);
  const voterKey = userIdentity(message);
  const author = sanitizeLine(String(message.username || ""), 80) || null;
  const authorAddress =
    sanitizeLine(String(message.userAddress || ""), 120) || null;
  const sourceRoom = sanitizeLine(String(message.roomId || MINT), 160) || MINT;

  if (command.kind === "vote") {
    const round = await pumpMeasure.measure(
      {
        start: () => `Chat vote @${command.handle}`,
        end: (value) => ({ round: value?.id ?? null }),
      },
      () =>
        castPumpfunVoteByHandle({
          handle: command.handle,
          voterKey,
          voterHandle: author,
          sourceId,
        }),
    );
    if (round)
      pumpMeasure.measureSync("Chat vote accepted", () => ({
        handle: command.handle,
        voter: author || authorAddress || "anonymous",
        round: round.id,
      }));
    return;
  }

  const proposal = await pumpMeasure.measure(
    {
      start: () => `Chat proposal ${message.id || sourceId}`,
      end: (value) => (value ? { id: value.id, score: value.voteCount } : null),
    },
    () =>
      submitPumpfunProposal({
        text: command.text,
        sourceId,
        author,
        authorAddress,
        sourceRoom,
        voterKey,
        voterHandle: author,
      }),
  );
  if (proposal)
    pumpMeasure.measureSync("Chat proposal accepted", () => ({
      id: proposal.id,
      score: proposal.voteCount,
      text: proposal.text.slice(0, 120),
    }));
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
          pumpMeasure.measureSync("Chat prompt ignored", () => ({
            error: error instanceof Error ? error.message : String(error),
          }));
        });
      },
      onState(state, error) {
        if (state === "live")
          pumpMeasure.measureSync("Pump.fun connected", () => ({ mint: MINT }));
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
    // Pump.fun chat is optional. A disabled adapter is normal and should not
    // pollute the operator log or surface as a warning in the viewer UI.
    await setPumpChatState("disabled", null);
    return;
  }

  pumpMeasure.measureSync("Pump.fun adapter ready", () => ({
    owner,
    mint: MINT,
    proposalPrefix: PREFIX || null,
    votePrefix: VOTE_PREFIX || null,
  }));

  while (!stopping) {
    const owned = await pumpMeasure.measure(
      {
        start: () => "Chat lease session",
        end: (value) => ({ owned: Boolean(value) }),
      },
      () => runLeasedSession(),
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
