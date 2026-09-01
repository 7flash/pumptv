import {
  getProcess,
  handleRun,
  isProcessRunning,
  terminateProcess,
} from "bgrun";
import { existsSync } from "node:fs";
import { PROJECT_ROOT } from "./project-paths.ts";
import { lifecycleMeasure } from "./observability.ts";
import { clearWebHeartbeat, touchWebHeartbeat } from "./repository.ts";

export type ManagedWorkerState = "unknown" | "starting" | "running" | "error";

export type ManagedWorkerStatus = {
  name: string;
  state: ManagedWorkerState;
  pid: number | null;
  error: string | null;
  checkedAtMs: number;
};

const WORKER_NAME = "pumptv-worker";
const WORKER_CONFIG_PATH = ".worker.toml";
const CHECK_INTERVAL_MS = 2_000;
const START_ATTEMPTS = 30;
const START_POLL_MS = 100;

const workerCommand = () => `bun src/worker.ts --owner-pid=${process.pid}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let status: ManagedWorkerStatus = {
  name: WORKER_NAME,
  state: "unknown",
  pid: null,
  error: null,
  checkedAtMs: 0,
};
let inFlight: Promise<ManagedWorkerStatus> | null = null;
let firstEnsure = true;
let lifecycleTimer: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

function cleanError(error: unknown) {
  return (
    error instanceof Error
      ? error.message
      : String(error || "Unknown bgrun worker error")
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);
}

function snapshot(patch: Partial<ManagedWorkerStatus>): ManagedWorkerStatus {
  status = { ...status, ...patch, checkedAtMs: Date.now() };
  return status;
}

async function processIsAlive(proc: any) {
  if (!proc?.pid) return false;
  try {
    return await isProcessRunning(Number(proc.pid));
  } catch {
    return false;
  }
}

function startWebLifecycle() {
  if (lifecycleTimer) return;
  lifecycleMeasure.measureSync("Web owns generation worker", () => ({
    pid: process.pid,
    heartbeatMs: 1_000,
  }));
  void touchWebHeartbeat(process.pid).catch(() => {});
  lifecycleTimer = setInterval(() => {
    void touchWebHeartbeat(process.pid).catch(() => {});
  }, 1_000);
}

async function stopWorkerPid(pid: number) {
  try {
    await terminateProcess(pid);
  } catch (error) {
    lifecycleMeasure.measureSync("Worker terminate failed", () => ({
      pid,
      error: cleanError(error),
    }));
  }

  // Do not use bgrun force cleanup here. force cleanup is allowed to chase ports,
  // and this worker intentionally owns no port. A PID-only stop is sufficient.
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      if (!(await isProcessRunning(pid))) return;
    } catch {
      return;
    }
    await sleep(50);
  }
}

async function stopOwnedWorker() {
  if (shuttingDown) return;
  shuttingDown = true;

  if (lifecycleTimer) {
    clearInterval(lifecycleTimer);
    lifecycleTimer = null;
  }

  try {
    await clearWebHeartbeat(process.pid);
  } catch {}

  try {
    const proc = getProcess(WORKER_NAME) as any;
    if (proc?.pid && (await processIsAlive(proc))) {
      lifecycleMeasure.measureSync("Stop owned worker", () => ({
        pid: Number(proc.pid),
      }));
      await stopWorkerPid(Number(proc.pid));
    }
  } catch (error) {
    lifecycleMeasure.measureSync("Owned worker stop failed", () => ({
      error: cleanError(error),
    }));
  }
}

function installShutdownHooks() {
  const stopAndExit = (code: number) => {
    void stopOwnedWorker().finally(() => process.exit(code));
  };
  process.once("SIGINT", () => stopAndExit(0));
  process.once("SIGTERM", () => stopAndExit(0));
}

async function startWorkerWithBgrun(): Promise<ManagedWorkerStatus> {
  if (!existsSync(`${PROJECT_ROOT}/${WORKER_CONFIG_PATH}`)) {
    throw new Error(
      `Missing ${WORKER_CONFIG_PATH}. Copy example.worker.toml to ${WORKER_CONFIG_PATH} and configure the worker runtime.`,
    );
  }

  const command = workerCommand();
  const started = await lifecycleMeasure.measure(
    {
      start: () => `Start ${WORKER_NAME} via bgrun SDK`,
      end: () => ({ config: WORKER_CONFIG_PATH, cwd: PROJECT_ROOT }),
    },
    async () => {
      await handleRun({
        action: "run",
        name: WORKER_NAME,
        command,
        directory: PROJECT_ROOT,
        configPath: WORKER_CONFIG_PATH,
        force: false,
        remoteName: "",
      });
      return true;
    },
  );

  if (!started) throw new Error(`bgrun failed to start ${WORKER_NAME}`);

  for (let attempt = 0; attempt < START_ATTEMPTS; attempt += 1) {
    const proc = getProcess(WORKER_NAME) as any;
    if (await processIsAlive(proc)) {
      firstEnsure = false;
      lifecycleMeasure.measureSync("Worker running", () => ({
        name: WORKER_NAME,
        pid: Number(proc.pid),
      }));
      return snapshot({
        state: "running",
        pid: Number(proc.pid),
        error: null,
      });
    }
    await sleep(START_POLL_MS);
  }

  throw new Error(
    "bgrun created the worker record, but the process did not stay alive. Check `bgrun pumptv-worker --logs`.",
  );
}

async function ensureOnce(): Promise<ManagedWorkerStatus> {
  try {
    const existing = getProcess(WORKER_NAME) as any;
    const alive = await processIsAlive(existing);

    if (alive && !firstEnsure) {
      return snapshot({
        state: "running",
        pid: Number(existing.pid),
        error: null,
      });
    }

    snapshot({
      state: "starting",
      pid: alive ? Number(existing.pid) : null,
      error: null,
    });

    // A new web owner must own a fresh worker because src/worker.ts watches its
    // --owner-pid. Refresh it by PID only; never use bgrun force/port cleanup.
    if (alive) {
      lifecycleMeasure.measureSync("Refresh worker owner", () => ({
        workerPid: Number(existing.pid),
        webPid: process.pid,
      }));
      await stopWorkerPid(Number(existing.pid));
    }

    return await startWorkerWithBgrun();
  } catch (error) {
    firstEnsure = false;
    const message = cleanError(error);
    lifecycleMeasure.measureSync("Worker manager error", () => ({
      error: message,
    }));
    return snapshot({ state: "error", pid: null, error: message });
  }
}

export function getManagedWorkerStatus(): ManagedWorkerStatus {
  return { ...status };
}

export async function ensureGenerationWorker(): Promise<ManagedWorkerStatus> {
  startWebLifecycle();
  const now = Date.now();
  if (
    !firstEnsure &&
    status.checkedAtMs &&
    now - status.checkedAtMs < CHECK_INTERVAL_MS
  ) {
    return getManagedWorkerStatus();
  }
  if (inFlight) return inFlight;

  inFlight = ensureOnce().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

installShutdownHooks();
