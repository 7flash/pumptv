import { measuredRoute } from "../../../src/server/observability.ts";
import { longPollState } from "../../../src/server/state-long-poll.ts";

export function GET(request: Request) {
  return measuredRoute(request, async () => {
    const url = new URL(request.url);
    const viewerId = url.searchParams.get("viewerId") || "";
    const rawSince = Number(url.searchParams.get("since") || 0);
    const since =
      Number.isSafeInteger(rawSince) && rawSince >= 0 ? rawSince : 0;
    const result = await longPollState({
      viewerId,
      since,
      signal: request.signal,
    });
    return Response.json(result, {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "X-PumpTV-Transport": "long-poll",
      },
    });
  });
}
