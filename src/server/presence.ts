const VIEWER_TTL_MS = Math.max(
  15_000,
  Number(process.env.PUMPTV_VIEWER_TTL_MS || 45_000),
);

const viewers = new Map<string, number>();

function cleanKey(viewerId: string) {
  return viewerId.trim().slice(0, 160) || `anon:${crypto.randomUUID()}`;
}

function prune(now = Date.now()) {
  for (const [key, seenAtMs] of viewers) {
    if (now - seenAtMs > VIEWER_TTL_MS) viewers.delete(key);
  }
}

/** Long-poll presence: one browser id stays present while it keeps polling. */
export function touchViewer(viewerId: string) {
  const key = cleanKey(viewerId);
  viewers.set(key, Date.now());
  return key;
}

// Compatibility with the old SSE surface. New code uses touchViewer().
export function viewerJoined(viewerId: string) {
  return touchViewer(viewerId);
}

export function viewerLeft(viewerId: string) {
  viewers.delete(viewerId);
}

export function getViewerCount() {
  prune();
  return viewers.size;
}
