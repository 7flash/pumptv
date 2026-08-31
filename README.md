# SLOP TV

One endless AI-generated livestream, one shared canon, many viewers steering what happens next.

This version uses the stack deliberately:

- **TradJS** for SSR, file-system API routes, streaming `Response`s, and the `tradjs/client` frontend.
- **sqlite-zod-orm** for the room record, durable viewer queue, and generated clip timeline.
- **measure-fn** for scoped HTTP / DB / fal / worker traces.
- **fal + MiniMax H3 Max** for video generation.
- **fal FFmpeg Extract Frame** for server-side last-frame continuity.

The important change in v0.3 is that **viewers do not generate clips anymore**. A single authoritative worker owns the room timeline.

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

## Architecture

```text
                         ┌──────── viewer A
                         │
TradJS /api/events ──────┼──────── viewer B
       SSE fanout        │
                         └──────── viewer N
                              │
                              │ POST /api/directives
                              ▼
                      sqlite-zod-orm
                    persistent FIFO queue
                              │
                              ▼
                    authoritative worker
                  renewable SQLite lease
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
```

There is no browser canvas capture and no public `/api/generate` route.

## Project shape

```text
app/
  layout.tsx
  page.tsx
  page.client.tsx             # tradjs/client: playback + chat only
  globals.css
  api/
    directives/route.ts       # enqueue viewer direction
    events/route.ts           # SSE room/timeline stream
    room/route.ts             # admin room settings
    state/route.ts            # initial snapshot / fallback

src/
  worker.ts                    # executable worker entry
  shared/
    contracts.ts
  server/
    db.ts                      # sqlite-zod-orm schemas
    repository.ts              # all durable app state
    lease.ts                   # atomic SQLite generation lease
    worker.ts                  # room loop + buffer policy
    generate.ts                # frame extraction + H3 generation
    prompt.ts                  # continuity/showrunner prompt
    state-stream.ts            # one DB poller, SSE fanout to viewers
    observability.ts           # measure-fn scopes
```

Dependency direction:

```text
tradjs/client ────────> JSON/SSE only

TradJS routes ────────> repository ────────> sqlite-zod-orm
                               ▲
                               │
authoritative worker ─> generate ──────────> fal
          │
          └────────────> SQLite lease
```

## Persistence model

### `rooms`

The room is global server state, not browser state:

- `running`
- `resolution`
- `workerState`: `idle | generating | error`
- `lastError`
- `leaseOwner`
- `leaseUntilMs`
- `heartbeatAtMs`

### `directives`

Viewer instructions use a recoverable state machine:

```text
queued -> generating -> used
             |
             └-- worker crashes --> recovered on next lease
```

If a worker dies before a clip is saved, the claimed directive returns to `queued`. If the clip was saved but the final status write did not happen, recovery sees the clip's `directiveId` and marks the directive `used` instead of repeating it.

### `clips`

Each clip persists:

- fal request ID / video URL
- viewer or autopilot directive + `directiveId`
- episode number
- extracted continuity-frame URL
- resolution / inference timing
- `startsAtMs`
- `durationSeconds`

`startsAtMs` turns the generated clips into a real shared wall-clock timeline. Every browser computes which clip should be playing from server time, so late joiners enter the same moment instead of starting at episode 1.

## Worker / lease behavior

The worker maintains a small future buffer instead of generating as fast as fal allows.

Default target:

```text
SLOP_TARGET_BUFFER_MS=6500
```

With five-second clips, this keeps roughly one clip ahead. When enough future video exists, the worker sleeps. When the buffer drops below target, it tries to acquire the room lease and generate exactly one successor.

The lease is acquired with `BEGIN IMMEDIATE` through `sqlite-zod-orm`'s raw SQL escape hatch and renewed while a long fal request is in flight. If a process dies, its lease expires and another worker can take over.

That means running two worker processes is safe for the single-room MVP: only the lease holder is allowed to claim a directive or generate the next episode.

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

This removes the old CORS-sensitive browser canvas round trip entirely.

## Live delivery

`/api/events` is Server-Sent Events. Each TradJS web process runs **one** state polling loop and fans the resulting snapshot out to all connected viewers, rather than performing a separate SQLite poll per viewer.

The client also keeps a server-clock offset. Every 250 ms it checks the shared timeline locally and advances clips at their scheduled wall-clock boundary. It corrects playback drift when necessary.

Audio begins muted because browsers normally block autoplay with sound. `ENABLE SOUND` is a local viewer action and does not modify the room.

## Room admin

Generation controls are server-side now. The public viewer UI cannot pause the global room or change everyone else's quality.

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
- `worker` — room ticks

The raw SQL lease is intentionally tiny and isolated in `lease.ts`; it still uses the same `sqlite-zod-orm` database instance as the rest of the app.

## Production boundary

This architecture is appropriate for one room on one shared SQLite volume. Multiple TradJS web processes are fine; multiple worker processes are protected by the database lease.

The next scale boundary is **multiple machines without a shared local SQLite file**. At that point keep the same repository/worker contracts but move the lease/queue to a networked coordination store (or move the whole persistence layer to a network database). The client and TradJS route shape do not need to change.
