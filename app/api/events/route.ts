import { streamState } from "../../../src/server/state-stream.ts";

export function GET(request: Request) {
  return new Response(streamState(request.signal), {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
