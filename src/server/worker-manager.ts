import {
  getProcess,
  handleRun,
  isProcessRunning,
  removeProcessByName,
  terminateProcess,
} from "bgrun";
import { resolve } from "node:path";
import { readTomlEnvironment } from "./config-file.ts";
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
  const message = (
    error instanceof Error
      ? error.message
      : String(error || "Unknown bgrun worker error")
  )
    .replace(/\s+/g, " ")
    .trim();

  // bgrun includes the worker stderr tail in startup failures. Keep the viewer UI
  // useful instead of surfacing a multi-screen stack trace for transient SQLite
  // contention; the complete child log remains available through bgrun.
  if (/SQLITE_BUSY|database is locked/i.test(message)) {
    return "Generation worker database was busy during startup; retrying.";
  }

  return message.slice(0, 700);
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

function recordCanBeTerminatedAsWorker(proc: any) {
  const pid = Number(proc?.pid || 0);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid)
    return false;
  const command = String(proc?.command || "");
  return command.includes("src/worker.ts");
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

async function forgetWorkerRecord() {
  const existing = getProcess(WORKER_NAME) as any;
  if (!existing) return;

  await lifecycleMeasure.measure(
    {
      start: () => `Forget stale ${WORKER_NAME} bgrun record`,
      end: () => ({ name: WORKER_NAME }),
    },
    async () => {
      // Important: bgrun reconciles dead records before a new run. A stale
      // pumptv-worker record can be matched to the live web PID because both
      // processes share the same project directory. If that old record carries
      // historical port metadata, reconciliation may then clean the web port.
      // Remove only the worker registry row before handleRun() so the next run
      // is created from the portless .worker.toml with no PID/port history.
      await removeProcessByName(WORKER_NAME);
    },
  );
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
    if (recordCanBeTerminatedAsWorker(proc) && (await processIsAlive(proc))) {
      lifecycleMeasure.measureSync("Stop owned worker", () => ({
        pid: Number(proc.pid),
      }));
      await stopWorkerPid(Number(proc.pid));
    }
    // Keep the stopped bgrun row/log paths for postmortem inspection. The next
    // web owner removes that stale row immediately before creating a fresh run.
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

async function validateWorkerConfig() {
  return lifecycleMeasure.measure(
    {
      start: () => "Validate worker config",
      end: (summary) => summary,
    },
    async () => {
      const workerEnv = await readTomlEnvironment(
        PROJECT_ROOT,
        WORKER_CONFIG_PATH,
        { required: true },
      );

      const webRoom = process.env.PUMPTV_ROOM || "main";
      const workerRoom = workerEnv.PUMPTV_ROOM || "main";
      if (workerRoom !== webRoom) {
        throw new Error(
          `${WORKER_CONFIG_PATH} PUMPTV_ROOM=${workerRoom} does not match web PUMPTV_ROOM=${webRoom}`,
        );
      }

      const webDb = resolve(
        PROJECT_ROOT,
        process.env.PUMPTV_DB_PATH || ".data/pumptv.sqlite",
      );
      const workerDb = resolve(
        PROJECT_ROOT,
        workerEnv.PUMPTV_DB_PATH || ".data/pumptv.sqlite",
      );
      if (workerDb !== webDb) {
        throw new Error(
          `${WORKER_CONFIG_PATH} PUMPTV_DB_PATH resolves to ${workerDb}, but web uses ${webDb}`,
        );
      }

      return {
        room: workerRoom,
        db: workerDb,
        fal: workerEnv.FAL_KEY ? "present" : "missing",
        model: workerEnv.JSX_AI_MODEL || "default",
      };
    },
  );
}

async function startWorkerWithBgrun(): Promise<ManagedWorkerStatus> {
  await validateWorkerConfig();
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
    const alive =
      recordCanBeTerminatedAsWorker(existing) &&
      (await processIsAlive(existing));

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

    // Always clear the previous worker row, even when its PID is already dead.
    // This is what prevents bgrun's dead-PID reconciliation from attaching the
    // worker name to the current web process and cleaning the web port.
    if (existing) await forgetWorkerRecord();

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
