# SLOP TV

One endless AI-generated livestream, one shared canon, many viewers steering what happens next — now including **Pump.fun live chat as a first-class prompt source**.

This version uses the stack deliberately:

- **TradJS** for SSR, file-system API routes, streaming `Response`s, and the `tradjs/client` frontend.
- **sqlite-zod-orm** for the room record, durable multi-source prompt queue, generated clip timeline, and leases.
- **measure-fn** for scoped HTTP / DB / fal / worker / Pump.fun traces.
- **fal + MiniMax H3 Max** for video generation.
- **fal FFmpeg Extract Frame** for server-side last-frame continuity.
- A tiny **read-only Pump.fun Socket.IO adapter** over `ws`, isolated from the rest of the app.

The generator is still authoritative. Pump.fun is only an ingress source: a chat message becomes a persisted directive and then waits in the exact same FIFO as prompts submitted from the TradJS frontend.

## Run it

This is Bun-first.

```bash
cp .env.example .env
# add FAL_KEY
bun install
```

For local development, run web + worker together:

```bash
bun run dev:all
```

Or run them separately, which is closer to production:

```bash
# terminal 1
bun run dev

# terminal 2
bun run worker
```

Open `http://localhost:3000`.

## Pump.fun chat setup

Take the token/mint from the Pump.fun live-chat URL:

```text
https://pump.fun/livechat/<MINT>
```

Then configure:

```bash
SLOP_PUMPFUN_MINT=3VkUe5T9uAuU6EqmEMqQcuTRqEcqU86NAfwbFZKxpump
SLOP_PUMPFUN_PREFIX=!next
```

With that default prefix, this Pump.fun chat message:

```text
!next a chrome dolphin crashes through the casino ceiling
```

becomes the next durable directive:

```text
a chrome dolphin crashes through the casino ceiling
```

If you want **every live Pump.fun chat message** to steer the stream, leave the prefix empty:

```bash
SLOP_PUMPFUN_PREFIX=
```

Only new `message` events are ingested. Message-history payloads are intentionally ignored so restarting the worker does not replay old chat into the future.

Reading the current live chat does not require a Pump.fun auth token. This integration intentionally does **not** send messages, trade, sign transactions, or require wallet credentials.

The Pump.fun live-chat transport is not a stable official public API contract, so the wire protocol is isolated in `src/server/pumpfun-socket.ts`. If Pump.fun changes its Socket.IO protocol later, the queue/generator architecture does not need to change.

## Architecture

```text
 Pump.fun live chat                         TradJS web chat
        │                                        │
        │ Socket.IO                              │ POST /api/directives
        ▼                                        ▼
┌───────────────────┐                    ┌──────────────────┐
│ Pump.fun adapter  │                    │   TradJS route   │
│ dedicated DB lease│                    └────────┬─────────┘
└─────────┬─────────┘                             │
          │ source=pumpfun                        │ source=web
          │ message id / user / wallet            │
          └──────────────────┬────────────────────┘
                             ▼
                     sqlite-zod-orm
                  persistent shared FIFO
                             │
                             ▼
                    authoritative worker
                  renewable generation lease
                             │
             ┌───────────────┴───────────────┐
             │                               │
             ▼                               ▼
    fal FFmpeg extract-frame          prompt + recent canon
      previous video → last frame             │
             │                               │
             └───────────────┬───────────────┘
                             ▼
                      MiniMax H3 Max
                             │
                             ▼
                     persist next clip
                             │
                             ▼
                    shared live timeline
                             │
                      TradJS SSE fanout
                    ┌────────┼────────┐
                    ▼        ▼        ▼
                 viewer A viewer B viewer N
```

Pump.fun ingestion and video generation use **separate leases**. That matters because the chat connection should stay open continuously while the generator lease is intentionally short-lived and only protects one clip-generation transaction.

## Project shape

```text
app/
  layout.tsx
  page.tsx
  page.client.tsx             # tradjs/client: playback + web prompt entry
  globals.css
  api/
    directives/route.ts       # enqueue source=web directive
    events/route.ts           # SSE room/timeline stream
    room/route.ts             # admin room settings
    state/route.ts            # initial snapshot / fallback

src/
  worker.ts                    # generation + Pump.fun ingestor entry
  shared/
    contracts.ts
  server/
    db.ts                      # sqlite-zod-orm schemas + source idempotency index
    repository.ts              # all durable app state
    lease.ts                   # atomic generation lease
    pumpfun-lease.ts           # atomic Pump.fun connection lease
    pumpfun.ts                 # leased Pump.fun ingress + queue adapter
    pumpfun-socket.ts          # tiny Socket.IO read protocol over ws
    worker.ts                  # room generation loop + buffer policy
    generate.ts                # frame extraction + H3 generation
    prompt.ts                  # continuity/showrunner prompt
    state-stream.ts            # one DB poller, SSE fanout to viewers
    observability.ts           # measure-fn scopes
```

Dependency direction:

```text
tradjs/client ───────────────> JSON/SSE only

Pump.fun ─> pumpfun adapter ─┐
                            ├─> repository ─> sqlite-zod-orm
TradJS routes ───────────────┘       ▲
                                    │
authoritative worker ───────> generate ─────> fal
          │
          └─────────────────> SQLite generation lease
```

## Directive persistence

Directives are now source-aware:

```text
id
text
status             queued | generating | used
usedEpisode
source             web | pumpfun
sourceId           Pump.fun message id, nullable for web
 author            Pump.fun username
 authorAddress     Pump.fun wallet/address
 sourceRoom        Pump.fun mint/room
```

Pump.fun messages have a durable `(source, sourceId)` uniqueness constraint. If the chat socket reconnects, or one adapter process hands the lease to another, receiving the same Pump.fun message twice cannot enqueue it twice.

The generation state machine remains crash-safe:

```text
queued -> generating -> used
             |
             └-- worker crashes --> recovered on next generation lease
```

The generator does not care where a directive came from. `claimQueuedDirective()` always claims the oldest queued row, which means web and Pump.fun prompts naturally share one canon.

## Pump.fun adapter behavior

The worker executable runs two independent loops:

```ts
await Promise.all([
  runRoomWorker(),
  runPumpfunChatIngestor(),
]);
```

Only one process is allowed to own the Pump.fun connection at a time. The adapter acquires `pumpChatLeaseOwner`, renews it while connected, and disconnects if the lease is lost. Another worker can then take over after expiry.

The socket adapter reconnects with bounded exponential backoff while the process still owns the chat lease. Losing the lease aborts the socket and reconnect loop immediately. Adapter state is persisted into the room as:

```text
disabled | standby | connecting | live | error
```

That status is exposed through `/api/state` and SSE, so the viewer UI can show whether Pump.fun ingress is actually live.

### Prompt filtering

`SLOP_PUMPFUN_PREFIX=!next` is recommended for a public stream because normal Pump.fun conversation can be much faster than five-second video generation.

Set an empty prefix for the original “anything in chat becomes the future” behavior.

There is also an optional per-user throttle:

```bash
SLOP_PUMPFUN_USER_COOLDOWN_MS=0
```

`0` means no throttling. Raising it to e.g. `2000` accepts at most one matching prompt from a wallet/username every two seconds. Deduplication by message ID still applies independently.

## Persistence model

### `rooms`

The room contains global server state plus two independent leases:

- `running`
- `resolution`
- `workerState`: `idle | generating | error`
- `lastError`
- `leaseOwner` / `leaseUntilMs` / `heartbeatAtMs`
- `pumpChatState` / `pumpChatError`
- `pumpChatLeaseOwner` / `pumpChatLeaseUntilMs` / `pumpChatHeartbeatAtMs`

### `directives`

Web and Pump.fun prompt sources share the same table and FIFO.

### `clips`

Each clip persists:

- fal request ID / video URL
- viewer/chat/autopilot directive + `directiveId`
- episode number
- extracted continuity-frame URL
- resolution / inference timing
- `startsAtMs`
- `durationSeconds`

`startsAtMs` turns generated clips into a real shared wall-clock timeline. Every browser computes which clip should be playing from server time, so late joiners enter the same moment instead of starting at episode 1.

## Generation worker / lease behavior

The generator maintains a small future buffer instead of generating as fast as fal allows.

Default target:

```text
SLOP_TARGET_BUFFER_MS=6500
```

With five-second clips, this keeps roughly one clip ahead. When enough future video exists, the worker sleeps. When the buffer drops below target, it tries to acquire the generation lease and generate exactly one successor.

The lease is acquired with `BEGIN IMMEDIATE` through `sqlite-zod-orm`'s raw SQL escape hatch and renewed while a long fal request is in flight. If a process dies, its lease expires and another worker can take over.

## Continuity

For episode 1:

```text
text prompt -> H3 Max text-to-video
```

For every later episode:

```text
previous video URL
      |
      v
fal-ai/ffmpeg-api/extract-frame
      frame_type: last
      |
      v
last-frame image URL
      |
      v
H3 Max image-to-video
```

## Live delivery

`/api/events` is Server-Sent Events. Each TradJS web process runs **one** state polling loop and fans the resulting snapshot out to all connected viewers, rather than performing a separate SQLite poll per viewer.

The client keeps a server-clock offset and advances clips locally at their shared wall-clock boundary.

## Room admin

Generation controls are server-side. The public viewer UI cannot pause the global room or change everyone else's quality.

Set an admin token in production:

```bash
SLOP_ADMIN_TOKEN=change-me
```

Pause generation:

```bash
curl -X PATCH http://localhost:3000/api/room \
  -H 'content-type: application/json' \
  -H 'x-slop-admin-token: change-me' \
  -d '{"running":false}'
```

Resume at 480P:

```bash
curl -X PATCH http://localhost:3000/api/room \
  -H 'content-type: application/json' \
  -H 'x-slop-admin-token: change-me' \
  -d '{"running":true,"resolution":"480P"}'
```

When `SLOP_ADMIN_TOKEN` is empty, the PATCH route is intentionally open for local development.

## measure-fn scopes

- `http` — TradJS API work
- `db` — durable queue / timeline / room operations
- `fal` — frame extraction + H3 generation
- `worker` — room generation ticks
- `pumpfun` — chat lease sessions + prompt ingestion

Raw SQL remains tiny and isolated to lease/idempotency boundaries; all application persistence still goes through the same `sqlite-zod-orm` database instance.

## Production boundary

This remains appropriate for one room on one shared SQLite volume. Multiple TradJS web processes are fine; multiple worker processes are protected by both the generation lease and Pump.fun ingress lease.

For a very busy Pump.fun room, the next feature should be **prompt arbitration rather than an unbounded FIFO**: collect chat for each five-second window, rank/vote/merge the strongest requests, then persist one scene directive. The current source-aware schema is designed so that can be added without changing playback or generation.
