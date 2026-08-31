# PumpTV v0.15

PumpTV is an infinite interactive AI video stream. Viewers propose and vote on the next scene from the web UI or Pump.fun chat; a single authoritative worker turns the winning prompt into the next five-second H3 Max clip, preserves continuity, and appends it to a replayable timeline.

## What changed in v0.14

The generation worker is now managed by **bgrun's programmatic SDK** instead of `Bun.spawn`.

- TradJS serves the viewer UI and API.
- `/api/state` and the SSE state stream call `ensureGenerationWorker()`.
- `ensureGenerationWorker()` uses `getProcess`, `isProcessRunning`, and `handleRun` from `bgrun` to own a process named `pumptv-worker`.
- `pumptv-worker` runs `bun run worker`; that script uses `bgrun inline`, so the worker loads the same root `.config.toml` as the web process.
- A new web process refreshes the worker once, ensuring deploys and config changes use the current code/config.
- If the worker dies later, the state loop notices and starts it again.
- The UI distinguishes `STARTING ENGINE`, `ENGINE OFFLINE`, and configuration/provider pauses.

The old `src/run.ts` multi-child `Bun.spawn` supervisor is gone.

## Requirements

- Bun
- A local Codex login/session usable by JSX-AI native Codex mode
- A fal API key for H3 Max/video frame/vision calls

## Configure

PumpTV uses one root `.config.toml`.

```toml
[fal]
key = "YOUR_FAL_KEY"

[codex]
model = "gpt-5.6"
model_reasoning_effort = "medium"
sandbox_mode = "read-only"
approval_policy = "never"

[pumptv]
db_path = ".data/pumptv.sqlite"
room = "main"
resolution = "768P"
admin_token = ""

reconcile_vision = 1
reconciler_model = "google/gemini-2.5-flash"

min_clips_ahead = 2
target_clips_ahead = 3
buffer_safety_margin_ms = 1000
lease_ttl_ms = 30000

timeline_window = 64
min_generation_interval_ms = 0
funds_retry_base_ms = 30000
funds_retry_max_ms = 900000
provider_retry_base_ms = 3000
provider_retry_max_ms = 60000

prompt_window_ms = 4500
generation_lead_ms = 4500
max_proposals_per_round = 40

pumpfun_mint = ""
pumpfun_prefix = "!next"
pumpfun_vote_prefix = "!vote"
pumpfun_lease_ttl_ms = 30000
pumpfun_lease_poll_ms = 1000
pumpfun_max_prompt_length = 500
pumpfun_user_cooldown_ms = 0

idle_poll_ms = 250
error_backoff_ms = 2000

[measure]
silent = 1
timestamps = 1
```

`[fal].key` **cannot be blank** if you expect video generation. With an empty key the worker stays alive and PumpTV reports `CONFIG REQUIRED` rather than pretending the engine is offline.

bgrun flattens TOML keys into environment variables, for example `[fal] key` → `FAL_KEY` and `[pumptv] db_path` → `PUMPTV_DB_PATH`.

## Install

```bash
bun install
```

## Run normally

For a foreground local session:

```bash
bun run start
```

`start` uses `bgrun inline` to load `.config.toml` before starting TradJS. Once the UI connects, TradJS ensures `pumptv-worker` via the bgrun SDK.

For a persistent managed web process:

```bash
bunx bgrun \
  --name pumptv \
  --directory . \
  --command "bun run start" \
  --force
```

You should then see both processes in bgrun:

```bash
bunx bgrun
```

Expected shape:

```text
pumptv         Running   ... bun run start
pumptv-worker  Running   ... bun run worker
```

## Worker diagnostics

The managed worker has its own bgrun log files. Inspect them directly:

```bash
bunx bgrun pumptv-worker --logs --lines 100
```

The web process should log only useful lifecycle messages by default, e.g.:

```text
[pumptv] starting pumptv-worker via bgrun SDK
[pumptv] pumptv-worker running via bgrun (pid 12345)
```

The worker log should contain:

```text
[worker] PumpTV room worker host:pid:id
[worker] generating EP 1 · FULL · opening
[worker] published EP 1 · ...ms
```

If `[fal].key` is empty, the worker stays online and the UI shows the exact configuration error. Edit `.config.toml` and restart the web process so the worker is refreshed with the new environment.

## Observability

PumpTV still structures boundaries with `measure-fn`, but trace printing is silent by default **even if environment loading fails**. Set:

```toml
[measure]
silent = 0
```

when you actually want detailed `db`, `worker`, `fal`, `showrunner`, and reconciliation traces.

## Main architecture

```text
browser / Pump.fun
        │
        ▼
 TradJS web process
        │
        ├── state + SSE
        ├── ballot/votes
        │
        └── bgrun SDK ensure
                 │
                 ▼
          pumptv-worker
                 │
           SQLite lease
                 │
          JSX-AI Codex
                 │
             H3 Max
                 │
       clip + canon snapshot
                 │
                 ▼
          shared timeline
```

The UI keeps current prompt attribution, locked-next attribution, ranked votes, viewer count, rolling buffer state, Canon Brain, and the horizontal episode replay rail.


## bgrun lifecycle (v0.15)

There is **no `bgrun inline` anywhere in PumpTV**. The outer web process should itself be managed by bgrun:

```bash
bunx bgrun --name pumptv --directory . --command "bun run start" --force
```

`bun run start` is only `tradjs serve 3000`. Because bgrun owns that process with the repo root as its directory, bgrun automatically reads `.config.toml` and injects the flattened environment.

The TradJS server then ensures `pumptv-worker` through the bgrun programmatic API. The worker is started with:

```ts
await handleRun({
  action: "run",
  name: "pumptv-worker",
  command: "bun src/worker.ts",
  directory: PROJECT_ROOT,
  configPath: ".config.toml",
  force: refreshExistingWorker,
});
```

`handleRun` loads `.config.toml` relative to `directory` itself, so nesting `bgrun inline` would only load the same configuration twice.

### Required fal credential

A blank value is intentionally treated as missing:

```toml
[fal]
key = ""
```

Video generation cannot start in that state. Set a real fal key and restart the managed `pumptv` process. On worker startup, logs print `FAL_KEY=present` or `FAL_KEY=missing` without printing the secret.
