import {
  runPumpfunChatIngestor,
  stopPumpfunChatIngestor,
} from "./server/pumpfun.ts";
import { runRoomWorker, stopRoomWorker } from "./server/worker.ts";

function numericArg(name: string): number | null {
  const prefix = `--${name}=`;
  const raw = process.argv
    .find((arg) => arg.startsWith(prefix))
    ?.slice(prefix.length);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

const ownerPid = numericArg("owner-pid");
let stopping = false;
let ownerWatchdog: ReturnType<typeof setInterval> | null = null;

function pidIsAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM means the process exists but this process is not allowed to signal it.
    return error?.code === "EPERM";
  }
}

function stop(reason = "signal") {
  if (stopping) return;
  stopping = true;
  if (ownerWatchdog) {
    clearInterval(ownerWatchdog);
    ownerWatchdog = null;
  }
  console.log(`[worker] stopping · ${reason}`);
  stopPumpfunChatIngestor();
  stopRoomWorker();
}

if (ownerPid) {
  console.log(`[worker] owned by web pid ${ownerPid}`);
  ownerWatchdog = setInterval(() => {
    if (pidIsAlive(ownerPid)) return;
    stop(`web owner pid ${ownerPid} exited`);
    // Network awaits inside generation cannot be cancelled reliably. The worker is
    // disposable: recovery on the next start requeues any generating directive.
    setTimeout(() => process.exit(0), 25);
  }, 500);
} else {
  console.warn(
    "[worker] no --owner-pid supplied; refusing detached worker lifetime",
  );
  setTimeout(() => {
    stop("missing web owner pid");
    process.exit(2);
  }, 25);
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

await Promise.all([
  runRoomWorker().finally(() => stopPumpfunChatIngestor()),
  runPumpfunChatIngestor(),
]);

if (ownerWatchdog) clearInterval(ownerWatchdog);
