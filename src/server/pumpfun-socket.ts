import WebSocket, { type RawData } from "ws";

const CHAT_URL = "wss://livechat.pump.fun/socket.io/?EIO=4&transport=websocket";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

export type PumpfunMessage = {
  id?: string;
  roomId?: string;
  username?: string;
  userAddress?: string;
  message?: string;
  profile_image?: string;
  timestamp?: string;
  messageType?: string;
  expiresAt?: number;
};

type SocketState = "connecting" | "live" | "error";

function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function normalizeFrame(data: RawData) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

function parseEventFrame(frame: string): [string, unknown] | null {
  if (!frame.startsWith("42")) return null;
  try {
    const value = JSON.parse(frame.slice(2));
    if (!Array.isArray(value) || typeof value[0] !== "string") return null;
    return [value[0], value[1]];
  } catch {
    return null;
  }
}

async function connectOnce(input: {
  mint: string;
  signal: AbortSignal;
  onMessage: (message: PumpfunMessage) => void;
  onState: (state: SocketState, error?: string) => void;
}) {
  return new Promise<boolean>((resolve) => {
    let joined = false;
    let finished = false;

    const socket = new WebSocket(CHAT_URL, {
      origin: "https://pump.fun",
      headers: {
        "User-Agent": USER_AGENT,
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });

    function finish() {
      if (finished) return;
      finished = true;
      input.signal.removeEventListener("abort", abort);
      resolve(joined);
    }

    function abort() {
      try {
        socket.close(1000, "lease released");
      } catch {}
      finish();
    }

    input.signal.addEventListener("abort", abort, { once: true });

    socket.on("open", () => input.onState("connecting"));

    socket.on("message", (raw) => {
      const frame = normalizeFrame(raw);

      // Engine.IO open: acknowledge the Socket.IO namespace with no auth token.
      if (frame.startsWith("0")) {
        socket.send(
          `40${JSON.stringify({ origin: "https://pump.fun", timestamp: Date.now(), token: null })}`,
        );
        return;
      }

      // Socket.IO namespace connected: join the token/mint chat room. Ack id=0.
      if (frame.startsWith("40")) {
        socket.send(
          `420${JSON.stringify(["joinRoom", { roomId: input.mint, username: "pumptv-reader" }])}`,
        );
        return;
      }

      // Ack for joinRoom request (42 + ack id 0 -> 430).
      if (frame.startsWith("430")) {
        joined = true;
        input.onState("live");
        return;
      }

      // Engine.IO server ping. We do not initiate our own ping loop.
      if (frame === "2") {
        socket.send("3");
        return;
      }

      const event = parseEventFrame(frame);
      if (
        event?.[0] === "newMessage" &&
        event[1] &&
        typeof event[1] === "object"
      ) {
        input.onMessage(event[1] as PumpfunMessage);
      }
    });

    socket.on("error", (error) => {
      input.onState(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    });

    socket.on("close", finish);
  });
}

export async function runPumpfunSocket(input: {
  mint: string;
  signal: AbortSignal;
  onMessage: (message: PumpfunMessage) => void;
  onState: (state: SocketState, error?: string) => void;
}) {
  let reconnectAttempt = 0;

  while (!input.signal.aborted) {
    input.onState("connecting");
    let reachedLive = false;
    try {
      reachedLive = await connectOnce(input);
    } catch (error) {
      input.onState(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    }

    if (input.signal.aborted) break;
    reconnectAttempt = reachedLive ? 0 : reconnectAttempt + 1;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(5, reconnectAttempt));
    await abortableSleep(delay, input.signal);
  }
}
