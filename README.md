# SLOP TV

An endless shared AI-generated livestream where the audience decides what happens next. v0.10 adds a **rolling adaptive playback reserve**: voting for scene N+1 overlaps scene N rendering, measured generation latency controls ballot safety margins, and the pipeline automatically degrades from FULL → FAST → EMERGENCY before playback runs dry. The continuity stack from v0.9 remains: jsx-ai plans, H3 renders, and FULL mode visually reconciles rendered reality back into durable canon.

## Stack

- **TradJS** server + `tradjs/client` frontend
- **sqlite-zod-orm** for rooms, ballots, proposals, votes, winning directives, clips, and leases
- **measure-fn** for HTTP / DB / arbitration / worker / Pump.fun / showrunner / reconciliation / fal boundaries, with per-clip wall-clock phase telemetry persisted for adaptive buffering
- **jsx-ai** for composable, provider-agnostic showrunner prompting and structured tool output
- **fal + MiniMax H3 Max** for video
- **fal FFmpeg Extract Frame** for server-side start/middle/end frame sampling and continuity
- **fal OpenRouter Vision** for post-render reality reconciliation
- a small read-only Pump.fun Socket.IO adapter over `ws`

## Run

```bash
cp .env.example .env
# add FAL_KEY + the API key for SLOP_SHOWRUNNER_MODEL; optionally add SLOP_PUMPFUN_MINT
bun install
bun run dev:all
```

Or run web and worker separately:

```bash
bun run dev
bun run worker
```

Open `http://localhost:3000`.


## Prompt generation / AI showrunner

Raw viewer text is **not** sent directly to H3 anymore. The generation path is:

```text
winning ballot directive
        │
        ▼
jsx-ai ShowrunnerPrompt.tsx
  system rules + recent canon
  + untrusted viewer directive
        │
        ▼
emit_shot_plan tool call
  premise / action / transition / continuity
  camera / visuals / audio
  dialogue / endingBeat
        │
        ▼
deterministic renderH3Prompt()
        │
        ▼
MiniMax H3 Max
```

`src/server/showrunner.tsx` uses `jsx-ai`'s custom JSX runtime and `callLLM()`. Provider selection is controlled by the model name:

```bash
SLOP_SHOWRUNNER_MODEL=gemini-2.5-flash
GEMINI_API_KEY=...

# alternatives:
# SLOP_SHOWRUNNER_MODEL=gpt-4o
# OPENAI_API_KEY=...
# SLOP_SHOWRUNNER_MODEL=claude-3-5-haiku-latest
# ANTHROPIC_API_KEY=...
```

The showrunner must call one `emit_shot_plan` tool. Its arguments are validated before use. If the showrunner provider is unavailable or returns malformed output, the worker falls back to a deterministic continuity plan so the live stream can keep moving.

Viewer/Pump.fun text is only placed in a user-role message and is explicitly treated as untrusted story intent. It never enters the system instruction block.

Every clip persists `showrunnerModel`, the structured plan JSON, showrunner token usage, the exact H3 prompt, and fal's expanded prompt. This makes prompt behavior replayable/debuggable and gives us data for later showrunner evals.


## v0.8 viewer hierarchy / brainrot UI

The visual direction is an original dark launchpad / memecoin terminal: near-black surfaces, mint-green live accents, yellow locked-winner state, hot-pink voting state, monospace market-terminal metadata, a deliberately stupid `$SLOP` ticker, and chunky ranked prompt cards. The meme energy is cosmetic; the story controls are intentionally unambiguous.

The screen has three distinct prompt states:

```text
NOW PLAYING
  current prompt
  suggested by @user · PUMP.FUN/WEB · proposal # · winning vote count

LOCKED NEXT
  committed/generated next prompt
  suggester/source/votes
  rendering or plays-in countdown

NEXT PROMPT QUEUE
  ranked live proposals
  proposal id · source · author · vote count · vote-share bar
  your current vote highlighted
```

Web submissions receive a stable anonymous display handle derived from the local voter ID (`anon-xxxxxx`) so attribution remains visible without requiring accounts. Pump.fun proposals display their Pump.fun username/address metadata from chat.

`StreamState` includes `currentDirective`, `nextDirective`, and `nextClip`, and directive reads join proposal vote counts so the frontend does not have to guess attribution from recent history.

## Seamless prompt-to-prompt transitions

The showrunner does not jump directly from one winning sentence to the next. `ShotPlan` includes a required `transition` field and the first 1–2 seconds of every continuation must bridge from the previous final frame before fulfilling the new suggestion.

The showrunner is instructed to preserve pose, eyelines, screen direction, motion, props, lighting, spatial relationships, and immediate cause/effect. If chat proposes something unrelated, it must be introduced through a causal reveal/arrival/transformation/reaction/object interaction/camera discovery inside the existing scene rather than a teleport or universe reset.

The generated H3 prompt has a dedicated `SEAMLESS HANDOFF — FIRST 1–2 SECONDS` section, while the previous clip's exact last frame remains the image-to-video anchor. This gives continuity two layers: visual anchoring plus explicit scenario-bridge planning.

## Pump.fun commands

Configure the token/mint:

```bash
SLOP_PUMPFUN_MINT=<TOKEN_MINT>
SLOP_PUMPFUN_PREFIX=!next
SLOP_PUMPFUN_VOTE_PREFIX=!vote
```

A chat message proposes a candidate **and automatically casts that wallet/username's vote for it**:

```text
!next the raccoon opens the VHS and a tiny weather system falls out
```

The stream UI displays candidate IDs and live vote totals. A viewer can move their one vote during the same round:

```text
!vote 42
```

`!vote #42` is accepted too.

If `SLOP_PUMPFUN_PREFIX=` is empty, every non-vote chat message becomes a proposal. Exact duplicate proposal text is merged into one candidate instead of creating backlog.

The Pump.fun adapter is read-only: no wallet credentials, posting, trading, or transaction signing.

## Why ballots instead of FIFO

The old architecture could accumulate hundreds of prompts while H3 generated one five-second scene at a time. v0.5 changes the state machine to:

```text
current generated buffer
        │
        ▼
┌──────────────────────┐
│ scene ballot OPEN    │
│ !next / web proposal │
│ one vote per identity│
└──────────┬───────────┘
           │ deadline or playback safety threshold
           ▼
┌──────────────────────┐
│ atomically LOCK      │
│ rank votes DESC      │
│ tie: earliest idea   │
└──────────┬───────────┘
           │
           ├── winner -> durable directive -> jsx-ai showrunner -> H3 Max -> canon
           │
           └── losers -> expired forever
```

There is normally only one committed directive waiting for generation: the winning ballot. A crashed generation releases that winner back to `queued` and retries it rather than reopening voting and potentially changing canon.

## v0.10 rolling adaptive buffer

The room now aims to keep **2–3 five-second clips banked ahead of playback**. Generation and voting are pipelined rather than serialized:

```text
PLAYING N-1
    │
    ├────────────── H3 renders N
    │                    │
    └── viewers vote on N+1 at the same time
                         │
                         ▼
                  N lands in buffer
                         │
                  winner for N+1 locks
                         │
                         ▼
                    H3 renders N+1
```

Defaults:

```bash
SLOP_MIN_CLIPS_AHEAD=2
SLOP_TARGET_CLIPS_AHEAD=3
SLOP_BUFFER_SAFETY_MARGIN_MS=1000
SLOP_PROMPT_WINDOW_MS=4500
SLOP_GENERATION_LEAD_MS=4500   # cold-start fallback until telemetry exists
```

Every clip persists wall-clock `showrunnerMs`, `h3Ms`, `frameSampleMs`, `visionMs`, and `totalGenerationMs`. The worker computes recent p50/p90 timing and derives an adaptive generation lead from p90 total latency plus the safety margin. `SLOP_GENERATION_LEAD_MS` is now only the cold-start fallback before enough real samples exist.

The recovery ladder is automatic:

```text
FULL
  jsx-ai showrunner
  H3 Max
  start + middle + end frame sampling
  multimodal vision reconciliation

FAST
  shorter jsx-ai showrunner request
  H3 Max
  continuity/end-frame sampling only
  skip optional vision reconciliation

EMERGENCY
  deterministic continuity planner
  H3 Max
  continuity/end-frame sampling only
  skip optional vision reconciliation
```

H3 and the previous clip's final-frame anchor are never removed from the pipeline. Recovery only sheds optional latency. The UI exposes the current mode, banked clip count, buffer health, adaptive lead, p90 generation latency, and median H3 wall time so operators and viewers can see whether the stream is cruising or recovering.

The ballot deadline remains bounded by `SLOP_PROMPT_WINDOW_MS`, but the safe-close threshold is now dynamically derived from observed generation speed. This lets a fast deployment give chat more time and a slow deployment lock earlier without manual tuning.

## Persistent arbitration model

### `promptRounds`

```text
targetEpisode
status              open | closed
openedAtMs
closesAtMs
closedAtMs
winnerProposalId
```

A partial SQLite unique index permits only one `status='open'` round.

### `proposals`

```text
roundId
text
normalizedText
status              open | selected | lost
source              web | pumpfun
sourceId
author
authorAddress
sourceRoom
```

`(roundId, normalizedText)` is unique, so exact duplicate ideas merge.

### `proposalVotes`

```text
roundId
proposalId
voterKey
source
sourceId
```

`(roundId, voterKey)` is unique. Casting another vote updates that row, so one wallet/viewer cannot stack votes across candidates in the same scene.

Pump.fun voter identity prefers wallet/address, then username, then the durable message ID as a final fallback. Web clients get a random local voter ID stored in `localStorage`.

**Prototype trust boundary:** localStorage identity is intentionally lightweight and can be reset/spoofed. Before a high-stakes public launch, put web voting behind a stronger session/rate-limit layer. Pump.fun wallet/address identity is still only as trustworthy as the live-chat event data being consumed.

## Winning directive / crash safety

The ballot lock happens inside `BEGIN IMMEDIATE`. In the same transaction the winner is marked `selected`, losers are marked `lost`, and one durable `directives` row is inserted with `proposalId`.

Generation remains:

```text
queued -> generating -> used
             |
             └── crash/error -> queued -> retry same winner
```

No failed generation can silently pick a different chat winner.

## Shared-room architecture

```text
 Pump.fun live chat                          TradJS viewer
  !next / !vote                           propose / vote
        │                                      │
        ▼                                      ▼
┌───────────────────┐                 ┌──────────────────┐
│ leased Pump ingress│                │ TradJS API routes│
└─────────┬─────────┘                 └────────┬─────────┘
          └──────────────────┬─────────────────┘
                             ▼
                       sqlite-zod-orm
                 promptRounds / proposals / votes
                             │
                    authoritative room worker
                             │
                      atomic ballot lock
                             │
                    one winning directive
                             │
                     jsx-ai showrunner
                  structured five-second plan
                             │
                    deterministic H3 prompt
                             │
            previous clip -> last-frame extract
                             │
                             ▼
                        H3 Max on fal
                             │
                      durable clip timeline
                             │
                       TradJS SSE fanout
                    ┌────────┼────────┐
                    ▼        ▼        ▼
                 viewer A viewer B viewer N
```

Generation and Pump.fun ingress keep separate renewable SQLite leases. Ballot state itself is durable, so web processes and the Pump.fun worker can contribute concurrently without owning generation.

## API surface

```text
GET  /api/state       initial shared snapshot + ballot
GET  /api/events      SSE snapshots
POST /api/proposals   { text, voterId }
POST /api/votes       { proposalId, voterId }
PATCH /api/room       admin running/resolution
```

`POST /api/directives` remains a compatibility alias for `/api/proposals`; public callers can no longer bypass arbitration into the generation FIFO.

## Project shape

```text
app/
  page.client.tsx             # tradjs/client playback + ballot UI
  api/
    proposals/route.ts
    votes/route.ts
    directives/route.ts       # compatibility alias
    events/route.ts
    state/route.ts
    room/route.ts

src/
  worker.ts
  shared/contracts.ts
  server/
    adaptive-buffer.ts       # p50/p90 timing model + buffer health / mode selection
    arbitration.ts            # rounds, proposal merge, one-vote rule, atomic winner
    db.ts                     # sqlite-zod-orm schemas + durable indexes
    repository.ts
    lease.ts
    pumpfun-lease.ts
    pumpfun.ts                # !next / !vote adapter
    pumpfun-socket.ts
    worker.ts                 # adaptive 2–3 clip reserve + pipelined ballots + recovery modes
    generate.ts               # measured FULL/FAST/EMERGENCY generation pipeline
    showrunner.tsx             # jsx-ai LLM shot planner
    visual-reconciler.tsx      # jsx-ai-authored vision audit prompt + canon correction
    video-frames.ts            # sampled frame extraction + end-frame reuse
    prompt.ts                  # sanitization + deterministic H3 renderer
    state-stream.ts
    observability.ts
```

## measure-fn scopes

- `http`
- `db`
- `arbitration`
- `worker`
- `pumpfun`
- `showrunner`
- `reconcile`
- `fal`

The important latency to watch in production is the distribution from **ballot lock → generated clip persisted**. That measurement should drive the generation-lead setting rather than a fixed guess forever.

## v0.8: persistent CANON BRAIN

The showrunner no longer relies only on the previous frame and a short recent-history string. Every successfully generated episode commits an immutable `worldStateSnapshots` row in the same SQLite transaction as its clip. The snapshot tracks the current location, recurring characters, wardrobe/status/position, persistent props, unresolved plot threads, motifs, visual invariants, and the exact ending beat that the next scene inherits.

`jsx-ai` receives the complete prior world state as durable canon and returns both the five-second `ShotPlan` and a conservative complete world-state snapshot for the end of that shot. The H3 prompt receives the prior canonical state plus the exact last-frame image anchor. Only after H3 succeeds are the clip and new world state committed together. This prevents a failed generation from mutating lore.

The browser gets the world-state snapshot for the episode actually playing, not the newest prebuffered episode. The **CANON BRAIN** panel therefore never spoils future generated state and makes continuity assumptions visible to viewers.

```text
current persisted world state
          │
          ├── exact previous final frame
          │
          ▼
     jsx-ai showrunner
          │
     ┌────┴────────────┐
     │                 │
  ShotPlan      next WorldState
     │                 │
     ▼                 │
 deterministic H3      │
 prompt + frame        │
     │                 │
     ▼                 │
   H3 Max              │
     │                 │
     └──── success ────┘
              │
              ▼
 SQLite atomic clip + world snapshot
```

## v0.10: adaptive recovery telemetry

`StreamState.room.buffer` is the live control-plane summary used by the brainrot HUD:

```text
mode / recommendedMode       full | fast | emergency
health                       healthy | tight | critical | empty
bufferMs / targetBufferMs
desiredClipsAhead
adaptiveLeadMs
sampleCount
p50TotalMs / p90TotalMs
p50H3Ms
```

Each clip also records the mode that produced it. This makes underrun investigations replayable: you can see whether H3 slowed down, whether vision became expensive, when the scheduler dropped to FAST/EMERGENCY, and whether the reserve recovered afterward.

## v0.9: rendered-reality reconciliation

The showrunner's planned world state is now treated as a **hypothesis** until the video has actually rendered. After H3 returns a clip, the worker samples the beginning, middle, and end of the rendered video (reusing the known I2V anchor as the start frame when available). fal's Extract Frame endpoint supports `first`, `middle`, and `last` extraction, and the sampled image URLs are sent together to fal's OpenRouter Vision endpoint for one multimodal reality check.

The reconciliation prompt itself is still authored with **jsx-ai**. `visual-reconciler.tsx` renders a JSX prompt into system/user text, then attaches the actual image URLs through fal's multimodal Vision API. The reconciler is deliberately conservative:

- visible frames override planned facts when they materially disagree;
- off-camera characters/props are preserved rather than silently deleted;
- removals must be explicit;
- unresolved plot threads stay unresolved unless the rendered clip visibly resolves them;
- stable character/prop IDs survive visual drift;
- the final `lastEndingBeat` describes the **actual last sampled frame**, not the intended ending.

```text
winning prompt
     │
     ▼
jsx-ai showrunner
     │
     ├── ShotPlan
     └── planned WorldState
             │
             ▼
           H3 Max
             │
       rendered video
             │
      ┌──────┼──────┐
      ▼      ▼      ▼
    START  MIDDLE   END
      └──────┬──────┘
             ▼
 jsx-ai-authored reality prompt
             +
     fal OpenRouter Vision
             │
       ┌─────┴─────┐
       ▼           ▼
  VERIFIED      CORRECTED
       └─────┬─────┘
             ▼
      reconciled canon
             │
             ▼
 next jsx-ai showrunner turn
```

The final clip and reconciled snapshot are committed atomically. The database also retains `plannedStateJson`, reconciliation summary/drift, model, sampled frame URLs, token usage, and reported vision cost so bad continuity can be traced to either planning or rendering. Recent-story context includes the reality-check summary, so a later showrunner turn does not blindly repeat something H3 failed to render.

The clip row stores `startFrameUrl`, `middleFrameUrl`, and `endFrameUrl`. The next I2V generation reuses the previous clip's stored `endFrameUrl` directly; legacy clips fall back to extracting their final frame once.

The viewer's **CANON BRAIN** shows one of:

```text
👁 VISION VERIFIED
👁 CANON PATCHED · N DRIFT
👁 VISION FALLBACK
👁 VISION OFF
```

This UI is still spoiler-safe: it exposes only the reconciliation snapshot for the clip whose scheduled playback time has actually arrived.

Configuration:

```bash
SLOP_RECONCILE_VISION=1
SLOP_RECONCILER_MODEL=google/gemini-2.5-flash
```

The visual reconciler uses the existing `FAL_KEY`; it does not require another provider API key because the multimodal request is routed through fal. Set `SLOP_RECONCILE_VISION=0` to skip the vision pass and use the showrunner's planned canon directly.

