import { createMeasure } from "measure-fn";
import type {
  Clip,
  Directive,
  LiveProgramState,
  RoomState,
  StreamState,
  WorldState,
} from "../shared/contracts.ts";

const streamMeasure = createMeasure("stream");

export type StreamTransport = "connecting" | "live" | "reconnecting";

export type StreamViewState = {
  timeline: Clip[];
  room: RoomState | null;
  nextDirective: Directive | null;
  program: LiveProgramState | null;
  worldState: WorldState | null;
  replayClipId: number | null;
  transport: StreamTransport;
  error: string | null;
};

type JsonRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

type LongPollPayload = {
  revision?: number;
  state?: StreamState | null;
};

export type StreamStateControllerOptions = {
  state: StreamViewState;
  json: JsonRequest;
  viewerId: () => string;
  initialCatchupPending?: () => boolean;
  completeInitialCatchup?: () => void;
  newViewerHistoryOffset?: number;
  onStateApplied?: (state: StreamState) => void;
  onWinnerDirective?: (state: StreamState) => void;
  baseRetryMs?: number;
  maxRetryMs?: number;
};

export function publishedClipsAt(
  timeline: Clip[],
  serverNowMs: number,
): Clip[] {
  return [...timeline]
    .filter((clip) => Number(clip.startsAtMs || 0) <= serverNowMs)
    .sort((a, b) => a.episode - b.episode || a.id - b.id);
}

export function initialCatchupReplayClipId(
  timeline: Clip[],
  serverNowMs: number,
  historyOffset = 7,
): number | null {
  const published = publishedClipsAt(timeline, serverNowMs);
  if (!published.length) return null;
  const targetIndex = Math.max(
    0,
    published.length - 1 - Math.max(0, historyOffset),
  );
  const target = published[targetIndex] || published[0];
  const latest = published[published.length - 1];
  return target && latest && target.id !== latest.id ? target.id : null;
}

export function streamSnapshotIsStale(
  incomingServerNowMs: number,
  latestAppliedServerNowMs: number,
) {
  return (
    Number.isFinite(incomingServerNowMs) &&
    Number.isFinite(latestAppliedServerNowMs) &&
    latestAppliedServerNowMs > 0 &&
    incomingServerNowMs < latestAppliedServerNowMs
  );
}

export function createStreamStateController(
  options: StreamStateControllerOptions,
) {
  const { state } = options;
  const baseRetryMs = Math.max(100, Number(options.baseRetryMs ?? 850));
  const maxRetryMs = Math.max(baseRetryMs, Number(options.maxRetryMs ?? 8_000));
  const historyOffset = Math.max(
    0,
    Number(options.newViewerHistoryOffset ?? 7),
  );

  let serverOffsetMs = 0;
  let latestAppliedServerNowMs = 0;
  let revision = 0;
  let longPollAbort: AbortController | null = null;

  function nowMs() {
    return Date.now() + serverOffsetMs;
  }

  function apply(snapshot: StreamState, source = "state") {
    const incomingServerNowMs = Number(snapshot.serverNowMs || 0);
    if (streamSnapshotIsStale(incomingServerNowMs, latestAppliedServerNowMs)) {
      streamMeasure.measureSync("Drop stale stream state", () => ({
        source,
        incomingServerNowMs,
        latestAppliedServerNowMs,
        deltaMs: latestAppliedServerNowMs - incomingServerNowMs,
      }));
      return false;
    }

    return streamMeasure.measureSync(
      {
        start: () => `Apply stream state · ${source}`,
        end: (value: {
          source: string;
          serverNowMs: number;
          timeline: number;
          phase: string;
          replayClipId: number | null;
        }) => value,
      },
      () => {
        latestAppliedServerNowMs = Math.max(
          latestAppliedServerNowMs,
          incomingServerNowMs,
        );
        serverOffsetMs = incomingServerNowMs - Date.now();

        state.room = snapshot.room;
        state.timeline = snapshot.timeline;
        state.nextDirective = snapshot.nextDirective;
        state.program = snapshot.program;
        state.worldState = snapshot.worldState;

        options.onWinnerDirective?.(snapshot);
        options.onStateApplied?.(snapshot);

        if (options.initialCatchupPending?.()) {
          const published = publishedClipsAt(
            snapshot.timeline,
            incomingServerNowMs,
          );
          if (published.length) {
            state.replayClipId = initialCatchupReplayClipId(
              snapshot.timeline,
              incomingServerNowMs,
              historyOffset,
            );
            options.completeInitialCatchup?.();
          }
        }

        if (
          state.replayClipId != null &&
          !snapshot.timeline.some((clip) => clip.id === state.replayClipId)
        ) {
          state.replayClipId = null;
        }

        state.error = null;
        return {
          source,
          serverNowMs: incomingServerNowMs,
          timeline: snapshot.timeline.length,
          phase: snapshot.program.phase,
          replayClipId: state.replayClipId,
        };
      },
    );
  }

  async function refresh() {
    try {
      const snapshot = await streamMeasure.measure(
        {
          start: () => "Refresh stream state",
          end: (value: StreamState) => ({
            serverNowMs: value.serverNowMs,
            phase: value.program.phase,
            timeline: value.timeline.length,
          }),
        },
        () => options.json<StreamState>("/api/state", { cache: "no-store" }),
      );
      apply(snapshot, "refresh");
      return true;
    } catch {
      return false;
    }
  }

  function stop() {
    longPollAbort?.abort();
    longPollAbort = null;
  }

  async function startLongPoll() {
    stop();
    const controller = new AbortController();
    longPollAbort = controller;
    let retryMs = baseRetryMs;

    while (!controller.signal.aborted) {
      try {
        const viewer = options.viewerId();
        const response = await streamMeasure.measure(
          {
            start: () => `Long poll stream · rev ${revision}`,
            end: (value: Response) => ({ status: value.status, revision }),
          },
          () =>
            fetch(
              `/api/events?viewerId=${encodeURIComponent(viewer)}&since=${revision}`,
              { cache: "no-store", signal: controller.signal },
            ),
        );
        if (!response.ok)
          throw new Error(`State poll failed: ${response.status}`);

        const payload = (await response.json()) as LongPollPayload;
        if (Number.isSafeInteger(payload.revision))
          revision = Math.max(revision, Number(payload.revision));
        if (payload.state) apply(payload.state, "long-poll");
        else state.error = null;

        retryMs = baseRetryMs;
        state.transport = "live";
      } catch (cause) {
        if (controller.signal.aborted) break;
        state.transport = "reconnecting";
        state.error =
          cause instanceof Error ? cause.message : "state reconnecting";

        const jitter = Math.floor(Math.random() * Math.min(500, retryMs / 3));
        await new Promise((resolve) => setTimeout(resolve, retryMs + jitter));
        retryMs = Math.min(maxRetryMs, Math.round(retryMs * 1.7));
      }
    }
  }

  return {
    apply,
    refresh,
    startLongPoll,
    stop,
    nowMs,
    get revision() {
      return revision;
    },
    get latestAppliedServerNowMs() {
      return latestAppliedServerNowMs;
    },
  };
}
