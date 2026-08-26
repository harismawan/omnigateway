/**
 * Folds a burst of emits on one topic into a leading frame and a trailing one.
 *
 * This is not an optimisation, it is what keeps push from being worse than the
 * polling it replaces. At 100 requests per second a per-request `res:usage`
 * frame is 100 client refetches per second, against a surface that polls at 60s
 * today. Uncoalesced push is strictly slower than the poll, and it is the
 * easiest way for this transport to make the product worse.
 *
 * Leading **and** trailing, never one or the other. Leading alone loses the last
 * change of a burst, which is the one the operator is watching for. Trailing
 * alone adds a floor's worth of latency to an idle gateway's first event, which
 * is the case a socket was added for.
 */

/** Reads the current instant. Injected, like every clock in this codebase. */
export type Clock = () => number;

/**
 * How a trailing emit is deferred, and how a deferred one is cancelled.
 *
 * Injected for the reason `DrainScheduler` is in `plugins/events.ts`: Bun's
 * `process.getActiveResourcesInfo()` reports nothing for timers, so without this
 * seam "stop cancels the pending trailing emit" is a claim that can live in a
 * test name and not in the code.
 */
export type Schedule = (run: () => void, ms: number) => () => void;

const defaultSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export type Coalescer = {
  emit(topic: string, payload?: unknown): void;
  /** Fires every pending trailing emit now. For shutdown and for tests. */
  flush(): void;
  /** Drops every pending trailing emit and cancels its timer. */
  stop(): void;
};

type Pending = {
  /** The most recent payload seen during the floor. The trailing frame sends this. */
  payload: unknown;
  cancel: () => void;
};

export type CoalescerDeps = {
  /**
   * Per-topic floor in milliseconds.
   *
   * One place, per the design: a floor that lives beside its emitter is a floor
   * nobody can read off against the others.
   */
  floors: Readonly<Record<string, number>>;
  defaultFloorMs: number;
  sink: (topic: string, payload?: unknown) => void;
  now?: Clock;
  schedule?: Schedule;
};

export function createCoalescer(deps: CoalescerDeps): Coalescer {
  const now = deps.now ?? Date.now;
  const schedule = deps.schedule ?? defaultSchedule;

  /** When each topic last emitted, so the floor is measured rather than assumed. */
  const lastSent = new Map<string, number>();
  const pending = new Map<string, Pending>();

  const floorFor = (topic: string): number => deps.floors[topic] ?? deps.defaultFloorMs;

  const send = (topic: string, payload: unknown): void => {
    lastSent.set(topic, now());
    deps.sink(topic, payload);
  };

  const fire = (topic: string): void => {
    const item = pending.get(topic);
    if (item === undefined) return;
    pending.delete(topic);
    send(topic, item.payload);
  };

  return {
    emit(topic, payload) {
      const floor = floorFor(topic);
      const previous = lastSent.get(topic);
      const elapsed = previous === undefined ? Number.POSITIVE_INFINITY : now() - previous;

      const waiting = pending.get(topic);
      if (waiting !== undefined) {
        // Inside the floor with a trailing emit already armed. Replace the
        // payload and leave the timer alone: re-arming it on every emit is a
        // debounce, and a debounce under sustained load never fires at all.
        waiting.payload = payload;
        return;
      }

      if (elapsed >= floor) {
        send(topic, payload);
        return;
      }

      const cancel = schedule(() => fire(topic), floor - elapsed);
      pending.set(topic, { payload, cancel });
    },

    flush() {
      for (const [topic, item] of [...pending]) {
        item.cancel();
        pending.delete(topic);
        send(topic, item.payload);
      }
    },

    stop() {
      for (const item of pending.values()) item.cancel();
      // Cleared rather than merely cancelled, for the reason the event bus
      // clears its queue: a pending entry left behind is a trailing frame that
      // a restarted coalescer would deliver against a topic nobody subscribes
      // to any more.
      pending.clear();
      lastSent.clear();
    },
  };
}
