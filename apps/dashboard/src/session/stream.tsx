import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import {
  GLOBAL_INVALIDATE,
  invalidateEveryTopic,
  invalidateEverything,
  invalidateTopic,
  RES_TOPICS,
  STREAM_TOPICS,
} from "./invalidation.ts";
import { type LiveConnection, LiveProvider } from "./live.tsx";

/**
 * The console's one push socket, and the only place this app opens one.
 *
 * One connection per tab, multiplexed over topics — see
 * `apps/gateway/src/stream/protocol.ts` for the frames. Two things hang off it:
 * `res:*` frames become `invalidateQueries` calls, and the connection's own
 * state becomes the `LiveConnection` that `cadence(ms, topic)` reads to decide
 * whether a topic still needs polling.
 *
 * ## Polling is not turned off; it is out-voted, per topic, per render
 *
 * Nothing here disables a refetch interval. The snapshot reaches React through
 * `useSyncExternalStore`, so a drop re-renders every consumer and each
 * `cadence(ms, topic)` call flips back to `ms` on that render. That *is* the
 * fallback: there is no separate "turn polling back on" path that could fail to
 * run, and no state in which a dead socket leaves a board waiting for a frame
 * that is not coming.
 *
 * ## Degradation is one-way for the life of the tab
 *
 * An upgrade that never completed, or three drops inside a minute, sets the tab
 * to `poll` and leaves it there even if a later socket opens cleanly. A
 * transport that failed that way has not earned being a board's only feed, and
 * the two directions cost differently: staying on the interval wastes a few
 * requests a minute, while wrongly trusting the socket is a console that goes
 * quiet and looks healthy. The socket is still retried underneath, because its
 * invalidations keep arriving and land between polls — belt and braces, never
 * the belt alone.
 */

/** Close code the gateway sends when the admin session behind the socket ends. */
const SESSION_EXPIRED = 4401;

/** First retry delay; doubles per consecutive failure. */
const BACKOFF_BASE_MS = 500;

/**
 * Ceiling on the retry delay. No jitter: this is one connection per operator
 * tab against a self-hosted gateway, so there is no herd to spread, and a
 * deterministic curve is one a test can state exactly.
 */
const BACKOFF_CAP_MS = 30_000;

/** How many drops inside {@link DROP_WINDOW_MS} mean the socket is not worth trusting. */
const DROP_LIMIT = 3;
const DROP_WINDOW_MS = 60_000;

/** Scheduling, injected so a test can drive the backoff instead of waiting it out. */
export type StreamTimer = (run: () => void, ms: number) => () => void;

const realTimer: StreamTimer = (run, ms) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

/**
 * `/api/stream` on the page's own origin.
 *
 * Read off `location` rather than written as a literal so it follows whatever
 * host and scheme the console was served from — the gateway is normally behind
 * a reverse proxy, and a hard-coded origin would be right only on localhost.
 * Assembled by hand rather than through `new URL(path, location.href)`, which
 * throws outright when the document has no base to resolve against.
 */
function streamUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/api/stream`;
}

/** The subset of `ClientFrame` this console sends. It never publishes. */
type ClientFrame = { type: "subscribe"; topic: string; sinceSeq?: number };

type ServerFrame = { type: string; topic?: string; seq?: number };

/**
 * Reads one server frame, or `null` when it is not one.
 *
 * Fields are checked rather than coerced, for the reason `parseClientFrame`
 * gives on the other side: a `seq` that arrived as a string and was coerced
 * would replay from a point nobody asked for, and a wrong replay point is
 * indistinguishable at this end from the gap the protocol promises to report.
 */
function readFrame(data: unknown): ServerFrame | null {
  if (typeof data !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record: Record<string, unknown> = raw as Record<string, unknown>;
  const { type, topic, seq } = record;
  if (typeof type !== "string") return null;
  if (topic !== undefined && typeof topic !== "string") return null;
  if (seq !== undefined && typeof seq !== "number") return null;
  return {
    type,
    ...(typeof topic === "string" ? { topic } : {}),
    ...(typeof seq === "number" ? { seq } : {}),
  };
}

type StreamClient = {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => LiveConnection;
  /** Opens the socket. The returned function closes it and cancels any retry. */
  start: () => () => void;
};

type StreamClientDeps = {
  client: QueryClient;
  timer: StreamTimer;
  now: () => number;
  url: () => string;
};

function createStreamClient(deps: StreamClientDeps): StreamClient {
  const listeners = new Set<() => void>();
  /** Topics the server acknowledged. A topic it refused is not one of them. */
  const acked = new Set<string>();
  /** Highest `seq` seen per `stream:*` topic, which is what replay resumes from. */
  const seen = new Map<string, number>();

  let drops: number[] = [];
  let socket: WebSocket | null = null;
  let running = false;
  let opened = false;
  /** Whether any socket ever opened — what distinguishes a reconnect from a first connect. */
  let everOpened = false;
  let degraded = false;
  let expired = false;
  let attempt = 0;
  let cancelRetry: (() => void) | null = null;
  let current: LiveConnection = { status: "poll", pushed: () => false };

  function publish(): void {
    const status: LiveConnection["status"] = expired
      ? // Not "poll": the session behind every REST call is gone too, so
        // nothing is refreshing. The mark lamp answers "is the gateway up",
        // which is a different question and must not be answered twice.
        "offline"
      : opened && !degraded
        ? "push"
        : "poll";
    const pushing = status === "push";
    // A fresh object per transition, and only per transition: `snapshot` is read
    // during render by `useSyncExternalStore`, which bails out on identity.
    current = { status, pushed: (topic) => pushing && acked.has(topic) };
    for (const listener of listeners) listener();
  }

  function send(frame: ClientFrame): void {
    socket?.send(JSON.stringify(frame));
  }

  function subscribeAll(): void {
    for (const topic of RES_TOPICS) send({ type: "subscribe", topic });
    for (const topic of STREAM_TOPICS) {
      const last = seen.get(topic);
      // `sinceSeq` is the last frame this client *saw*, which is what the ring
      // measures a gap against. Omitted on a first subscribe: there is no
      // history to resume and asking for one would only invite a `gap`.
      send(
        last === undefined
          ? { type: "subscribe", topic }
          : { type: "subscribe", topic, sinceSeq: last },
      );
    }
  }

  function handleOpen(): void {
    opened = true;
    attempt = 0;
    acked.clear();
    if (everOpened) {
      // Before a single frame goes out, and the order is the point. Whatever
      // changed while the socket was down was never announced, so the cache is
      // stale *now*; resubscribing first would leave a window in which the
      // console is being pushed fresh frames on top of stale data and looks
      // perfectly healthy doing it.
      invalidateEveryTopic(deps.client);
    }
    everOpened = true;
    subscribeAll();
    publish();
  }

  function handleMessage(event: MessageEvent): void {
    const frame = readFrame(event.data);
    if (frame === null) return;
    const { topic } = frame;

    if (frame.type === "ack") {
      // Acked, not sent: a topic is only pushed once the server says it holds
      // it. `stream:console` on an installation whose log capture is `none` is
      // answered `error` instead, and that board must keep polling.
      if (topic !== undefined) {
        acked.add(topic);
        publish();
      }
      return;
    }

    if (frame.type === "error") {
      if (topic !== undefined && acked.delete(topic)) publish();
      return;
    }

    if (topic === undefined) return;

    if (frame.type === "gap") {
      // Never stitch a hole. The ring told us what it no longer has, so the
      // panel re-reads the resource whole, which is the same fetch a poll does.
      if (frame.seq !== undefined) seen.set(topic, frame.seq);
      invalidateTopic(deps.client, topic);
      return;
    }

    if (frame.type !== "event") return;
    if (topic === GLOBAL_INVALIDATE) {
      invalidateEverything(deps.client);
      return;
    }
    if (frame.seq !== undefined) seen.set(topic, frame.seq);
    invalidateTopic(deps.client, topic);
  }

  function handleClose(event: CloseEvent): void {
    const wasOpen = opened;
    opened = false;
    socket = null;
    acked.clear();
    // Our own close, on unmount. Nothing to report and nothing to retry.
    if (!running) return;

    if (event.code === SESSION_EXPIRED) {
      expired = true;
      running = false;
      publish();
      // Surfaced through the path the console already has for an expired
      // session rather than a second one: every active query refetches, the
      // first `AUTH` reaches the query cache's `onError`, and that sends the
      // router to the login screen.
      invalidateEverything(deps.client);
      return;
    }

    if (!wasOpen) {
      // The upgrade itself never completed — a proxy that ate `Upgrade`, most
      // likely. One is enough: it will not succeed by being asked faster.
      degraded = true;
    } else {
      const at = deps.now();
      drops = [...drops.filter((seenAt) => seenAt > at - DROP_WINDOW_MS), at];
      if (drops.length >= DROP_LIMIT) degraded = true;
    }
    publish();
    retry();
  }

  function retry(): void {
    const ms = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
    attempt += 1;
    cancelRetry = deps.timer(() => {
      cancelRetry = null;
      if (running) connect();
    }, ms);
  }

  function connect(): void {
    // Read off the global at call time so a test's stub is the one constructed.
    const ws = new WebSocket(deps.url());
    socket = ws;
    ws.addEventListener("open", handleOpen);
    ws.addEventListener("message", handleMessage);
    ws.addEventListener("close", handleClose);
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => current,
    start() {
      running = true;
      connect();
      return () => {
        running = false;
        cancelRetry?.();
        cancelRetry = null;
        const live = socket;
        socket = null;
        opened = false;
        live?.close();
      };
    },
  };
}

const StreamContext = createContext<LiveConnection | null>(null);

/**
 * What a component sees with no socket above it: polling, which is exactly what
 * is happening. Not `offline` — a console refreshing on its intervals is not
 * offline, and saying so would put a false alarm on the chassis.
 */
const NO_SOCKET: LiveConnection = { status: "poll", pushed: () => false };

export type StreamProviderProps = {
  children: ReactNode;
  /**
   * Off lets a harness mount the whole shell without a socket. It defaults on,
   * because the app wants the socket and a default of "off" would be a feature
   * that ships disabled the first time someone forgets a prop.
   */
  enabled?: boolean;
  timer?: StreamTimer;
  /** Injected so the drop window is a value a test can cross rather than wait out. */
  now?: () => number;
  url?: () => string;
};

export function StreamProvider({
  children,
  enabled = true,
  timer = realTimer,
  now = Date.now,
  url = streamUrl,
}: StreamProviderProps) {
  const queryClient = useQueryClient();
  // Created once and never recreated: it owns a socket, and a client rebuilt on
  // a re-render would be a second connection per tab.
  const [client] = useState(() => createStreamClient({ client: queryClient, timer, now, url }));

  useEffect(() => {
    if (!enabled) return undefined;
    return client.start();
  }, [client, enabled]);

  const connection = useSyncExternalStore(client.subscribe, client.snapshot, client.snapshot);
  return <StreamContext value={connection}>{children}</StreamContext>;
}

export function useStreamConnection(): LiveConnection {
  return use(StreamContext) ?? NO_SOCKET;
}

/**
 * `LiveProvider` fed by the socket above it.
 *
 * A component of its own because the reading has to happen *below* the
 * `StreamProvider` that supplies it, and the nesting is load-bearing in a way
 * that fails silently when it is wrong: with the two the other way round this
 * reads the no-socket default, every `cadence(ms, topic)` returns `ms`, and the
 * console polls forever while every test stays green. `test/session/live.test.tsx`
 * carries the same warning about the SDK's context object, for the same reason.
 */
export function StreamedLiveProvider({ children }: { children: ReactNode }) {
  const connection = useStreamConnection();
  return <LiveProvider connection={connection}>{children}</LiveProvider>;
}
