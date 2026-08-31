# PumpTV v0.17

PumpTV is a shared AI-generated live video stream driven by Pump.fun chat.

The browser is deliberately **view-only**. There is no prompt box, web voting, or web queue mutation. Pump.fun chat is the only source of continuation prompts.

## Behavior

- PumpTV generates **one opening episode** automatically on a fresh database.
- After the opening, the worker does **nothing** until an accepted Pump.fun chat prompt is queued.
- Each accepted Pump.fun prompt becomes exactly one future episode, FIFO.
- No autopilot filler is generated when chat is quiet.
- Default output is **480P / 16:9**.
- The video sits inside a fixed tactile TV-style player so 480P still reads intentionally.
- The right-side episode shelf is vertical and replayable, similar to an anime episode browser.
- Replaying old episodes does not stop the authoritative worker.
- The latest finished episode loops while PumpTV waits for another Pump.fun prompt.
- Viewer count comes from active room SSE presence.
- Visual/canon reconciliation is disabled for now. The JSX-AI/Codex showrunner still carries planned continuity/world state forward, and the previous clip's end frame remains the next H3 image anchor.

## Prompt source

By default only Pump.fun messages beginning with `!next` are accepted:

```text
!next the vending machine opens and a tiny limo drives out
```

Set `pumpfun_prefix = ""` to treat every Pump.fun chat message as a continuation prompt.

There is no `!vote` command in the current version.

## Runtime

PumpTV uses:

- `tradjs` + `tradjs/client`
- `bgrun` SDK for the managed generation worker
- `sqlite-zod-orm`
- `measure-fn`
- `jsx-ai` native Codex mode
- fal / MiniMax H3 Max for video

The web process starts/refreshes `pumptv-worker` through `bgrun.handleRun()` using the same repo-root `.config.toml`.

```powershell
bun install

bunx bgrun `
  --name pumptv `
  --directory . `
  --command "bun run start" `
  --force
```

Worker logs:

```powershell
bunx bgrun pumptv-worker --logs
```

## `.config.toml`

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
resolution = "480P"
admin_token = ""

min_generation_interval_ms = 0
lease_ttl_ms = 30000
timeline_window = 96
idle_poll_ms = 500
error_backoff_ms = 2000

pumpfun_mint = "YOUR_TOKEN_MINT"
pumpfun_prefix = "!next"
pumpfun_lease_ttl_ms = 30000
pumpfun_lease_poll_ms = 1000
pumpfun_max_prompt_length = 500
pumpfun_user_cooldown_ms = 0

[measure]
silent = 1
timestamps = 1
```

## Important when upgrading from the old autopilot builds

Older builds may already have generated many filler episodes. v0.17 does not delete history automatically. If you want to test the new behavior from a clean slate, stop PumpTV and remove:

```text
.data/pumptv.sqlite
```

Then restart. You should see one opening episode and no EP 2 until a real Pump.fun prompt arrives.

## Expected worker log

Fresh database:

```text
[worker] generating EP 1 · 480P · opening
[showrunner] planned EP 1 via Codex ...
[worker] published EP 1 · ...ms
```

Then the worker stays idle.

After Pump.fun receives:

```text
!next a shopping cart rolls in by itself
```

logs should show:

```text
[pumpfun] queued @username → a shopping cart rolls in by itself
[worker] generating EP 2 · 480P · pump.fun prompt
[showrunner] planned EP 2 via Codex ...
[worker] published EP 2 · ...ms
```
