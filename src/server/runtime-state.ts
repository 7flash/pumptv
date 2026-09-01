import type { StreamState } from "../shared/contracts.ts";
import { getStreamState } from "./repository.ts";
import {
  ensureGenerationWorker,
  getManagedWorkerStatus,
} from "./worker-manager.ts";
import { dbPath } from "./db.ts";
import { webMeasure } from "./observability.ts";

let announcedDbPath = false;

export async function getRuntimeStreamState(): Promise<StreamState> {
  if (!announcedDbPath) {
    announcedDbPath = true;
    webMeasure.measureSync("PumpTV web runtime", () => ({
      pid: process.pid,
      db: dbPath,
      room: process.env.PUMPTV_ROOM || "main",
    }));
  }
  await ensureGenerationWorker();
  const state = await getStreamState();
  state.room.workerProcess = getManagedWorkerStatus();
  // Managed-process startup can be known slightly before the DB heartbeat arrives.
  // Keep the program state honest rather than calling that transient window offline.
  if (
    state.program.phase === "offline" &&
    state.room.workerProcess.state === "starting"
  ) {
    state.program = { ...state.program, phase: "starting", reason: null };
  } else if (
    state.program.phase === "offline" &&
    state.room.workerProcess.state === "error"
  ) {
    state.program = {
      ...state.program,
      reason: state.room.workerProcess.error || state.program.reason,
    };
  }
  return state;
}
