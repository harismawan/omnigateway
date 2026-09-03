import { type Coord, splitSequenced } from "@omni/coord";
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
  /**
   * Publishes one plugin channel frame to every process's subscribers.
   *
   * Behind `PluginChannel.broadcast`. Neither coalesced nor sequenced, and both
   * omissions are deliberate: a plugin's payload identifies which thing changed,
   * so folding by topic would drop every frame but the last, and there is no
   * replay to number for — a channel has no ring and nothing here survives a
   * restart, which is what the capability already promises.
   */
  channel(topic: string, payload: unknown): void;
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
  | { kind: "stream"; topic: string; payload: unknown }
  | { kind: "channel"; topic: string; payload: unknown }
  | { kind: "declare"; topic: string; nodeId: string }
  | { kind: "hello"; nodeId: string };

const CHANNEL = "broadcast";

/** Where the Redis coordinator says the shared channel came (back) up. */
const RECONNECTED = "coord:reconnected";

export function createBroadcaster(deps: BroadcasterDeps): Broadcaster {
  const floors = deps.floors ?? INVALIDATION_FLOORS;
  const defaultFloorMs = deps.defaultFloorMs ?? DEFAULT_FLOOR_MS;
  /** Disarms emission, as `ChannelRegistry`'s own flag does. */
  let live = true;
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
    // A stream frame is numbered by the coordinator in the same step it was
    // published, and the number rides in front of the envelope.
    const sequenced = splitSequenced(raw);
    const message = JSON.parse(sequenced?.payload ?? raw) as Fanout;
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
      case "stream": {
        if (sequenced === null) return;
        // Recorded before it is published, so a subscriber that arrives
        // mid-publish replays from the ring rather than from a number the ring
        // has not seen yet.
        deps.ring.push(message.topic, message.payload, sequenced.seq);
        deps.registry.publish(message.topic, {
          type: "event",
          topic: message.topic,
          seq: sequenced.seq,
          payload: message.payload,
        });
        return;
      }
      case "channel":
        // Straight to the sockets: no coalescer, no ring, no sequence. The
        // registry delivers to whoever holds the topic, which on this process
        // is exactly the set the host authorised.
        deps.registry.publish(message.topic, {
          type: "event",
          topic: message.topic,
          payload: message.payload,
        } satisfies ServerFrame);
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
  const hello = (): void => send({ kind: "hello", nodeId: deps.nodeId });
  hello();
  // Declarations live only in fan-out. A process whose shared channel dropped
  // and came back missed every one made meanwhile, so it asks again.
  const unsubscribeReconnected = deps.coord.pubsub.subscribe(RECONNECTED, hello);

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
      // carries a number every one of them recognises — and it is taken in
      // the same step as the publish, so two processes cannot take 5 and 6
      // and deliver 6 first.
      void deps.coord.pubsub.publishSequenced(
        CHANNEL,
        JSON.stringify({ kind: "stream", topic, payload } satisfies Fanout),
        `seq:${topic}`,
      );
    },

    channel(topic, payload) {
      if (!live) return;
      /*
        Encoded here, in a `try`, because this payload is plugin-authored
        `unknown` and `send` below stringifies synchronously — so a `BigInt` or a
        circular object would throw back out through `PluginChannel.broadcast`
        into the plugin's own stack. From a route that is a 500; from a plugin's
        own timer, which is the ordinary shape for a push floor, it is an
        uncaught exception and the gateway process with it.

        `registry.ts` refuses the same throw at the same boundary for the same
        reason, and this path does not reach that encoder: it stringifies its own
        envelope first. Dropped rather than reported, exactly as an unencodable
        frame is dropped there — the plugin is told nothing because there is
        nothing it could be told through.
      */
      let message: string;
      try {
        message = JSON.stringify({ kind: "channel", topic, payload } satisfies Fanout);
      } catch {
        return;
      }
      void deps.coord.pubsub.publish(CHANNEL, message);
    },

    resetStream(topic) {
      deps.ring.reset(topic);
    },

    stop() {
      live = false;
      outbound.stop();
      inbound.stop();
      unsubscribe();
      unsubscribeReconnected();
    },
  };
}
