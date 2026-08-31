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
  enqueueExternalDirective,
  getRoomRow,
  setPumpChatState,
} from "./repository.ts";
import { pumpMeasure } from "./observability.ts";

const MINT = (process.env.SLOP_PUMPFUN_MINT || "").trim();
const PREFIX = process.env.SLOP_PUMPFUN_PREFIX ?? "!next";
const LEASE_TTL_MS = Number(process.env.SLOP_PUMPFUN_LEASE_TTL_MS || 30_000);
const POLL_MS = Number(process.env.SLOP_PUMPFUN_LEASE_POLL_MS || 1_000);
const MAX_TEXT = Number(process.env.SLOP_PUMPFUN_MAX_PROMPT_LENGTH || 500);
const USER_COOLDOWN_MS = Number(process.env.SLOP_PUMPFUN_USER_COOLDOWN_MS || 0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const owner = `pump:${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
const lastAcceptedByUser = new Map<string, number>();
let stopping = false;
let activeAbort: AbortController | null = null;

function extractPrompt(message: PumpfunMessage) {
  const line = sanitizeLine(
    String(message.message || ""),
    MAX_TEXT + PREFIX.length + 32,
  );
  if (!line) return null;

  if (!PREFIX) return sanitizeLine(line, MAX_TEXT);
  if (!line.toLowerCase().startsWith(PREFIX.toLowerCase())) return null;
  return sanitizeLine(line.slice(PREFIX.length).trim(), MAX_TEXT) || null;
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

function userKey(message: PumpfunMessage) {
  return String(message.userAddress || message.username || "anonymous");
}

async function ingestMessage(message: PumpfunMessage) {
  const prompt = extractPrompt(message);
  if (!prompt) return;

  if (USER_COOLDOWN_MS > 0) {
    const key = userKey(message);
    const now = Date.now();
    const previous = lastAcceptedByUser.get(key) || 0;
    if (now - previous < USER_COOLDOWN_MS) return;
    lastAcceptedByUser.set(key, now);
  }

  await pumpMeasure.measure(
    {
      label: "Ingest Pump.fun prompt",
      room: MINT,
      messageId: message.id || null,
    },
    () =>
      enqueueExternalDirective({
        text: prompt,
        source: "pumpfun",
        sourceId: durableSourceId(message),
        author: sanitizeLine(String(message.username || ""), 80) || null,
        authorAddress:
          sanitizeLine(String(message.userAddress || ""), 120) || null,
        sourceRoom: sanitizeLine(String(message.roomId || MINT), 160) || MINT,
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
          console.error("[pumpfun] ingest error", error);
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
    `[pumpfun] adapter ${owner} watching ${MINT}${PREFIX ? ` with prefix ${JSON.stringify(PREFIX)}` : " (all chat messages)"}`,
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
