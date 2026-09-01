import {
  httpMeasure,
  measuredRoute,
} from "../../../src/server/observability.ts";
import { getRuntimeStreamState } from "../../../src/server/runtime-state.ts";

export function GET(request: Request) {
  return measuredRoute(request, async () => {
    const state = await httpMeasure.measure("Build compact status", () =>
      getRuntimeStreamState(),
    );
    return Response.json({
      serverNowMs: state.serverNowMs,
      program: state.program,
      worker: {
        online: state.room.workerOnline,
        state: state.room.workerState,
        stage: state.room.generationStage,
        process: state.room.workerProcess,
      },
      latestEpisode: state.latestClip ? state.latestClip.episode + 1 : null,
      episodes: state.timeline.length,
      queuedCount: state.queuedCount,
      viewerCount: state.room.viewerCount,
      proposals: state.program.votingRound?.proposals.length ?? 0,
    });
  });
}
