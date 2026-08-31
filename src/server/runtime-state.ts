import type { StreamState } from "../shared/contracts.ts";
import { getStreamState } from "./repository.ts";
import {
  ensureGenerationWorker,
  getManagedWorkerStatus,
} from "./worker-manager.ts";

export async function getRuntimeStreamState(): Promise<StreamState> {
  await ensureGenerationWorker();
  const state = await getStreamState();
  state.room.workerProcess = getManagedWorkerStatus();
  return state;
}
