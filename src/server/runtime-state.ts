import type { StreamState } from "../shared/contracts.ts";
import { getStreamState } from "./repository.ts";
import {
  ensureGenerationWorker,
  getManagedWorkerStatus,
} from "./worker-manager.ts";
import { dbPath } from "./db.ts";

let announcedDbPath = false;

export async function getRuntimeStreamState(): Promise<StreamState> {
  if (!announcedDbPath) {
    announcedDbPath = true;
    console.log(`[pumptv] web db=${dbPath}`);
  }
  await ensureGenerationWorker();
  const state = await getStreamState();
  state.room.workerProcess = getManagedWorkerStatus();
  return state;
}
