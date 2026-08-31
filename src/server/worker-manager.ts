import {
  getProcess,
  handleRun,
  isProcessRunning,
  terminateProcess,
} from "bgrun";
import { PROJECT_ROOT } from "./project-paths.ts";
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
const workerCommand = () => `bun src/worker.ts --owner-pid=${process.pid}`;
const CONFIG_PATH = ".config.toml";
const CHECK_INTERVAL_MS = 2_000;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanError(error: unknown) {
  return (
    error instanceof Error
      ? error.message
      : String(error || "Unknown bgrun error")
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
  console.log(
    `[pumptv] web owner pid=${process.pid}; worker lifetime is coupled to this process`,
  );
  void touchWebHeartbeat(process.pid);
  lifecycleTimer = setInterval(() => {
    void touchWebHeartbeat(process.pid);
  }, 1_000);
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
      console.log(`[pumptv] stopping owned ${WORKER_NAME} (pid ${proc.pid})`);
      await terminateProcess(Number(proc.pid));
    }
  } catch (error) {
    console.warn(
      `[pumptv] could not stop worker cleanly: ${cleanError(error)}`,
    );
  }
}

function installShutdownHooks() {
  const stopAndExit = (code: number) => {
    void stopOwnedWorker().finally(() => process.exit(code));
  };
  process.once("SIGINT", () => stopAndExit(0));
  process.once("SIGTERM", () => stopAndExit(0));
}

async function ensureOnce(): Promise<ManagedWorkerStatus> {
  try {
    const existing = getProcess(WORKER_NAME) as any;
    const alive = await processIsAlive(existing);

    // A freshly-started web process refreshes an existing worker once so an edited
    // .config.toml is applied. There is no nested `bgrun inline`: handleRun itself
    // loads CONFIG_PATH relative to PROJECT_ROOT and injects the flattened env.
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
    console.log(
      `[pumptv] ${alive ? "refreshing" : "starting"} ${WORKER_NAME} via bgrun SDK`,
    );
    const command = workerCommand();
    console.log(
      `[pumptv] worker cwd=${PROJECT_ROOT} config=${CONFIG_PATH} command=${command}`,
    );

    await handleRun({
      action: "run",
      name: WORKER_NAME,
      command,
      directory: PROJECT_ROOT,
      configPath: CONFIG_PATH,
      force: Boolean(existing),
      remoteName: "",
    });
    firstEnsure = false;

    for (let attempt = 0; attempt < 30; attempt += 1) {
      const proc = getProcess(WORKER_NAME) as any;
      if (await processIsAlive(proc)) {
        console.log(
          `[pumptv] ${WORKER_NAME} running via bgrun (pid ${proc.pid})`,
        );
        return snapshot({
          state: "running",
          pid: Number(proc.pid),
          error: null,
        });
      }
      await sleep(100);
    }

    throw new Error(
      "bgrun created the worker record, but the process did not stay alive. Check `bunx bgrun pumptv-worker --logs`.",
    );
  } catch (error) {
    firstEnsure = false;
    const message = cleanError(error);
    console.error(`[pumptv] worker manager error: ${message}`);
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
