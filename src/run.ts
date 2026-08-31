const children: Bun.Subprocess[] = [];
let stopping = false;

function spawn(label: string, command: string[]) {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(child);
  console.log(`[pumptv] ${label} started (pid ${child.pid})`);
  return child;
}

function stop(signal: NodeJS.Signals = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      child.kill(signal);
    } catch {}
  }
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

console.log("[pumptv] booting web + generation worker");
const worker = spawn("generation worker", ["bun", "run", "worker"]);
const web = spawn("web server", ["bun", "run", "web"]);

const first = await Promise.race([
  worker.exited.then((code) => ({ label: "generation worker", code })),
  web.exited.then((code) => ({ label: "web server", code })),
]);

if (!stopping) {
  console.error(
    `[pumptv] ${first.label} exited with code ${first.code}; stopping PumpTV`,
  );
  stop();
}

await Promise.allSettled(children.map((child) => child.exited));
process.exit(first.code || 0);
