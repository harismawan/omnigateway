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

/**
 * How a drain is deferred, and how a deferred one is cancelled.
 *
 * Injected for the same reason clocks and log sinks are throughout this
 * codebase: without it, "stop cancels the pending drain" is untestable. Bun's
 * `process.getActiveResourcesInfo()` reports nothing for timers, so there is no
 * way to observe a timeout from outside — and an assertion that cannot fail is
 * how a claim like this one ends up in a test name and not in the code.
 */
export type DrainScheduler = (run: () => void) => () => void;

const defaultScheduler: DrainScheduler = (run) => {
  // A macrotask rather than a microtask: a microtask drain would still run
  // before the response is handed back, which defeats the point.
  const timer = setTimeout(run, 0);
  return () => clearTimeout(timer);
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
export function createPluginEventBus(opts: {
  logger?: Logger;
  capacity?: number;
  scheduler?: DrainScheduler;
}): PluginEventBus {
  const logger = opts.logger ?? noopLogger;
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  const scheduler = opts.scheduler ?? defaultScheduler;

  const requestHandlers: Handler<RequestCompleted>[] = [];
  const limitHandlers: Handler<LimitReached>[] = [];

  const queue: Queued[] = [];
  let dropped = 0;
  let handlerErrors = 0;
  let draining = false;
  let live = true;
  /** Cancels the pending drain. A drain outliving the bus is a timer leak. */
  let cancelDrain: (() => void) | undefined;

  /**
   * Reported once per drain rather than once per drop.
   *
   * A full queue means many drops in quick succession, and a line each would
   * turn a load problem into a log problem on top of it.
   */
  let droppedSinceReport = 0;

  /**
   * Handler failures since the last drain, by plugin.
   *
   * Batched for the reason drops are. A plugin whose handler always throws
   * throws once per event, which is once per proxied request — a line each
   * turns one broken plugin into a log volume problem on top of it, and buries
   * whatever else was being diagnosed at the time.
   */
  const errorsSinceReport = new Map<string, number>();

  const drain = (): void => {
    draining = false;
    cancelDrain = undefined;
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
          errorsSinceReport.set(
            handler.pluginId,
            (errorsSinceReport.get(handler.pluginId) ?? 0) + 1,
          );
        }
      }
    }
    for (const [pluginId, count] of errorsSinceReport) {
      // No error body and no event fields: this line reports on code authored
      // outside the repository, and `LogFields` is a closed allowlist. The
      // plugin id and a count are the actionable parts.
      logger.warn("plugin event handler failed", { plugin: pluginId, count });
    }
    errorsSinceReport.clear();
    if (droppedSinceReport > 0) {
      logger.warn("plugin event queue overflowed", { count: droppedSinceReport });
      droppedSinceReport = 0;
    }
  };

  const schedule = (): void => {
    if (draining || !live) return;
    draining = true;
    cancelDrain = scheduler(drain);
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
      // Cleared rather than merely disarmed. `drain` already returns early once
      // `live` is false, so leaving the timeout pending would be harmless and
      // still wrong: a test that asserts no timer is left behind would be
      // asserting nothing, and a process waiting to exit would wait for it.
      cancelDrain?.();
      cancelDrain = undefined;
      draining = false;
    },
  };
}
