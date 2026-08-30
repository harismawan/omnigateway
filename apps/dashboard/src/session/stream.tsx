import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useRef,
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
import type { ChannelTransport } from "./live.tsx";
import { type LiveConnection, LiveProvider } from "./live.tsx";

/**
 * The console's one push socket, and the only place this app opens one.
 *
 * One connection per tab, multiplexed over topics — see
 * `apps/gateway/src/stream/protocol.ts` for the frames. Three things hang off
 * it: `res:*` frames become `invalidateQueries` calls, `stream:*` frames are
 * handed to whoever is rendering that topic, and the connection's own state
 * becomes the `LiveConnection` that `cadence(ms, topic)` reads to decide
 * whether a topic still needs polling.
 *
 * ## Two payload classes, and the split is deliberate
 *
 * A `res:*` frame says a resource changed and carries nothing, so both push and
 * poll end in the same fetch and cannot disagree. A `stream:*` frame carries
 * the thing itself, because a log has no resource to re-read — a delta is not
 * addressable and refetching a whole window per line is the cost the ring
 * exists to avoid. That second class is only safe because it is sequenced: the
 * ring answers `gap` rather than handing back a partial replay, and a `gap`
 * drops the subscriber back onto the REST read. Nothing here ever stitches.
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

/**
 * The topics this client subscribes to at open and never gives up, as a set for
 * the per-frame membership test in `wants`.
 */
const TABLE_TOPICS: ReadonlySet<string> = new Set([...RES_TOPICS, ...STREAM_TOPICS]);

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

/**
 * The subset of `ClientFrame` this console sends.
 *
 * It publishes on plugin topics and nowhere else. `res:*` and `stream:*` are
 * host-owned and one-directional — the gateway answers a `send` on either with
 * `topic is read-only` — so the only writer here is a plugin panel talking to
 * its own plugin.
 */
type ClientFrame =
  | { type: "subscribe"; topic: string; sinceSeq?: number }
  | { type: "unsubscribe"; topic: string }
  | { type: "send"; topic: string; payload: unknown };

type ServerFrame = { type: string; topic?: string; seq?: number; payload?: unknown };

/**
 * What a `stream:*` subscriber is handed.
 *
 * The two answers the ring gives, and there is no third: either the frames that
 * were missed, or an explicit admission that they are gone. A subscriber that
 * was handed `gap` must drop whatever it accumulated rather than append past
 * it — `apps/gateway/src/stream/ring.ts` carries the same sentence from the
 * other end.
 *
 * `payload` stays `unknown` here. This module multiplexes topics and knows what
 * none of them mean; the panel that subscribed is the one place that can say
 * what a well-formed frame on its own topic looks like.
 */
export type TopicMessage =
  | { kind: "frame"; payload: unknown }
  | { kind: "gap" }
  /**
   * The three status arms, which exist for the topics this client holds on
   * request rather than from the compile-time table.
   *
   * A plugin topic can be *refused* — `authorised` gives one to an admin and to
   * nobody else — and a panel that was handed silence could not tell that from
   * a channel that is merely quiet. That distinction is the whole reason a
   * subscriber gets told anything but frames.
   *
   * They are delivered by topic, so a `stream:*` reader sees them too.
   * `ConsoleBoard` acts on `frame` and `gap` and ignores the rest, which is
   * what keeps them additive for the one caller that predates them.
   */
  | { kind: "open" }
  | { kind: "refused" }
  | { kind: "closed" };

/**
 * Reads one server frame, or `null` when it is not one.
 *
 * Fields are checked rather than coerced, for the reason `parseClientFrame`
 * gives on the other side: a `seq` that arrived as a string and was coerced
 * would replay from a point nobody asked for, and a wrong replay point is
 * indistinguishable at this end from the gap the protocol promises to report.
 *
 * `payload` is the exception and is passed through untouched, because its shape
 * is per-topic. Presence is what is recorded — `"payload" in record` rather
 * than `payload !== undefined` — so a topic whose frame legitimately carries
 * `null` stays distinguishable from a `res:*` frame that carries nothing.
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
    ...("payload" in record ? { payload: record.payload } : {}),
  };
}

/** Hands one topic's frames to a mounted component. Returns an unsubscribe. */
export type TopicSubscribe = (
  topic: string,
  listener: (message: TopicMessage) => void,
) => () => void;

type StreamClient = {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => LiveConnection;
  /** Opens the socket. The returned function closes it and cancels any retry. */
  start: () => () => void;
  onStream: TopicSubscribe;
  /**
   * Holds a topic that is not in the compile-time table, for as long as the
   * returned function has not been called.
   *
   * `onStream` registers a reader for a topic the client already subscribed to
   * at open. This one *is* the subscription: it sends the frame, refcounts the
   * holders, replays on reconnect and gives the topic up when the last holder
   * leaves. Wire subscription and local reader are one call rather than two
   * because two lifetimes kept in step by convention drift into a topic that is
   * subscribed and rendered by nobody, and that state is silent.
   */
  hold: TopicSubscribe;
  /** Publishes on a plugin topic. `false` when the topic is not open. */
  publish: (topic: string, payload: unknown) => boolean;
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
  /** Who is rendering which `stream:*` topic. Empty for a topic nobody has mounted. */
  const readers = new Map<string, Set<(message: TopicMessage) => void>>();
  /**
   * Topics held on request, and how many holders each has.
   *
   * A count rather than a set because two panels may render the same channel —
   * a list and a detail view of one session — and the first to unmount must not
   * take the subscription out from under the second.
   */
  const held = new Map<string, number>();

  /**
   * Whether this client currently wants a topic at all.
   *
   * The compile-time table plus whatever is held right now. Asked of an
   * incoming `ack`, because an ack is not only the answer to a subscribe: the
   * gateway answers an unsubscribe with one too, on the same topic.
   */
  const wants = (topic: string): boolean => held.has(topic) || TABLE_TOPICS.has(topic);

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

  /**
   * Hands a message to whoever is rendering the topic, and says whether anyone
   * was. The copy is not defensive tidiness: a listener may unsubscribe from
   * inside its own handler when a panel unmounts on the frame it just received.
   */
  function deliver(topic: string, message: TopicMessage): boolean {
    const listeners = readers.get(topic);
    if (listeners === undefined || listeners.size === 0) return false;
    for (const listener of [...listeners]) listener(message);
    return true;
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
    // Held topics are not in the table above, so nothing else would put them
    // back after a drop. Never with `sinceSeq`: a plugin frame carries no `seq`
    // and has no ring behind it, so asking to resume from one would invite a
    // `gap` for a class that cannot produce one.
    for (const topic of held.keys()) send({ type: "subscribe", topic });
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
      if (topic !== undefined && wants(topic)) {
        // Gated on still wanting the topic, because the gateway acks an
        // *unsubscribe* on the same topic with the same frame. Ungated, the
        // last holder leaving would clear `acked` and the ack for its own
        // departure would put it straight back — leaving `pushed(topic)` true
        // for a topic nothing is subscribed to, so `cadence(ms, topic)` tells a
        // query to stop polling in favour of a push that cannot arrive.
        acked.add(topic);
        deliver(topic, { kind: "open" });
        publish();
      }
      return;
    }

    if (frame.type === "error") {
      if (topic !== undefined) {
        // Delivered whether or not the topic was acked, because the interesting
        // case is the one where it never was: a refused subscribe is what a
        // viewer gets for every plugin topic, and it is the only signal that
        // separates "not permitted" from "nothing has happened yet".
        if (acked.delete(topic)) publish();
        deliver(topic, { kind: "refused" });
      }
      return;
    }

    if (topic === undefined) return;

    if (frame.type === "gap") {
      // Never stitch a hole. The ring told us what it no longer has, so the
      // panel re-reads the resource whole, which is the same fetch a poll does.
      //
      // Both halves run, and neither is the other's fallback: the reader is
      // told to drop what it accumulated, *and* the cache is marked stale so
      // the read that replaces it actually happens. A reader that only dropped
      // its lines would show a shorter console and call it current.
      if (frame.seq !== undefined) seen.set(topic, frame.seq);
      deliver(topic, { kind: "gap" });
      invalidateTopic(deps.client, topic);
      return;
    }

    if (frame.type !== "event") return;
    if (topic === GLOBAL_INVALIDATE) {
      invalidateEverything(deps.client);
      return;
    }
    if (frame.seq !== undefined) {
      // A jump in the sequence is a hole, and the client is the only thing that
      // can see it. The ring answers `gap` when a *reconnecting* subscriber has
      // fallen off the back of it — but a frame dropped in flight, because the
      // server's per-connection queue overflowed under backpressure, leaves the
      // sequence discontinuous with no frame to say so. Appending across it is
      // exactly the silent skip this class exists to prevent, so it is treated
      // as the gap it is.
      const previous = seen.get(topic);
      seen.set(topic, frame.seq);
      if (previous !== undefined && frame.seq > previous + 1) {
        deliver(topic, { kind: "gap" });
        invalidateTopic(deps.client, topic);
        return;
      }
    }

    // A frame that carries its own content goes to whoever is rendering it, and
    // that is the whole point of the `stream:*` class: no refetch, and the ring
    // rather than the interval decides what was missed.
    //
    // With nobody mounted there is no one to hand it to, and the lines in it are
    // gone for good — so the cache is marked stale instead and the board that
    // mounts next re-reads the window rather than resuming inside one it never
    // saw. That costs nothing until then: react-query's default `refetchType`
    // is `"active"`, and an unmounted query has no observer to refetch.
    if (frame.payload !== undefined && deliver(topic, { kind: "frame", payload: frame.payload })) {
      return;
    }
    invalidateTopic(deps.client, topic);
  }

  function handleClose(event: CloseEvent): void {
    const wasOpen = opened;
    opened = false;
    socket = null;
    acked.clear();
    // Every subscription went with the socket, so every holder is told before
    // anything else happens. It resubscribes on reconnect and `open` follows —
    // but until it does, a panel that was told nothing would go on rendering a
    // live channel while nothing was arriving on it.
    for (const topic of [...readers.keys()]) deliver(topic, { kind: "closed" });
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

  /**
   * Registers a reader for a topic, and returns its removal.
   *
   * Shared by `onStream` and `hold` rather than one calling the other through
   * `this`, which a caller destructuring the client would break — and the
   * console does destructure it.
   */
  function addReader(topic: string, listener: (message: TopicMessage) => void): () => void {
    const listeners = readers.get(topic) ?? new Set<(message: TopicMessage) => void>();
    readers.set(topic, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      // Dropped rather than left empty, because `deliver` reads emptiness as
      // "nobody is rendering this" and an empty set left behind would answer
      // the same — but a leaked set per topic per remount would not.
      if (listeners.size === 0) readers.delete(topic);
    };
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => current,
    hold(topic, listener) {
      const release = addReader(topic, listener);
      const holders = (held.get(topic) ?? 0) + 1;
      held.set(topic, holders);
      // Only the first holder subscribes. A second one asking again would have
      // the gateway ack a topic it already holds, and — more to the point —
      // would make "release on last" and "release on any" indistinguishable.
      if (holders === 1 && opened) send({ type: "subscribe", topic });
      // The ordinary case rather than the exotic one: the socket opens with the
      // shell and a panel mounts on navigation, so the ack has usually been and
      // gone. A status delivered only as an event would leave that panel
      // reading `idle` forever, with frames arriving underneath it.
      if (acked.has(topic)) listener({ kind: "open" });
      // Called once by React, which calls an effect's cleanup exactly once — but
      // `ChannelTransport.subscribe` is exported to plugin authors, who call it
      // by hand. A second call would drop the count to zero again and send an
      // `unsubscribe` out from under whoever holds the topic now, firing the
      // plugin's `onClose` for a session that is still live.
      let released = false;
      return () => {
        if (released) return;
        released = true;
        release();
        const remaining = (held.get(topic) ?? 1) - 1;
        if (remaining > 0) {
          held.set(topic, remaining);
          return;
        }
        held.delete(topic);
        // Cleared here as well as gated at the ack, and both are needed: this
        // makes `cadence` flip back to its interval on the spot rather than at
        // whatever later point the socket happens to drop.
        if (acked.delete(topic)) publish();
        // Told rather than left implicit: the gateway fires the plugin's
        // `onClose` for this connection off exactly this frame, so a panel that
        // unmounted without one leaves the plugin holding a session it will
        // never be told to drop.
        if (opened) send({ type: "unsubscribe", topic });
      };
    },
    publish(topic, payload) {
      // Asked of `acked` rather than of `held`, because the gateway refuses a
      // send from a connection it has not acked the subscription for — and
      // answers that refusal with an `error` on the topic, which this client
      // reads as `refused`. A panel that sent early would turn its own timing
      // bug into a permission failure it then reports to the operator.
      if (!opened || !acked.has(topic)) return false;
      send({ type: "send", topic, payload });
      return true;
    },
    onStream: addReader,
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
 * How a panel reaches its topic's frames.
 *
 * A second context rather than a field on `LiveConnection`, because that object
 * is rebuilt on every transition to defeat `useSyncExternalStore`'s identity
 * bail-out — a subscribe function carried on it would change identity per
 * transition and re-subscribe every reader on every drop.
 */
const TopicContext = createContext<TopicSubscribe | null>(null);

/**
 * The plugin-channel half of the same idea, kept separate from `TopicContext`
 * because it is handed to the SDK rather than consumed here, and because the
 * two are read by different code: a console board holds a declared topic, a
 * plugin panel holds one that only exists at runtime.
 */
const ChannelContext = createContext<ChannelTransport | null>(null);

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
  // Built once, from methods that never change identity. A transport rebuilt
  // per render would re-subscribe every panel on every render of the shell.
  const [transport] = useState<ChannelTransport>(() => ({
    subscribe: (topic, listener) =>
      client.hold(topic, (message) => {
        // `gap` is the one arm of `TopicMessage` the SDK does not carry, and
        // omitting it is sound rather than convenient: a gap is reported
        // against a `seq`, plugin frames carry none, and there is no ring
        // behind a plugin topic for a subscriber to fall off the back of. A
        // panel cannot reach this, so exporting the arm would be a case every
        // plugin author writes and none runs.
        //
        // Reported as `closed` rather than dropped, all the same. If a plugin
        // topic ever does gain a ring, a silent `return` here is exactly the
        // skipped hole the `stream:*` class exists to make visible — where
        // `closed` tells the panel to stop trusting what it has, which is the
        // safe reading of a message this build should never see.
        if (message.kind === "gap") {
          listener({ kind: "closed" });
          return;
        }
        listener(message);
      }),
    send: client.publish,
  }));

  useEffect(() => {
    if (!enabled) return undefined;
    return client.start();
  }, [client, enabled]);

  const connection = useSyncExternalStore(client.subscribe, client.snapshot, client.snapshot);
  return (
    <StreamContext value={connection}>
      <TopicContext value={client.onStream}>
        <ChannelContext value={transport}>{children}</ChannelContext>
      </TopicContext>
    </StreamContext>
  );
}

export function useStreamConnection(): LiveConnection {
  return use(StreamContext) ?? NO_SOCKET;
}

/**
 * Receives one `stream:*` topic's frames for as long as the caller is mounted.
 *
 * With no socket above it this subscribes to nothing and the caller sees no
 * frames — which is the state every board test in this suite runs in, and the
 * state a degraded tab runs in. A panel is therefore only ever allowed to treat
 * push as an *addition* to what it reads over REST; one that rendered frames
 * alone would show an empty screen there, and `test/helpers/render.tsx` says
 * why that default is worth keeping.
 *
 * `onMessage` is read through a ref rather than depended on, so a panel may pass
 * a fresh closure per render — which it must, since the filter and page size a
 * frame has to be judged against are ordinary component state.
 */
export function useStreamTopic(topic: string, onMessage: (message: TopicMessage) => void): void {
  const subscribe = use(TopicContext);
  const latest = useRef(onMessage);

  useEffect(() => {
    latest.current = onMessage;
  });

  useEffect(() => {
    if (subscribe === null) return undefined;
    return subscribe(topic, (message) => latest.current(message));
  }, [subscribe, topic]);
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
  const channels = use(ChannelContext);
  return (
    <LiveProvider connection={connection} {...(channels === null ? {} : { channels })}>
      {children}
    </LiveProvider>
  );
}
