import { type Logger, noopLogger } from "@omni/ir";
import type { LimitReached, RequestCompleted } from "@omni/plugins";

/**
 * How many undelivered events the bus will hold before it starts dropping.
 *
 * Sized for a burst rather than a backlog. A handler that cannot keep up with
 * this is not going to be rescued by a larger number, and the larger number is
 * how a slow plugin turns into an out-of-memory kill of the gateway.
 */
const DEFAULT_CAPACITY = 1_000;

type Handler<T> = { pluginId: string; run: (event: T) => void };

type Queued =
  | { name: "request:completed"; event: RequestCompleted }
  | { name: "limit:reached"; event: LimitReached };

export type PluginEventStats = {
  /** Events discarded because the queue was full. */
  dropped: number;
  /** Handler invocations that threw. */
  handlerErrors: number;
  /** Events currently waiting to be delivered. */
  queued: number;
};

export type PluginEventBus = {
  onRequestCompleted(pluginId: string, run: (event: RequestCompleted) => void): void;
  onLimitReached(pluginId: string, run: (event: LimitReached) => void): void;
  emitRequestCompleted(event: RequestCompleted): void;
  emitLimitReached(event: LimitReached): void;
  stats(): PluginEventStats;
  /** Stops delivery and discards anything still queued. */
  stop(): void;
};

/**
 * Delivers gateway events to plugin handlers, off the request path.
 *
 * Three properties, each of which is the reason this is a bus rather than a
 * direct call:
 *
 * **Nothing runs on the caller's stack.** `emit` appends and returns. The
 * emitting site is `finishLog`, which runs on the request path and beside a
 * store write; `bun:sqlite` is synchronous, so a handler invoked there would
 * block the event loop for its own duration and put a plugin's work between a
 * client and its response.
 *
 * **A throwing handler is contained.** It costs that plugin its event and
 * nothing else — not the request, not the other handlers, not the drain.
 *
 * **The queue is bounded.** Under an unbounded queue a slow handler is a memory
 * leak that only shows up under load. Dropping is the designed behaviour and
 * the counter is how an operator finds out.
 *
 * Delivery is at-most-once and explicitly not durable: an event queued when the
 * process dies is gone. A plugin needing exact accounting must reconcile from
 * its own storage and must never treat this stream as a ledger.
 */
export function createPluginEventBus(opts: { logger?: Logger; capacity?: number }): PluginEventBus {
  const logger = opts.logger ?? noopLogger;
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;

  const requestHandlers: Handler<RequestCompleted>[] = [];
  const limitHandlers: Handler<LimitReached>[] = [];

  const queue: Queued[] = [];
  let dropped = 0;
  let handlerErrors = 0;
  let draining = false;
  let live = true;

  /**
   * Reported once per drain rather than once per drop.
   *
   * A full queue means many drops in quick succession, and a line each would
   * turn a load problem into a log problem on top of it.
   */
  let droppedSinceReport = 0;

  const drain = (): void => {
    draining = false;
    if (!live) return;
    // Taken whole: a handler that emits would otherwise extend the array being
    // iterated and let one plugin starve the drain indefinitely.
    const batch = queue.splice(0, queue.length);
    for (const item of batch) {
      const handlers: Handler<never>[] =
        item.name === "request:completed"
          ? (requestHandlers as Handler<never>[])
          : (limitHandlers as Handler<never>[]);
      for (const handler of handlers) {
        try {
          (handler.run as (event: unknown) => void)(item.event);
        } catch {
          handlerErrors++;
          // No error body and no event fields: this line crosses into the log
          // from code authored outside the repository, and `LogFields` is a
          // closed allowlist. The plugin id is the actionable part.
          logger.warn("plugin event handler failed", { plugin: handler.pluginId });
        }
      }
    }
    if (droppedSinceReport > 0) {
      logger.warn("plugin event queue overflowed", { count: droppedSinceReport });
      droppedSinceReport = 0;
    }
  };

  const schedule = (): void => {
    if (draining || !live) return;
    draining = true;
    // A macrotask rather than a microtask: a microtask drain would still run
    // before the response is handed back, which defeats the point.
    setTimeout(drain, 0);
  };

  const enqueue = (item: Queued, subscribers: number): void => {
    // The overwhelming majority of installs run no plugins. With no subscriber
    // for this event there is nothing to deliver to, so there is no queue entry
    // to make and no drop to count.
    if (!live || subscribers === 0) return;
    if (queue.length >= capacity) {
      dropped++;
      droppedSinceReport++;
      return;
    }
    queue.push(item);
    schedule();
  };

  return {
    onRequestCompleted(pluginId, run) {
      requestHandlers.push({ pluginId, run });
    },
    onLimitReached(pluginId, run) {
      limitHandlers.push({ pluginId, run });
    },
    emitRequestCompleted(event) {
      enqueue({ name: "request:completed", event }, requestHandlers.length);
    },
    emitLimitReached(event) {
      enqueue({ name: "limit:reached", event }, limitHandlers.length);
    },
    stats() {
      return { dropped, handlerErrors, queued: queue.length };
    },
    stop() {
      live = false;
      queue.length = 0;
    },
  };
}
