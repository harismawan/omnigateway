import { GatewayError, type Logger } from "@omni/ir";
import type {
  DestinationStatus,
  MainMessage,
  WorkerInit,
  WorkerMessage,
} from "../export/protocol.ts";
import type { ExportWorker } from "../export/spawn.ts";
import { createWorkerHost, type Timers, type WorkerHostState } from "../workerHost/instance.ts";
import type { ExportMetrics } from "./metrics.ts";

export {
  PAUSE_ACK_MS,
  RESTART_GIVE_UP,
  RESTART_MAX_MS,
  RESTART_MIN_MS,
  RESTART_WINDOW_MS,
  STOP_TERMINATE_MS,
  TERMINATE_WAIT_MS,
  type Timers,
} from "../workerHost/instance.ts";

/**
 * Export policy on the main thread: destination start conditions, idle/down
 * polling, requests, and the latest status. The generic host owns thread
 * lifecycle, restart backoff, retiring instances and restore quiescence.
 * Design: docs/superpowers/specs/2026-10-24-log-export-design.md
 * (*Asynchrony*, *Failure isolation*, *Restore and import*, *Delivery*).
 * The main thread never touches export state.
 */
export type SupervisorState = WorkerHostState;

/** A request the console or CLI makes of the worker, without its `ref`. */
export type ExportRequest =
  | { type: "test"; id: string }
  | { type: "preview"; requestId: string }
  | { type: "skip"; id: string }
  | { type: "ackGap"; id: string; seenAt: number };

type ReplyOf = {
  test: Extract<WorkerMessage, { type: "testResult" }>;
  preview: Extract<WorkerMessage, { type: "previewResult" }>;
  skip: Extract<WorkerMessage, { type: "skipResult" }>;
  ackGap: Extract<WorkerMessage, { type: "ackGapResult" }>;
};
type Reply = ReplyOf[keyof ReplyOf];

/** A test sends to a receiver; the other requests read. */
export const REQUEST_TIMEOUT_MS: Readonly<Record<ExportRequest["type"], number>> = {
  test: 30_000,
  preview: 10_000,
  skip: 10_000,
  ackGap: 10_000,
};
export const IDLE_RECHECK_MS = 30_000;
export const DOWN_RECHECK_MS = 30_000;
export const NOT_RUNNING = "export worker not running";
const NO_REPLY = "export worker did not reply in time";

/** Revision changes whenever a destination is created, edited or removed. */
export type DestinationsRead = { count: number; revision: string };

export type SupervisorDeps = {
  init: WorkerInit;
  spawn: (init: WorkerInit) => ExportWorker;
  readDestinations: () => Promise<DestinationsRead>;
  timers: Timers;
  now: () => number;
  logger: Logger;
  metrics?: ExportMetrics;
  onChange?: () => void;
};

export type ExportSupervisor = {
  start(): Promise<void>;
  destinationsChanged(): Promise<void>;
  request<R extends ExportRequest>(request: R): Promise<ReplyOf[R["type"]]>;
  /** Refuse the swap if any unacked or retiring worker has not actually exited. */
  pause(): Promise<void>;
  /** An unsafe halt survives unless a swap completed. */
  resume(swapped: boolean): Promise<void>;
  halt(): Promise<void>;
  /** Synchronous and final, including for lifecycle work in flight. */
  stop(): void;
  state(): SupervisorState;
  statuses(): readonly DestinationStatus[];
  restarts(): number;
};

type Pending = {
  type: ExportRequest["type"];
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  timer: unknown;
};

const REPLY_TYPE: Readonly<Record<Reply["type"], ExportRequest["type"]>> = {
  testResult: "test",
  previewResult: "preview",
  skipResult: "skip",
  ackGapResult: "ackGap",
};

const unref = (handle: unknown): void => {
  (handle as { unref?: () => void } | null)?.unref?.();
};

/** Lag and counters alone do not announce an invalidation on every tick. */
function materialKey(statuses: readonly DestinationStatus[]): string {
  return JSON.stringify(
    statuses.map((s) => [
      s.id,
      s.generation,
      s.enabled,
      s.lastSuccessAt,
      s.lastError,
      s.lastErrorAt,
      s.exportedTotal,
      s.droppedTotal,
      s.gapPossibleAt,
      s.skipRequestedAt,
      s.failing,
    ]),
  );
}

export function createExportSupervisor(deps: SupervisorDeps): ExportSupervisor {
  const { timers, logger } = deps;
  let downRevision: string | null = null;
  let pollTimer: unknown = null;
  let latest: DestinationStatus[] = [];
  let lastKey = materialKey([]);
  let nextRef = 0;
  const pending = new Map<string, Pending>();
  const notRunning = (): GatewayError => new GatewayError("OVERLOADED", NOT_RUNNING);

  const host = createWorkerHost<MainMessage, WorkerMessage>({
    spawn: () => deps.spawn(deps.init),
    lifecycle: { pause: { type: "pause" }, resume: { type: "resume" }, stop: { type: "stop" } },
    timers,
    now: deps.now,
    logger,
    name: "export worker",
    onMessage: receive,
    onUnavailable: () => rejectAll(notRunning),
    onStarted: () => deps.metrics?.instanceStarted(),
    onRestart: (total) => deps.metrics?.restarts(total),
    shouldStart: async () => {
      downRevision = null;
      const read = await readDestinations();
      return read !== null && read.count > 0;
    },
    onStateChange: (next, previous) => {
      cancelPoll();
      if (next !== previous) deps.onChange?.();
      if (next === "idle") schedulePoll(IDLE_RECHECK_MS);
      if (next === "down") {
        void serial(async () => {
          const read = await readDestinations();
          if (host.state() !== "down") return;
          // If unreadable, the first readable poll becomes the baseline.
          downRevision = read?.revision ?? null;
        });
        schedulePoll(DOWN_RECHECK_MS);
      }
    },
  });

  const held = (): boolean =>
    host.state() === "paused" || host.state() === "halted" || host.state() === "stopped";

  function cancelPoll(): void {
    if (pollTimer !== null) timers.clearTimeout(pollTimer);
    pollTimer = null;
  }

  /** Policy calls serialize too, so a held store read cannot overtake a restore. */
  let chain: Promise<void> = Promise.resolve();
  const serial = (work: () => Promise<void>): Promise<void> => {
    const next = chain.then(work, work);
    chain = next.catch(() => {});
    return next;
  };

  function schedulePoll(ms: number): void {
    cancelPoll();
    if (host.state() === "stopped") return;
    pollTimer = timers.setTimeout(() => {
      pollTimer = null;
      void serial(async () => {
        if (host.state() === "idle") {
          await startIfWanted();
          return;
        }
        if (host.state() !== "down") return;
        const read = await readDestinations();
        if (host.state() !== "down") return;
        if (read !== null && read.count < 1) {
          await host.idle();
          return;
        }
        if (read !== null && downRevision === null) {
          downRevision = read.revision;
        } else if (read !== null && read.revision !== downRevision) {
          downRevision = null;
          await host.revive();
          return;
        }
        schedulePoll(DOWN_RECHECK_MS);
      });
    }, ms);
    unref(pollTimer);
  }

  function rejectAll(error: () => Error): void {
    for (const [ref, p] of pending) {
      pending.delete(ref);
      timers.clearTimeout(p.timer);
      p.reject(error());
    }
  }

  function receive(message: WorkerMessage): void {
    switch (message.type) {
      case "status": {
        latest = message.destinations;
        deps.metrics?.fold(message);
        const key = materialKey(latest);
        if (key !== lastKey) {
          lastKey = key;
          deps.onChange?.();
        }
        return;
      }
      case "paused":
        return;
      default: {
        const p = pending.get(message.ref);
        if (p === undefined || p.type !== REPLY_TYPE[message.type]) return;
        pending.delete(message.ref);
        timers.clearTimeout(p.timer);
        p.resolve(message);
      }
    }
  }

  async function readDestinations(): Promise<DestinationsRead | null> {
    try {
      return await deps.readDestinations();
    } catch {
      logger.warn("export destinations unreadable", { reason: "store read failed" });
      return null;
    }
  }

  async function startIfWanted(): Promise<void> {
    const read = await readDestinations();
    if (host.state() === "stopped") return;
    if (read === null || read.count < 1) {
      await host.idle();
      return;
    }
    await host.start();
  }

  return {
    start: () =>
      serial(async () => {
        if (host.state() === "idle") await startIfWanted();
      }),
    destinationsChanged: () =>
      serial(async () => {
        if (held()) return;
        const read = await readDestinations();
        if (read === null || held()) return;
        if (read.count < 1) {
          await host.idle();
          latest = [];
          lastKey = materialKey([]);
          deps.metrics?.retain(new Set());
          return;
        }
        switch (host.state()) {
          case "running":
            host.post({ type: "destinationsChanged" });
            return;
          case "down":
            downRevision = null;
            await host.revive();
            return;
          case "idle":
            await host.start();
            return;
          default:
            // The next worker reads configuration when it starts.
            return;
        }
      }),
    request<R extends ExportRequest>(request: R): Promise<ReplyOf[R["type"]]> {
      if (host.state() !== "running") return Promise.reject(notRunning());
      nextRef += 1;
      const ref = String(nextRef);
      return new Promise<ReplyOf[R["type"]]>((resolve, reject) => {
        const timer = timers.setTimeout(() => {
          if (!pending.delete(ref)) return;
          logger.warn("export worker did not reply in time", { reason: request.type });
          reject(new GatewayError("TIMEOUT", NO_REPLY));
        }, REQUEST_TIMEOUT_MS[request.type]);
        unref(timer);
        pending.set(ref, {
          type: request.type,
          resolve: resolve as (reply: Reply) => void,
          reject,
          timer,
        });
        host.post({ ...request, ref } as MainMessage);
      });
    },
    pause: () => serial(() => host.pause((message) => message.type === "paused")),
    resume: (swapped) => serial(() => host.resume(swapped)),
    halt: () => serial(() => host.halt()),
    stop() {
      cancelPoll();
      host.stop();
    },
    state: () => host.state(),
    statuses: () => latest,
    restarts: () => host.restarts(),
  };
}
