# SLOP TV

An infinite, interactive AI-generated livestream. Viewers type what should happen next; each directive is persisted, consumed in FIFO order, and used to steer the next MiniMax H3 Max clip on fal. The browser captures the last frame of the current clip and sends it back as the first-frame anchor for the next generation.

This version is intentionally structured around:

- **TradJS** for file-system routes, SSR shell, API routes, and `tradjs/client` browser rendering.
- **sqlite-zod-orm** for the durable directive queue and generated clip timeline.
- **measure-fn** for scoped timing/error traces at HTTP, database, fal upload, and fal generation boundaries.

## Runtime

This is a **Bun-first** app. TradJS and sqlite-zod-orm both target Bun.

```bash
cp .env.example .env
# set FAL_KEY
bun install
bun run dev
```

Open http://localhost:3000.

## Project shape

```text
app/
  layout.tsx                 # TradJS root layout
  page.tsx                   # server-rendered mount shell
  page.client.tsx            # tradjs/client player + chat state machine
  globals.css
  api/
    generate/route.ts        # generate next H3 Max clip
    directives/route.ts      # persist viewer directives
    state/route.ts           # restore current timeline + queue

src/
  shared/contracts.ts        # server/client DTOs only
  server/
    db.ts                    # sqlite-zod-orm schema + DB boot
    repository.ts            # all persistence operations
    observability.ts         # measure-fn scopes/config
    prompt.ts                # continuity prompt construction
    generate.ts              # fal orchestration
```

The important dependency direction is:

```text
TradJS route -> server service -> repository -> sqlite-zod-orm
                         \\-> fal

tradjs/client -> JSON API only
```

No database or fal implementation code is imported into the browser.

## Persistence model

`sqlite-zod-orm` owns two tables and auto-creates/additively migrates them from Zod schemas:

### `directives`

- `text`
- `status`: `queued | used`
- `usedEpisode`
- automatic timestamps

### `clips`

- fal request ID and video URL
- expanded prompt + inference duration
- viewer/autopilot directive
- episode number
- whether a continuity frame was used
- resolution
- automatic timestamps

On refresh, `/api/state` restores the most recent clip and recent chat history, then generation continues from that clip instead of creating a new universe.

## Generation loop

```text
play current clip
      |
      +--> browser captures final frame
                    |
                    v
            POST /api/generate
                    |
       server reads oldest queued directive
          or falls back to autopilot
                    |
                    v
            H3 Max image-to-video
                    |
                    v
              persist new clip
                    |
                    v
               buffer + play
                    |
                    +---- repeat
```

The opening generation uses text-to-video. Every later generation uses image-to-video with the captured final frame.

## measure-fn structure

The code uses scoped measures rather than hand-written timers:

- `http`: API request work
- `db`: queue/timeline reads and writes
- `fal`: continuity-frame uploads and H3 generation

`measure-fn` catches/logs errors and returns `null`, so boundaries explicitly check measured results before continuing.

Set `MEASURE_TIMESTAMPS=0` if you do not want timestamps in local traces.

## Important MVP limitation

This is now durable, but generation is still initiated by the watching browser. For a public shared livestream, move `generateNextClip()` behind one authoritative room worker/lease. Otherwise two viewers could race and generate two clips for the same next episode.

The next production step should be:

```text
many viewers
    |
    v
TradJS chat API -> SQLite directives
                      |
                      v
             authoritative room worker
                      |
             generate one next clip
                      |
                      v
              clips / stream manifest
                      |
        SSE/WebSocket/HLS broadcast
```

SQLite remains reasonable for one room / one writer. If you introduce multiple generator processes, move the queue/lease to a datastore designed for cross-process coordination.

## CORS note

The current continuity mechanism captures the final frame in a browser canvas. fal media therefore needs usable CORS headers. If that becomes unreliable in production, extract the final frame server-side (e.g. ffmpeg) or copy generated videos into your own CORS-controlled object storage.
