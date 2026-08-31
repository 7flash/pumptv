import { runRoomWorker, stopRoomWorker } from "./server/worker.ts";

process.once("SIGINT", () => stopRoomWorker());
process.once("SIGTERM", () => stopRoomWorker());

await runRoomWorker();
