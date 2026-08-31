const viewers = new Map<string, number>();

export function viewerJoined(viewerId: string) {
  const key = viewerId.trim().slice(0, 160) || `anon:${crypto.randomUUID()}`;
  viewers.set(key, (viewers.get(key) || 0) + 1);
  return key;
}

export function viewerLeft(viewerId: string) {
  const count = viewers.get(viewerId) || 0;
  if (count <= 1) viewers.delete(viewerId);
  else viewers.set(viewerId, count - 1);
}

export function getViewerCount() {
  return viewers.size;
}
