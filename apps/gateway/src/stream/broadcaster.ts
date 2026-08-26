import type { Coalescer } from "./coalescer.ts";
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
  coalescer: Coalescer;
};

export function createBroadcaster(deps: BroadcasterDeps): Broadcaster {
  const streams = new Set<string>();

  return {
    invalidate(topic, keys) {
      deps.coalescer.emit(topic, keys === undefined ? undefined : { keys });
    },

    invalidateAll() {
      // Not coalesced. There is exactly one caller — the far side of a database
      // swap — and delaying it by a floor would leave every console rendering
      // the previous database for a second after the new one is live.
      deps.registry.publish(GLOBAL_INVALIDATE, {
        type: "event",
        topic: GLOBAL_INVALIDATE,
      } satisfies ServerFrame);
    },

    declareStream(topic) {
      streams.add(topic);
    },

    declared(topic) {
      return streams.has(topic);
    },

    stream(topic, payload) {
      // Sequenced and recorded before it is published, so a subscriber that
      // arrives mid-publish replays from the ring rather than from a number the
      // ring has not seen yet.
      const seq = deps.ring.push(topic, payload);
      deps.registry.publish(topic, { type: "event", topic, seq, payload });
    },

    resetStream(topic) {
      deps.ring.reset(topic);
    },

    stop() {
      deps.coalescer.stop();
    },
  };
}
