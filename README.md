# PumpTV v0.19

PumpTV is a shared AI-generated video channel driven only by Pump.fun chat. The web UI is view-only.

## Playback

- 480P / 16:9 by default inside a fixed tactile TV enclosure.
- Two video decks are kept in the browser. While one episode plays, the next generated episode is preloaded into the other deck. PumpTV only swaps decks after the incoming video has decoded enough data to play.
- The outgoing frame remains visible during network/decode delay, so episode changes do not expose a black loading frame.
- When no Pump.fun continuation exists, the newest episode loops.
- The vertical episode shelf remains available for replay; replay does not stop generation.

The TV hardware has local viewer controls with tooltip-only labels:

- rotary knob: sound on/off
- `▤`: current prompt caption
- `↗`: next Pump.fun prompt cue
- `⛶`: fullscreen

Sound, caption, and next-cue preferences persist in `localStorage`.

## Generation behavior

- A fresh database generates EP 1 once to establish the world.
- EP 2+ require a real accepted Pump.fun message.
- There is no browser prompt box, browser voting, or autopilot continuation.
- Pump.fun messages are FIFO. The immediate next prompt can be shown on the TV; the rest stay server-side.
- Vision/canon reconciliation is disabled. Continuity comes from the durable planned world state plus the previous episode's final-frame H3 image anchor.

## Pump.fun

Default chat command:

```text
!next the freezer door opens and something impossible rolls out
```

Set `pumpfun_prefix = ""` to accept every Pump.fun chat message as a continuation prompt.

## Runtime

```powershell
bun install

bunx bgrun `
  --name pumptv `
  --directory . `
  --command "bun run start" `
  --force
```

The TradJS process manages `pumptv-worker` through the bgrun SDK. Worker logs:

```powershell
bunx bgrun pumptv-worker --logs
```

## Reset / regenerate from an episode

Reset is intentionally **inclusive**: resetting from EP 7 deletes EP 7 and later, keeps EP 1–6, and re-queues the Pump.fun messages that originally produced the removed episodes. The next generated episode is EP 7 again.

Interactive:

```powershell
bun run reset
```

Direct:

```powershell
bun run reset -- 7
# or
bun run reset -- --from=7
```

The command refuses to mutate the timeline while a render is actively generating. It loads the repo-root `.config.toml` itself, so it uses the same SQLite path as web/worker without `bgrun inline`.

## Config

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

## JSX-AI showrunner

The showrunner uses reusable JSX prompt components and JSX-AI's tool protocol. `stage_shot` commits the next shot; canon changes happen through explicit tools such as `set_location`, `upsert_character`, `upsert_prop`, `open_thread`, and `resolve_thread`. Existing canon is server-owned and is patched rather than rewritten wholesale.
