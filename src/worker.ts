import {
  runPumpfunChatIngestor,
  stopPumpfunChatIngestor,
} from "./server/pumpfun.ts";
import { runRoomWorker, stopRoomWorker } from "./server/worker.ts";

function stop() {
  stopPumpfunChatIngestor();
  stopRoomWorker();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

await Promise.all([runRoomWorker(), runPumpfunChatIngestor()]);
