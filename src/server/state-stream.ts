import { getStreamState } from "./repository.ts";

const encoder = new TextEncoder();
const subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let lastPayload = "";
let polling = false;

function write(
  controller: ReadableStreamDefaultController<Uint8Array>,
  payload: string,
) {
  controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
}

function broadcast(payload: string) {
  for (const controller of subscribers) {
    try {
      write(controller, payload);
    } catch {
      subscribers.delete(controller);
    }
  }
}

async function poll() {
  if (polling || subscribers.size === 0) return;
  polling = true;
  try {
    const state = await getStreamState();
    const payload = JSON.stringify(state);
    if (payload !== lastPayload) {
      lastPayload = payload;
      broadcast(payload);
    } else {
      // Keep proxies and browsers from considering an idle connection dead.
      const heartbeat = encoder.encode(`: heartbeat ${Date.now()}\n\n`);
      for (const controller of subscribers) {
        try {
          controller.enqueue(heartbeat);
        } catch {
          subscribers.delete(controller);
        }
      }
    }
  } finally {
    polling = false;
    if (subscribers.size > 0) timer = setTimeout(poll, 750);
  }
}

function remove(controller: ReadableStreamDefaultController<Uint8Array>) {
  subscribers.delete(controller);
  if (subscribers.size === 0 && timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export function streamState(signal: AbortSignal) {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      subscribers.add(controller);

      if (lastPayload) write(controller, lastPayload);
      if (!timer && !polling) void poll();

      signal.addEventListener(
        "abort",
        () => {
          remove(controller);
          try {
            controller.close();
          } catch {}
        },
        { once: true },
      );
    },
    cancel() {
      if (controllerRef) remove(controllerRef);
    },
  });
}
