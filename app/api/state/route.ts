import {
  httpMeasure,
  measuredRoute,
} from "../../../src/server/observability.ts";
import { getRuntimeStreamState } from "../../../src/server/runtime-state.ts";

export function GET(request: Request) {
  return measuredRoute(request, async () => {
    const state = await httpMeasure.measure(
      {
        start: () => "Build stream state",
        end: (value) => ({
          phase: value.program.phase,
          episodes: value.timeline.length,
          proposals: value.program.votingRound?.proposals.length ?? 0,
          queued: value.queuedCount,
        }),
      },
      () => getRuntimeStreamState(),
    );
    return Response.json(state);
  });
}
