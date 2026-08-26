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
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
  ping?(): unknown;
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

/** Server ping interval. Also when the principal is re-verified. */
const HEARTBEAT_MS = 20_000;

/** A connection that has not ponged within this is gone, whatever it thinks. */
const PONG_DEADLINE_MS = 60_000;

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
};

export type SocketRegistry = {
  add(id: string, socket: Socket, credential: Credential): void;
  remove(id: string): void;
  /** Records a subscription. The caller has already authorised it. */
  subscribe(id: string, topic: string): void;
  unsubscribe(id: string, topic: string): void;
  topics(id: string): readonly string[];
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
  logger?: Logger;
  now?: Clock;
  schedule?: Schedule;
  queueCapacity?: number;
  heartbeatMs?: number;
  pongDeadlineMs?: number;
};

export function createSocketRegistry(deps: RegistryDeps = {}): SocketRegistry {
  const logger = deps.logger ?? noopLogger;
  const now = deps.now ?? Date.now;
  const schedule =
    deps.schedule ??
    ((run: () => void, ms: number) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  const capacity = deps.queueCapacity ?? DEFAULT_QUEUE_CAPACITY;
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const pongDeadlineMs = deps.pongDeadlineMs ?? PONG_DEADLINE_MS;

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
   * Bun's `send` reports backpressure rather than blocking: a negative or zero
   * status means the frame did not go out. Draining stops at the first such
   * frame, because sending the ones behind it would reorder the topic — and on
   * `stream:*` the sequence is the contract.
   */
  const flush = (connection: Connection): void => {
    while (connection.queue.length > 0) {
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
      if (typeof status === "number" && status <= 0) return;
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

      if (connection.checking) continue;
      connection.checking = true;
      void connection.credential
        .revalidate()
        .then((valid) => {
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
      });
    },

    remove(id) {
      const connection = connections.get(id);
      if (connection !== undefined) detach(connection);
    },

    subscribe(id, topic) {
      const connection = connections.get(id);
      if (connection === undefined) return;
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
