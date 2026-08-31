import { getRuntimeStreamState } from "../../../src/server/runtime-state.ts";

export async function GET() {
  const state = await getRuntimeStreamState();
  return Response.json({
    serverNowMs: state.serverNowMs,
    program: state.program,
    worker: {
      online: state.room.workerOnline,
      state: state.room.workerState,
      stage: state.room.generationStage,
      process: state.room.workerProcess,
    },
    pumpfun: state.room.pumpfun,
    latestEpisode: state.latestClip ? state.latestClip.episode + 1 : null,
    episodes: state.timeline.length,
    queuedCount: state.queuedCount,
    viewerCount: state.room.viewerCount,
  });
}
