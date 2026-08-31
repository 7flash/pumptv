# SLOP TV

An endless shared AI-generated livestream where the audience decides what happens next. v0.7 combines the **jsx-ai showrunner** with a much clearer brainrot / memecoin live-terminal UI. Chat chooses intent, the showrunner turns it into a structured five-second shot plan with an explicit continuity handoff, and deterministic code renders the final H3 prompt. The viewer always exposes NOW PLAYING, LOCKED NEXT, and the live ranked NEXT PROMPT QUEUE.

## Stack

- **TradJS** server + `tradjs/client` frontend
- **sqlite-zod-orm** for rooms, ballots, proposals, votes, winning directives, clips, and leases
- **measure-fn** for HTTP / DB / arbitration / worker / Pump.fun / showrunner / fal boundaries
- **jsx-ai** for composable, provider-agnostic showrunner prompting and structured tool output
- **fal + MiniMax H3 Max** for video
- **fal FFmpeg Extract Frame** for server-side last-frame continuity
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


## v0.7 viewer hierarchy / brainrot UI

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

## Playback-safe voting window

Defaults:

```bash
SLOP_TARGET_BUFFER_MS=6500
SLOP_PROMPT_WINDOW_MS=4500
SLOP_GENERATION_LEAD_MS=3000
```

The ballot can stay open for up to 4.5 seconds. The authoritative worker also knows how much video remains buffered. If only the generation lead remains, it locks the ballot early and starts H3 rather than intentionally causing a stream underrun.

This means the real ballot deadline is approximately:

```text
min(
  ballot_open_time + SLOP_PROMPT_WINDOW_MS,
  end_of_generated_buffer - SLOP_GENERATION_LEAD_MS
)
```

If fal latency changes, tune `SLOP_GENERATION_LEAD_MS` from measured production inference times.

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
    arbitration.ts            # rounds, proposal merge, one-vote rule, atomic winner
    db.ts                     # sqlite-zod-orm schemas + durable indexes
    repository.ts
    lease.ts
    pumpfun-lease.ts
    pumpfun.ts                # !next / !vote adapter
    pumpfun-socket.ts
    worker.ts                 # buffer-aware ballot deadline + generation
    generate.ts               # fal orchestration
    showrunner.tsx             # jsx-ai LLM shot planner
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
- `fal`

The important latency to watch in production is the distribution from **ballot lock → generated clip persisted**. That measurement should drive the generation-lead setting rather than a fixed guess forever.
