# PumpTV v0.30

PumpTV is a watch-only AI video channel controlled by Pump.fun chat. The browser only watches/replays; suggestions and votes come from Pump.fun, while an operator can inspect or override the decision through the CLI.

## Live program state

The server publishes one canonical program state:

```text
IDLE → VOTING → LOCKED → PLANNING → RENDERING → FINALIZING → READY
                 ↘ SETUP / PAUSED / OFFLINE when generation cannot proceed
```

The TradJS frontend renders this state instead of reconstructing it from several unrelated fields. Replay is a local viewer branch: selecting an old episode enters replay, and selecting the newest episode or live control returns to the canonical live program.

If Pump.fun starts voting for the following episode while the immediate winner is rendering, PumpTV exposes both states: the locked/rendering episode remains primary and the future ballot appears as a smaller secondary ranking.

## Viewing

- New visitors join the latest published episode from frame 0.
- The latest episode plays cleanly to the end. If there is no decoded next episode, PumpTV holds its final frame and uses the empty TV slot for Pump.fun voting/generation status.
- Voting/generation UI never covers a still-playing episode.
- The incoming episode is preloaded in a permanent second video deck outside the TradJS render tree.
- PumpTV waits for an actual decoded frame before crossfading, so UI rerenders cannot create a black-frame transition.
- Older episodes are available in the vertical episode shelf and automatically advance forward when replaying.

## Local control architecture

Viewer-only controls no longer cause TradJS rerenders. Sound, captions, live overlay and the info modal are controlled by persistent `document.documentElement` data attributes plus direct media mutation. The JSX tree always contains the caption/overlay/modal structures; CSS switches their visibility. This prevents a TradJS redraw from leaving a control visually toggled while its target remains mounted in the wrong state.

Replay/live selection also avoids a local JSX redraw. Episode clicks update the requested clip, permanent media decks and episode selection directly; the live overlay is hidden/shown from the persistent `data-pumptv-mode` attribute. Server/SSE updates may still redraw the data-driven UI, after which PumpTV reapplies the local attributes immediately.

## Pump.fun flow

```text
!next a forklift smashes through the freezer door
!next A forklift smashes through freezer door!!
!vote @alice
```

`!next` proposes and votes. Exact/near-duplicate ideas merge into one candidate, so repeated similar suggestions from different wallets increase the same vote count. `!vote @handle` moves the sender's one vote to the proposal associated with that handle.

The first suggestion starts the round timer. With:

```toml
[pumptv]
vote_window_ms = 15000
```

PumpTV locks the leader after 15 seconds. No suggestions means no countdown and no new generation.

## Viewer UI

The browser has no input or voting controls. The TV hardware controls are rotary controls for:

- sound
- current-prompt captions
- live decision/generation overlay
- information/world-state modal
- fullscreen

The information modal contains Pump.fun instructions, full ranking, vote counts, current location, characters, props and unresolved story threads.

## Operator CLI

```powershell
# one-shot canonical state
bun run control -- status

# print only when the program state changes
bun run control -- watch

# full JSON state
bun run control -- json

# operator vote override
bun run control -- set-votes 42 100
bun run control -- set-votes 42 auto

# finalize current leader immediately
bun run control -- trigger

# force a specific internal proposal id before rendering begins
bun run control -- force 42

# inject + lock an operator scene
bun run control -- inject "the vending machine becomes sentient"
```

Proposal IDs are operator/debug identifiers only. Pump.fun users never need them.

A compact read-only HTTP diagnostic is also available at `/api/status`.

## Reset / branch history

Reset is inclusive. EP 7 deletes EP 7+ and restores the EP 6 world-state snapshot; removed Pump.fun winners return to queued state.

```powershell
bun run reset
bun run reset -- 7
bun run reset -- --from=7
```

Reset refuses to run while a generation is actively rendering.

## Process ownership

Run only the TradJS web process through bgrun:

```powershell
bun install

bunx bgrun `
  --name pumptv `
  --directory . `
  --command "bun run start" `
  --force
```

The web process starts `pumptv-worker` with the bgrun SDK and passes `--owner-pid=<web pid>`. The worker checks that PID every 500ms and exits when the actual web PID disappears, even if it is currently awaiting Codex/H3. A SQLite web heartbeat remains a secondary safety guard.

If the web process itself is managed by bgrun, closing a log viewer does not kill the managed web PID. Stop that managed process to stop the ownership tree.

## Config

```toml
[fal]
key = "YOUR_FAL_KEY"

[jsx_ai]
runtime = "codex"
model = "gpt-5.6"

[pumptv]
db_path = ".data/pumptv.sqlite"
room = "main"
resolution = "480P"

lease_ttl_ms = 30000
web_heartbeat_ttl_ms = 6000
timeline_window = 96
idle_poll_ms = 500
error_backoff_ms = 2000

pumpfun_mint = "YOUR_TOKEN_MINT"
pumpfun_prefix = "!next"
pumpfun_vote_prefix = "!vote"
vote_window_ms = 15000
max_proposals_per_round = 40
pumpfun_lease_ttl_ms = 30000
pumpfun_lease_poll_ms = 1000
pumpfun_max_prompt_length = 500
pumpfun_user_cooldown_ms = 0

[measure]
silent = 1
timestamps = 1
```

## JSX-AI showrunner

The showrunner uses JSX-AI as an orchestration layer, not as string templating. `stage_shot` is mandatory, while canon changes are explicit production-tool calls such as `set_location`, `upsert_character`, `upsert_prop`, `open_thread`, `resolve_thread`, `remember_motif`, and `remember_visual_rule`.

Vision reconciliation remains disabled for now. Continuity comes from the durable planned world state plus the previous episode's final frame used as the next H3 image-to-video anchor.

## Tests

```powershell
bun test
```

The canonical program reducer has regression cases for idle, active voting, locked winner with a simultaneous future ballot, rendering, and config-pause states.

## Playback semantics

The Pump.fun decision UI is an **intermission**, not an overlay on a playing episode.
The latest published episode plays cleanly to its actual end. If no decoded next
video is available, the final painted frame is parked and the TV slot changes to
voting / locked / generation status. As soon as the next episode decodes, that
intermission fades away and the two-deck player reveals the new episode from frame 0.

The vertical archive also reserves one non-clickable future-program slot above the
newest episode so viewers can see that a next episode is pending without obscuring
current playback.


### Replay switching

Replay and live-edge playback use separate semantics. Selecting an archived episode always requests that clip from frame 0 and starts the incoming deck muted-first before restoring the viewer sound preference. This avoids delayed `canplay` callbacks being rejected as unmuted autoplay. Stale `ended` events from the outgoing deck are ignored unless they belong to the replay episode that is still selected, so a previous deck cannot advance or cancel a newly requested replay.


## v0.30 replay media race fix

Replay switching now reserves the inactive video deck exclusively for the requested episode until that episode is actually active. The 100ms media heartbeat cannot launch duplicate async activations for the same clip, and preloading is disabled during a switch. Only after the requested clip becomes active may the other deck preload the episode that follows it.

This fixes two races that could leave an archive card selected while the visible video stayed frozen: repeated `activateVideoSlot()` calls invalidating one another through `switchSerial`, and the preloader overwriting the requested replay URL in the inactive deck before activation committed.


## JSX-AI runtime

PumpTV does not treat Codex as a provider. The repo-root `.config.toml` sets:

```toml
[jsx_ai]
runtime = "codex"
model = "gpt-5.6"
```

bgrun exposes those as `JSX_AI_RUNTIME=codex` and `JSX_AI_MODEL=gpt-5.6`. The showrunner builds a real `<prompt strategy="hybrid">` tree with `<system>`, `<tool>`, `<param>`, and `<message>` nodes, then calls `callLLM(prompt)` without provider/auth overrides. `jsx-ai` owns Codex runtime authentication and tool-call bridging.

## Process lifetime

PumpTV deliberately uses two different bgrun modes:

- The **web process is foreground**: `bun run start` expands to `bgrun inline -- tradjs serve 3000`. This loads `.config.toml` but keeps TradJS attached to the current terminal, so Ctrl+C actually terminates the web owner.
- The **generation worker is managed** through bgrun's programmatic `handleRun()` API. It receives `--owner-pid=<web pid>` and exits when that foreground web PID disappears.

Do **not** wrap `bun run start` in another managed `bgrun --name pumptv --command ...` process if you expect Ctrl+C to stop PumpTV. Managed bgrun processes are intentionally detached and survive the launcher terminal. To stop a managed web process, use `bgrun --stop pumptv`.

For local/dev use, simply run:

```bash
bun run start
```

Then Ctrl+C stops TradJS and the owned worker follows.
