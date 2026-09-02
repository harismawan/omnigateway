import type { Coord } from "@omni/coord";
import { createCoalescer, type Schedule } from "./coalescer.ts";
import type { ServerFrame } from "./protocol.ts";
import type { SocketRegistry } from "./registry.ts";
import type { Ring } from "./ring.ts";

/**
 * What an emitter sees. The only stream object in `AppDeps`.
 *
 * Emitters call `invalidate`; they do not know a registry, a ring or a
 * coalescer exists, and in particular they do not know whether anybody is
 * connected. That is deliberate — a `finishLog` that had to check would be a
 * `finishLog` that could get the check wrong on the path that runs once per
 * request.
 */
export type Broadcaster = {
  /**
   * Tells subscribers a resource changed. Coalesced.
   *
   * `keys` is advisory and currently ignored by the console, which maps the
   * topic to a query key itself. Stated here so an emitter that starts sending
   * `keys` cannot quietly change client behaviour.
   */
  invalidate(topic: string, keys?: readonly string[]): void;
  /**
   * Tells every connection that everything it holds is stale.
   *
   * For the one case that is true: the database underneath was replaced.
   */
  invalidateAll(): void;
  /**
   * Registers a `stream:*` topic as having a source behind it.
   *
   * A subscribe to a stream topic nobody declared answers `error`. That one
   * rule covers the console whose log source is `none` and every future plugin
   * stream whose source failed to start — neither should look to a client like
   * a topic that is simply quiet.
   */
  declareStream(topic: string): void;
  declared(topic: string): boolean;
  /** Publishes a sequenced payload frame and records it in the ring for replay. */
  stream(topic: string, payload: unknown): void;
  /** Forgets a stream topic's history without rewinding its sequence. */
  resetStream(topic: string): void;
  stop(): void;
};

/**
 * The one method an emitter needs.
 *
 * Every `res:*` site takes this rather than the whole `Broadcaster`: a
 * `finishLog` or a poll loop that could reach `stream`, `resetStream` or `stop`
 * is a path that could be made to do any of them, and none of the three is
 * anything an emitter of a resource change has business doing. `Broadcaster`
 * satisfies it structurally, so `createApp` hands its own over without an
 * adapter and there is nothing to keep in step.
 */
export type Invalidator = Pick<Broadcaster, "invalidate">;

/**
 * Topics whose invalidations are floored, and at what.
 *
 * One place on purpose. A floor that lived beside its emitter would be a floor
 * nobody could read off against the others, and these numbers only make sense
 * relative to the poll interval each one replaces: 60s for usage, 2s for logs,
 * 10s for credential health, 300s for quota.
 */
export const INVALIDATION_FLOORS: Readonly<Record<string, number>> = {
  "res:usage": 1_000,
  "res:logs": 1_000,
  "res:quota": 5_000,
  "res:credentials": 5_000,
};

/** Everything else — the admin mutations, which are operator-paced already. */
export const DEFAULT_FLOOR_MS = 1_000;

/** Sent on every topic a connection holds when the database is replaced. */
export const GLOBAL_INVALIDATE = "res:*";

export type BroadcasterDeps = {
  registry: SocketRegistry;
  ring: Ring;
  /**
   * Fan-out between processes. Every frame goes out through it and comes back
   * in through the subscription — this process's own included — so there is
   * one delivery path, and in memory it is the direct publish it was.
   */
  coord: Coord;
  /** Names this process's declarations, so another can tell whose they are. */
  nodeId: string;
  now: () => number;
  floors?: Readonly<Record<string, number>>;
  defaultFloorMs?: number;
  schedule?: Schedule;
};

/** What crosses between processes. One channel, three shapes. */
type Fanout =
  | { kind: "res"; topic: string; payload?: unknown }
  | { kind: "stream"; topic: string; seq: number; payload: unknown }
  | { kind: "declare"; topic: string; nodeId: string }
  | { kind: "hello"; nodeId: string };

const CHANNEL = "broadcast";

export function createBroadcaster(deps: BroadcasterDeps): Broadcaster {
  const floors = deps.floors ?? INVALIDATION_FLOORS;
  const defaultFloorMs = deps.defaultFloorMs ?? DEFAULT_FLOOR_MS;
  /** Topics with a source behind them, and which process holds it. */
  const streams = new Map<string, string>();

  const send = (message: Fanout): void => {
    void deps.coord.pubsub.publish(CHANNEL, JSON.stringify(message));
  };

  // Two coalescers with one floor table. The first bounds what this process
  // publishes, or N processes at 100 req/s each publish uncoalesced; the second
  // bounds what any one client receives, or N floored streams arrive N times
  // the floor. In series they add no delay: a frame the first passes at once
  // the second passes at once too.
  const outbound = createCoalescer({
    floors,
    defaultFloorMs,
    now: deps.now,
    ...(deps.schedule === undefined ? {} : { schedule: deps.schedule }),
    sink: (topic, payload) => send({ kind: "res", topic, payload }),
  });
  const inbound = createCoalescer({
    floors,
    defaultFloorMs,
    now: deps.now,
    ...(deps.schedule === undefined ? {} : { schedule: deps.schedule }),
    sink: (topic, payload) =>
      deps.registry.publish(topic, {
        type: "event",
        topic,
        ...(payload === undefined ? {} : { payload }),
      } satisfies ServerFrame),
  });

  const unsubscribe = deps.coord.pubsub.subscribe(CHANNEL, (_topic, raw) => {
    const message = JSON.parse(raw) as Fanout;
    switch (message.kind) {
      case "res":
        if (message.topic === GLOBAL_INVALIDATE) {
          // Not coalesced. There is exactly one sender — the far side of a
          // database swap — and delaying it by a floor would leave every
          // console rendering the previous database for a second after the
          // new one is live.
          deps.registry.publish(GLOBAL_INVALIDATE, {
            type: "event",
            topic: GLOBAL_INVALIDATE,
          } satisfies ServerFrame);
        } else {
          inbound.emit(message.topic, message.payload);
        }
        return;
      case "stream":
        // Recorded before it is published, so a subscriber that arrives
        // mid-publish replays from the ring rather than from a number the ring
        // has not seen yet.
        deps.ring.push(message.topic, message.payload, message.seq);
        deps.registry.publish(message.topic, {
          type: "event",
          topic: message.topic,
          seq: message.seq,
          payload: message.payload,
        });
        return;
      case "declare":
        streams.set(message.topic, message.nodeId);
        return;
      case "hello":
        // A process that joined after this one declared its streams asks to
        // hear them again; every process answers for its own.
        if (message.nodeId === deps.nodeId) return;
        for (const [topic, owner] of streams) {
          if (owner === deps.nodeId) send({ kind: "declare", topic, nodeId: deps.nodeId });
        }
        return;
    }
  });
  send({ kind: "hello", nodeId: deps.nodeId });

  return {
    invalidate(topic, keys) {
      outbound.emit(topic, keys === undefined ? undefined : { keys });
    },

    invalidateAll() {
      send({ kind: "res", topic: GLOBAL_INVALIDATE });
    },

    declareStream(topic) {
      streams.set(topic, deps.nodeId);
      send({ kind: "declare", topic, nodeId: deps.nodeId });
    },

    declared(topic) {
      return streams.has(topic);
    },

    stream(topic, payload) {
      // The sequence is the fleet's, so a client moving between processes
      // carries a number every one of them recognises. Issued before the
      // frame is sent, and sent in issue order: `incr` resolves in call order
      // on one connection, and the publish that follows each one does too.
      void deps.coord.incr(`seq:${topic}`).then((seq) => {
        send({ kind: "stream", topic, seq, payload });
      });
    },

    resetStream(topic) {
      deps.ring.reset(topic);
    },

    stop() {
      outbound.stop();
      inbound.stop();
      unsubscribe();
    },
  };
}
