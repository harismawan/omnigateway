import { type Logger, noopLogger } from "@omni/ir";
import type { Clock, Schedule } from "./coalescer.ts";
import type { ServerFrame } from "./protocol.ts";

/**
 * Who is on the other end of a connection.
 *
 * The `machine` arm is declared and currently unreachable: it belongs to the
 * remote-control plugin's `routes:machine` capability and its
 * `plugin_machine_tokens` table, and that design is still a draft. Declaring it
 * here costs nothing and is what lets the machine arm land later without the
 * registry learning a second shape.
 */
export type Principal = { kind: "admin" } | { kind: "machine"; tokenId: string; pluginId: string };

/**
 * A verified principal plus a way to ask whether it is still verified.
 *
 * Two fields because they are two concerns. `principal` decides which topics a
 * connection may subscribe to; `revalidate` decides whether it may still be
 * connected at all.
 *
 * `revalidate` is a thunk rather than a token or a `Request`, which is the
 * whole point: the registry never learns what a cookie is. The admin arm closes
 * over a session token at upgrade, and the machine arm will close over a token
 * id, and neither becomes a field here that a later reader could be tempted to
 * log.
 */
export type Credential = {
  principal: Principal;
  revalidate: () => Promise<boolean>;
};

/** The slice of a socket this registry uses. Keeps Elysia out of the module. */
export type Socket = {
  /**
   * Hands a frame to the socket.
   *
   * Bun's status is three-valued and the distinction is load-bearing: a byte
   * count means it went out, **`-1` means uWS buffered it and will deliver it**,
   * and only `0` means it was dropped. Reading `-1` as "did not go out" and
   * retrying is an amplification loop — uWS delivers the frame *and* the retry
   * arrives, forever, never advancing past the head of the queue.
   */
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
  ping?(): unknown;
  /**
   * How many bytes uWS is holding for this socket, when it can say.
   *
   * This, not the send status, is the backpressure signal. uWS's buffer is
   * unbounded; the queue in this module is bounded and counts what it drops, so
   * once uWS is holding a lot the right move is to stop feeding it and let the
   * visible, counted queue absorb the burst instead.
   */
  getBufferedAmount?(): number;
};

export type RegistryStats = {
  connections: number;
  /** Frames discarded because a connection's queue was full. */
  dropped: number;
  /** Frames currently waiting across every connection. */
  queued: number;
};

/**
 * How many undelivered frames one connection holds before it starts dropping.
 *
 * The same size and the same reasoning as the plugin event bus: sized for a
 * burst rather than a backlog. A client that cannot keep up with this is not
 * going to be rescued by a larger number, and the larger number is how one slow
 * browser tab turns into an out-of-memory kill of the gateway.
 */
const DEFAULT_QUEUE_CAPACITY = 1_000;

/**
 * Most topics one connection may hold.
 *
 * Topic *names* are bounded by the parser; the count was not, so an
 * authenticated admin could grow the topic index without limit by subscribing
 * to distinct `res:<random>` names. Reclaimed on disconnect and admin-only, so
 * this is a cap rather than a defence — but an unbounded structure reachable
 * from a request is worth closing whatever the severity.
 */
const MAX_TOPICS_PER_CONNECTION = 256;

/**
 * How much uWS may be holding before this module stops handing it frames.
 *
 * Below the default `backpressureLimit`, deliberately. The point is not to
 * prevent uWS buffering — it is to keep the overflow inside the bounded queue
 * here, which drops oldest and counts it, rather than in uWS's unbounded buffer,
 * which does neither.
 */
const HIGH_WATER_BYTES = 512 * 1024;

/** Server ping interval. Also when the principal is re-verified. */
const HEARTBEAT_MS = 20_000;

/** A connection that has not ponged within this is gone, whatever it thinks. */
const PONG_DEADLINE_MS = 60_000;

/**
 * How long a revalidation may be in flight before the next tick gives up on it.
 *
 * Without this, a `verify` that never settles leaves the connection's `checking`
 * flag set for the life of the socket, and the "a socket must not outlive its
 * session" guarantee silently stops applying to it — the one connection whose
 * store call is wedged is the one that stops being re-verified.
 */
const CHECK_STALE_MS = 60_000;

/**
 * Closed when a connection's principal stopped being valid.
 *
 * In the RFC 6455 private range, and load-bearing on the client: `4401` alone
 * means "authenticate again, do not reconnect". Any other code — including a
 * plain `1008` — puts the client into its ordinary reconnect-with-backoff loop
 * against a gateway that will refuse it every time.
 */
export const CLOSE_UNAUTHENTICATED = 4401;

type Connection = {
  id: string;
  socket: Socket;
  credential: Credential;
  topics: Set<string>;
  queue: ServerFrame[];
  lastPongAt: number;
  /** Set while a revalidation is in flight, so a slow verify cannot stack. */
  checking: boolean;
  /** When the in-flight check started, so one that never settles can be abandoned. */
  checkingSince: number;
  /** Bumped when a check is abandoned, so its late answer is ignored. */
  generation: number;
};

export type SocketRegistry = {
  add(id: string, socket: Socket, credential: Credential): void;
  remove(id: string): void;
  /** Records a subscription. The caller has already authorised it. */
  subscribe(id: string, topic: string): void;
  unsubscribe(id: string, topic: string): void;
  topics(id: string): readonly string[];
  /**
   * Whether one connection holds one topic.
   *
   * Exists because the channel path asked `topics(id).includes(topic)` on every
   * inbound *and* outbound frame, which allocates the whole topic array per
   * frame — on a keystroke-latency channel, per keystroke.
   */
  has(id: string, topic: string): boolean;
  principal(id: string): Principal | null;
  /** Notes a pong, so the deadline sweep can tell a live socket from a wedged one. */
  pong(id: string): void;
  /** Retries a backpressured connection. Called from the socket's drain event. */
  drain(id: string): void;
  publish(topic: string, frame: ServerFrame): void;
  sendTo(id: string, frame: ServerFrame): void;
  closeAll(code: number, reason: string): void;
  stats(): RegistryStats;
  /** Cancels the heartbeat. A tick outliving the registry is a timer leak. */
  stop(): void;
};

export type RegistryDeps = {
  /**
   * Told that a connection is losing the topics it held, before it loses them.
   *
   * Exists for closes this module starts rather than ones the client starts.
   * The route can announce a client-initiated close itself, because Bun hands it
   * the event while the connection is still intact; a 4401 or a shutdown has no
   * such moment, so the announcement has to happen at the point of decision.
   */
  onDetach?: (connectionId: string, topics: readonly string[]) => void;
  logger?: Logger;
  now?: Clock;
  schedule?: Schedule;
  queueCapacity?: number;
  heartbeatMs?: number;
  pongDeadlineMs?: number;
  /** How long an unsettled revalidation is waited on before it is abandoned. */
  checkStaleMs?: number;
};

export function createSocketRegistry(deps: RegistryDeps = {}): SocketRegistry {
  const logger = deps.logger ?? noopLogger;
  const onDetach = deps.onDetach;
  const now = deps.now ?? Date.now;
  const schedule =
    deps.schedule ??
    ((run: () => void, ms: number) => {
      const timer = setTimeout(run, ms);
      // Unref'd like every other background timer here. `createApp` builds a
      // registry whether or not anything ever connects, so a referenced
      // heartbeat would hold the process open in every test that builds an app
      // and never opens a socket — and hold a shutdown open besides.
      timer.unref?.();
      return () => clearTimeout(timer);
    });
  const capacity = deps.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const pongDeadlineMs = deps.pongDeadlineMs ?? PONG_DEADLINE_MS;
  const checkStaleMs = deps.checkStaleMs ?? CHECK_STALE_MS;

  const connections = new Map<string, Connection>();
  /** topic → connection ids. The index exists so a publish is not a full scan. */
  const index = new Map<string, Set<string>>();

  let dropped = 0;
  let live = true;
  let cancelTick: (() => void) | undefined;

  /**
   * Reported once per tick rather than once per drop.
   *
   * A full queue means many drops in quick succession, and a line each would
   * turn a slow-consumer problem into a log problem on top of it.
   */
  let droppedSinceReport = 0;

  /**
   * Pushes what it can and queues what it cannot.
   *
   * Two things decide when to stop, and they are not the same thing.
   *
   * **Backpressure is `getBufferedAmount()`, not the send status.** uWS buffers
   * without bound; this queue is bounded and counts what it drops. So once uWS
   * is holding more than the high-water mark, handing it more frames trades a
   * visible, counted drop for an invisible, unbounded one. Stopping here is what
   * keeps the burst inside the structure that reports it.
   *
   * **Only a status of `0` means the frame did not go out.** A byte count means
   * it was written; `-1` means uWS took it and will deliver it. Treating `-1` as
   * a failure and retrying is an amplification loop: the frame is delivered by
   * uWS *and* re-sent on every drain, never advancing past the head. Measured
   * before this was fixed: one sequence number delivered 291 times, 316
   * consecutive frames never delivered at all, on a topic whose entire contract
   * is a monotonic sequence.
   */
  const flush = (connection: Connection): void => {
    while (connection.queue.length > 0) {
      if ((connection.socket.getBufferedAmount?.() ?? 0) >= HIGH_WATER_BYTES) return;

      const frame = connection.queue[0];
      if (frame === undefined) break;
      let status: unknown;
      try {
        status = connection.socket.send(JSON.stringify(frame));
      } catch {
        // A send that throws is a socket already gone. The close handler will
        // arrive and remove it; pre-empting it here would race that path.
        return;
      }
      // Left at the head to retry on the next drain. Anything else — a byte
      // count, or the `-1` that means uWS has it — is no longer ours.
      if (status === 0) return;
      connection.queue.shift();
    }
  };

  const deliver = (connection: Connection, frame: ServerFrame): void => {
    if (connection.queue.length >= capacity) {
      // Oldest first. On a transport whose whole point is currency, the frame
      // worth keeping under pressure is the newest one. Counted, because
      // dropping is the designed behaviour and the counter is how an operator
      // finds out it happened.
      connection.queue.shift();
      dropped++;
      droppedSinceReport++;
    }
    connection.queue.push(frame);
    flush(connection);
  };

  const detach = (connection: Connection): void => {
    for (const topic of connection.topics) {
      const subscribers = index.get(topic);
      if (subscribers === undefined) continue;
      subscribers.delete(connection.id);
      if (subscribers.size === 0) index.delete(topic);
    }
    connections.delete(connection.id);
  };

  const closeOne = (connection: Connection, code: number, reason: string): void => {
    // Announced here, and that it happens *at all* is the point.
    //
    // The route's close handler reads `topics(id)` and hands the result to the
    // channel registry, which is correct — but it only ever runs for a close the
    // client started. For every close this module starts (4401 on an expired
    // session, the pong deadline, a failed ping, `closeAll` on restart) the
    // connection was already out of the map by the time Bun delivered the close
    // event, so `topics(id)` returned `[]` and every plugin `onClose` went
    // unfired. Nothing thrown, nothing logged: a plugin went on believing every
    // session it was serving survived a gateway restart.
    //
    // Note what this is *not*: swapping these two lines changes nothing, because
    // `detach` unhooks the index and the map without clearing the connection's
    // own topic set. The ordering here reads as load-bearing and is not. The
    // announcement existing is what matters, and the tests mutate its absence
    // rather than its position for exactly that reason.
    //
    // Firing before `socket.close()` also makes a double-fire impossible: by the
    // time the route's handler runs, `topics(id)` is empty and its call is a
    // no-op.
    onDetach?.(connection.id, [...connection.topics]);
    detach(connection);
    try {
      connection.socket.close(code, reason);
    } catch {
      // Already gone. Removing it from the index was the part that mattered.
    }
  };

  const tick = (): void => {
    cancelTick = undefined;
    if (!live) return;
    const at = now();

    for (const connection of [...connections.values()]) {
      if (at - connection.lastPongAt > pongDeadlineMs) {
        // Wedged rather than unauthenticated: an ordinary close, so the client
        // reconnects.
        closeOne(connection, 1001, "pong deadline");
        continue;
      }

      try {
        connection.socket.ping?.();
      } catch {
        closeOne(connection, 1001, "ping failed");
        continue;
      }

      // `checking` stops a slow verify from stacking, but on its own it also
      // means a verify that *never settles* pins the flag and that connection is
      // never revalidated again — the 12-hour expiry guarantee quietly stops
      // applying to exactly the socket whose store call is wedged. So the flag
      // expires: after `checkStaleMs` the in-flight check is abandoned and the
      // next tick asks again. The abandoned promise still resolves eventually
      // and is ignored, which `generation` is for.
      if (connection.checking) {
        if (at - connection.checkingSince < checkStaleMs) continue;
        connection.generation += 1;
        connection.checking = false;
      }
      connection.checking = true;
      connection.checkingSince = at;
      const generation = connection.generation;
      void connection.credential
        .revalidate()
        .then((valid) => {
          // A check that was given up on must not act on its answer: by now the
          // next one may already be in flight, and closing on a stale verdict
          // would disconnect a session that has since been re-verified.
          if (connection.generation !== generation) return;
          connection.checking = false;
          // A socket must not outlive its session. Authenticated once, a
          // connection would otherwise survive expiry or revocation
          // indefinitely, which is a privilege bug rather than an
          // inconvenience.
          if (!valid && connections.has(connection.id)) {
            closeOne(connection, CLOSE_UNAUTHENTICATED, "session expired");
          }
        })
        .catch(() => {
          if (connection.generation !== generation) return;
          connection.checking = false;
          // A verify that threw is not a verify that failed. Closing here would
          // disconnect every console in the building the moment the store had a
          // bad second; the next tick asks again.
        });
    }

    if (droppedSinceReport > 0) {
      logger.warn("stream queue overflowed", { count: droppedSinceReport });
      droppedSinceReport = 0;
    }

    arm();
  };

  const arm = (): void => {
    if (!live || cancelTick !== undefined) return;
    cancelTick = schedule(tick, heartbeatMs);
  };

  arm();

  return {
    add(id, socket, credential) {
      if (!live) {
        socket.close(1001, "shutting down");
        return;
      }
      connections.set(id, {
        id,
        socket,
        credential,
        topics: new Set(),
        queue: [],
        lastPongAt: now(),
        checking: false,
        checkingSince: 0,
        generation: 0,
      });
    },

    remove(id) {
      const connection = connections.get(id);
      if (connection !== undefined) detach(connection);
    },

    subscribe(id, topic) {
      const connection = connections.get(id);
      if (connection === undefined) return;
      if (connection.topics.size >= MAX_TOPICS_PER_CONNECTION && !connection.topics.has(topic)) {
        return;
      }
      connection.topics.add(topic);
      const subscribers = index.get(topic) ?? new Set<string>();
      subscribers.add(id);
      index.set(topic, subscribers);
    },

    unsubscribe(id, topic) {
      const connection = connections.get(id);
      if (connection === undefined) return;
      connection.topics.delete(topic);
      const subscribers = index.get(topic);
      if (subscribers === undefined) return;
      subscribers.delete(id);
      if (subscribers.size === 0) index.delete(topic);
    },

    topics(id) {
      return [...(connections.get(id)?.topics ?? [])];
    },

    has(id, topic) {
      return connections.get(id)?.topics.has(topic) ?? false;
    },

    principal(id) {
      return connections.get(id)?.credential.principal ?? null;
    },

    pong(id) {
      const connection = connections.get(id);
      if (connection !== undefined) connection.lastPongAt = now();
    },

    drain(id) {
      const connection = connections.get(id);
      if (connection !== undefined) flush(connection);
    },

    publish(topic, frame) {
      const subscribers = index.get(topic);
      if (subscribers === undefined) return;
      for (const id of subscribers) {
        const connection = connections.get(id);
        if (connection !== undefined) deliver(connection, frame);
      }
    },

    sendTo(id, frame) {
      const connection = connections.get(id);
      if (connection !== undefined) deliver(connection, frame);
    },

    closeAll(code, reason) {
      for (const connection of [...connections.values()]) closeOne(connection, code, reason);
      index.clear();
    },

    stats() {
      let queued = 0;
      for (const connection of connections.values()) queued += connection.queue.length;
      return { connections: connections.size, dropped, queued };
    },

    stop() {
      live = false;
      cancelTick?.();
      // Cleared rather than merely disarmed, for the reason the event bus clears
      // its queue: a pending tick left behind is a timer a leak test would be
      // unable to see, and a process waiting to exit would wait for it.
      cancelTick = undefined;
    },
  };
}
