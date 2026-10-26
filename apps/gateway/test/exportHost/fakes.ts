import type { DestinationStatus, MainMessage, WorkerMessage } from "../../src/export/protocol.ts";
import type { ExportWorker } from "../../src/export/spawn.ts";

/**
 * A worker handle the test drives: it records what the main thread posted,
 * and the test decides what it answers, when it dies and whether it acks a
 * pause. Stands in for `spawnExportWorker` everywhere on the main thread.
 */
export type FakeWorker = ExportWorker & {
  posted: MainMessage[];
  terminated: boolean;
  /** Delivers a worker → main message. */
  emit(message: WorkerMessage): void;
  /** The worker dies (crash, exit, or after terminate). */
  die(): void;
  alive: boolean;
};

export function fakeWorker(
  auto: {
    ackPause?: boolean;
    /** False: `stop` does not make it exit (a worker stuck in a native call). */
    exitOnStop?: boolean;
    /** False: `terminate` returns while the thread runs on; the test calls `die()`. */
    terminateExits?: boolean;
    onPost?: (w: FakeWorker, m: MainMessage) => void;
  } = {},
): FakeWorker {
  const listeners: Array<(m: WorkerMessage) => void> = [];
  const exits: Array<() => void> = [];
  const w: FakeWorker = {
    posted: [],
    terminated: false,
    alive: true,
    post(message) {
      if (!w.alive) return;
      w.posted.push(message);
      if (message.type === "pause" && auto.ackPause !== false) {
        queueMicrotask(() => w.emit({ type: "paused" }));
      }
      if (message.type === "stop" && auto.exitOnStop !== false) queueMicrotask(() => w.die());
      auto.onPost?.(w, message);
    },
    onMessage(listener) {
      listeners.push(listener);
    },
    onExit(listener) {
      exits.push(listener);
    },
    terminate() {
      w.terminated = true;
      if (auto.terminateExits !== false) w.die();
    },
    emit(message) {
      if (!w.alive || w.terminated) return;
      for (const l of listeners) l(message);
    },
    die() {
      if (!w.alive) return;
      w.alive = false;
      for (const e of exits.splice(0)) e();
    },
  };
  return w;
}

/** Timers the test advances by hand. */
export function fakeTimers(start = 1_000_000) {
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const clock = {
    now: start,
    setTimeout(fn: () => void, ms: number): unknown {
      seq += 1;
      pending.set(seq, { at: clock.now + Math.max(0, ms), fn });
      return seq;
    },
    clearTimeout(handle: unknown) {
      if (typeof handle === "number") pending.delete(handle);
    },
    pending: () => pending.size,
    async advance(ms: number) {
      const end = clock.now + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of pending) {
          if (entry[1].at <= end && (next === null || entry[1].at < next[1].at)) next = entry;
        }
        if (next === null) break;
        pending.delete(next[0]);
        clock.now = Math.max(clock.now, next[1].at);
        next[1].fn();
        await flush();
      }
      clock.now = end;
      await flush();
    },
  };
  return clock;
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await Bun.sleep(0);
}

export function status(over: Partial<DestinationStatus> = {}): DestinationStatus {
  return {
    id: "hook",
    generation: "gen-hook",
    type: "webhook",
    enabled: true,
    lagMs: 11_000,
    lastSuccessAt: null,
    lastError: null,
    lastErrorAt: null,
    exportedTotal: 0,
    droppedTotal: 0,
    gapPossibleAt: null,
    skipRequestedAt: null,
    retryAt: null,
    failing: false,
    counters: {
      recordsSent: 0,
      recordsDropped: 0,
      batchesOk: 0,
      batchesRetry: 0,
      batchesFailed: 0,
      gapWarnings: 0,
    },
    ...over,
  };
}
