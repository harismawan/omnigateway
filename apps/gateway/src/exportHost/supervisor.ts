import { GatewayError, type Logger } from "@omni/ir";
import type {
  DestinationStatus,
  MainMessage,
  WorkerInit,
  WorkerMessage,
} from "../export/protocol.ts";
import type { ExportWorker } from "../export/spawn.ts";
import type { ExportMetrics } from "./metrics.ts";

/**
 * The main thread's half of the export worker: when it runs, how a dead one
 * is restarted, how a restore pauses it, and how a request to it always ends.
 * Design: docs/superpowers/specs/2026-10-24-log-export-design.md
 * (*Asynchrony* start conditions, *Failure isolation*, *Restore and import*,
 * *Delivery* → Shutdown). The main thread never touches export state: it
 * spawns, posts, and keeps the latest status the worker sent.
 *
 * - **Start** once the store is open and migrated, only when a destination
 *   exists, and on the first destination's creation (`destinationsChanged`).
 *   Removing the last destination stops the worker — an idle worker holds a
 *   read handle, an `export.db` and, in cluster mode, a pool and a Redis
 *   client for nothing; the next creation starts a fresh one.
 * - **Failure isolation**: a worker that dies is restarted after 1 s,
 *   doubling to 60 s; one that lived ten minutes was healthy, and the next
 *   death starts the backoff over. Five deaths within ten minutes and it
 *   stays down until the next destination change.
 * - **Restore**: `pause` posts `pause` and waits for `paused` — at most
 *   {@link PAUSE_ACK_MS}, then the worker is terminated — and suppresses
 *   restarts until `resume` (or `halt`, for a swap that failed).
 * - **Requests** (`test`, `preview`, `skip`, `ackGap`) always settle: with the
 *   worker's reply, `503 export worker not running` when there is no worker
 *   or it dies first, or `504` after {@link REQUEST_TIMEOUT_MS}.
 * - **Stop** posts `stop` and does not wait (stoppers are synchronous); the
 *   worker is terminated after {@link STOP_TERMINATE_MS} if it has not exited.
 */

/** Injected so tests drive time; `setTimeout`/`clearTimeout` in production. */
export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type SupervisorState =
  /** No worker, because no destination exists. */
  | "idle"
  | "running"
  /** Dead; a restart is scheduled. */
  | "restarting"
  /** Died five times in ten minutes; waits for a destination change. */
  | "down"
  /** A restore or import holds it; nothing restarts it until `resume`. */
  | "paused"
  /** A swap failed; the operator's restart (or a later restore) brings it back. */
  | "halted"
  | "stopped";

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

/** How long a request waits for its reply: a test sends to a receiver, the rest read. */
export const REQUEST_TIMEOUT_MS: Readonly<Record<ExportRequest["type"], number>> = {
  test: 30_000,
  preview: 10_000,
  skip: 10_000,
  ackGap: 10_000,
};

/** The spec's pause budget: no `paused` within it and the worker is terminated. */
export const PAUSE_ACK_MS = 5_000;
/** The shutdown drain budget; a worker still alive after it is terminated. */
export const STOP_TERMINATE_MS = 5_000;
export const RESTART_MIN_MS = 1_000;
export const RESTART_MAX_MS = 60_000;
/** Deaths within this window count toward giving up; a worker that lived this long was healthy. */
export const RESTART_WINDOW_MS = 10 * 60 * 1000;
export const RESTART_GIVE_UP = 5;
/** How often an idle supervisor re-reads whether a destination now exists. */
export const IDLE_RECHECK_MS = 30_000;

export const NOT_RUNNING = "export worker not running";
const NO_REPLY = "export worker did not reply in time";

export type SupervisorDeps = {
  init: WorkerInit;
  /** `spawnExportWorker` in production; a fake in tests. */
  spawn: (init: WorkerInit) => ExportWorker;
  /** How many destinations exist, read through the main store. */
  countDestinations: () => Promise<number>;
  timers: Timers;
  now: () => number;
  logger: Logger;
  /** Absent when `/metrics` is off. */
  metrics?: ExportMetrics;
  /** Status or worker state changed materially: `res:export`. */
  onChange?: () => void;
};

export type ExportSupervisor = {
  start(): Promise<void>;
  /** After every destination create, edit and removal. */
  destinationsChanged(): Promise<void>;
  request<R extends ExportRequest>(request: R): Promise<ReplyOf[R["type"]]>;
  /** Restore step 1. Resolves once the worker has acked, been terminated, or there was none. */
  pause(): Promise<void>;
  /** Restore step 3, on success or on a failure before the swap began. */
  resume(): Promise<void>;
  /** Restore step 3 after a `SwapFailedError`: export stays stopped. */
  halt(): Promise<void>;
  /** For `stopLoops`: synchronous. */
  stop(): void;
  state(): SupervisorState;
  /** The latest status the worker sent, per destination; empty before the first. */
  statuses(): readonly DestinationStatus[];
  restarts(): number;
};

type Instance = { worker: ExportWorker; startedAt: number };

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

/**
 * Fields a console shows besides lag and counters. A status differing only
 * in those is not announced: lag moves on every status, and the console reads
 * it when something else makes it refetch.
 */
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
  let state: SupervisorState = "idle";
  let current: Instance | null = null;
  let restartTimer: unknown = null;
  let consecutive = 0;
  let deaths: number[] = [];
  let restarts = 0;
  let latest: DestinationStatus[] = [];
  let lastKey = materialKey([]);
  let nextRef = 0;
  const pending = new Map<string, Pending>();
  let pauseWaiter: (() => void) | null = null;
  let idleTimer: unknown = null;

  const setState = (next: SupervisorState): void => {
    if (next !== "idle") cancelIdle();
    if (state === next) return;
    state = next;
    deps.onChange?.();
    if (next === "idle") scheduleIdle();
  };

  function cancelIdle(): void {
    if (idleTimer !== null) timers.clearTimeout(idleTimer);
    idleTimer = null;
  }

  /**
   * While idle, look again now and then: a destination created by another
   * process — `omni export add` on this installation, or another node of a
   * cluster — reaches this one only through the store.
   */
  function scheduleIdle(): void {
    cancelIdle();
    idleTimer = timers.setTimeout(() => {
      idleTimer = null;
      void serial(async () => {
        if (state !== "idle") return;
        await startIfWanted();
      });
    }, IDLE_RECHECK_MS);
    unref(idleTimer);
  }

  const rejectAll = (error: () => Error): void => {
    for (const [ref, p] of pending) {
      pending.delete(ref);
      timers.clearTimeout(p.timer);
      p.reject(error());
    }
  };

  const notRunning = (): GatewayError => new GatewayError("OVERLOADED", NOT_RUNNING);

  function receive(instance: Instance, message: WorkerMessage): void {
    if (instance !== current) return;
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
        pauseWaiter?.();
        return;
      default: {
        const p = pending.get(message.ref);
        // A reply nobody waits for any more (timed out) is dropped.
        if (p === undefined || p.type !== REPLY_TYPE[message.type]) return;
        pending.delete(message.ref);
        timers.clearTimeout(p.timer);
        p.resolve(message);
      }
    }
  }

  function spawn(): void {
    const startedAt = deps.now();
    let worker: ExportWorker;
    try {
      worker = deps.spawn(deps.init);
    } catch {
      // A fixed reason: the error names a path.
      logger.error("export worker could not be started", { reason: "spawn failed" });
      setState("running");
      died(startedAt);
      return;
    }
    const instance: Instance = { worker, startedAt };
    current = instance;
    deps.metrics?.instanceStarted();
    worker.onMessage((message) => receive(instance, message));
    worker.onExit(() => exited(instance));
    setState("running");
  }

  /** Detaches the current worker so its exit is not read as a death. */
  function detach(): Instance | null {
    const instance = current;
    current = null;
    rejectAll(notRunning);
    pauseWaiter?.();
    return instance;
  }

  function exited(instance: Instance): void {
    if (instance !== current) return;
    current = null;
    rejectAll(notRunning);
    pauseWaiter?.();
    // An `error` event may precede the exit; make sure it is gone.
    try {
      instance.worker.terminate();
    } catch {
      // already gone
    }
    if (state !== "running") return;
    died(instance.startedAt);
  }

  /** A worker that started at `startedAt` is gone while it should run: restart, or give up. */
  function died(startedAt: number): void {
    const at = deps.now();
    if (at - startedAt >= RESTART_WINDOW_MS) consecutive = 0;
    consecutive += 1;
    deaths = [...deaths.filter((t) => at - t < RESTART_WINDOW_MS), at];
    if (deaths.length >= RESTART_GIVE_UP) {
      logger.error("export worker stopped restarting", {
        reason: "five deaths in ten minutes",
        count: deaths.length,
      });
      setState("down");
      return;
    }
    const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** (consecutive - 1));
    logger.warn("export worker died; restarting", { retryAfterMs: delay });
    setState("restarting");
    restartTimer = timers.setTimeout(() => {
      restartTimer = null;
      if (state !== "restarting") return;
      restarts += 1;
      deps.metrics?.restarts(restarts);
      spawn();
    }, delay);
    unref(restartTimer);
  }

  function cancelRestart(): void {
    if (restartTimer !== null) timers.clearTimeout(restartTimer);
    restartTimer = null;
  }

  async function count(): Promise<number | null> {
    try {
      return await deps.countDestinations();
    } catch {
      logger.warn("export destinations unreadable", { reason: "store read failed" });
      return null;
    }
  }

  function stopWorker(instance: Instance): void {
    try {
      instance.worker.post({ type: "stop" });
    } catch {
      // gone already
    }
    const timer = timers.setTimeout(() => instance.worker.terminate(), STOP_TERMINATE_MS);
    unref(timer);
    instance.worker.onExit(() => timers.clearTimeout(timer));
  }

  function forget(): void {
    latest = [];
    lastKey = materialKey([]);
    deps.metrics?.retain(new Set());
  }

  /** Lifecycle steps run one at a time, in call order. */
  let chain: Promise<void> = Promise.resolve();
  const serial = (work: () => Promise<void>): Promise<void> => {
    const next = chain.then(work, work);
    chain = next.catch(() => {});
    return next;
  };

  async function startIfWanted(): Promise<void> {
    const n = await count();
    if (n === null || n < 1) {
      if (state === "idle") scheduleIdle();
      else setState("idle");
      return;
    }
    spawn();
  }

  return {
    start: () =>
      serial(async () => {
        if (state !== "idle") return;
        await startIfWanted();
      }),

    destinationsChanged: () =>
      serial(async () => {
        if (state === "paused" || state === "halted" || state === "stopped") return;
        const n = await count();
        if (n === null) return;
        if (n < 1) {
          cancelRestart();
          const instance = detach();
          if (state !== "idle") setState("idle");
          if (instance !== null) stopWorker(instance);
          forget();
          return;
        }
        switch (state) {
          case "running":
            current?.worker.post({ type: "destinationsChanged" });
            return;
          case "down":
            deaths = [];
            consecutive = 0;
            spawn();
            return;
          case "idle":
            spawn();
            return;
          case "restarting":
            // The new worker reads configuration when it starts.
            return;
        }
      }),

    request<R extends ExportRequest>(request: R): Promise<ReplyOf[R["type"]]> {
      const instance = current;
      if (state !== "running" || instance === null) return Promise.reject(notRunning());
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
        instance.worker.post({ ...request, ref } as MainMessage);
      });
    },

    pause: () =>
      serial(async () => {
        if (state === "stopped" || state === "paused") return;
        cancelRestart();
        cancelIdle();
        const instance = current;
        setState("paused");
        if (instance === null) return;
        const acked = await new Promise<boolean>((resolve) => {
          const timer = timers.setTimeout(() => {
            pauseWaiter = null;
            resolve(false);
          }, PAUSE_ACK_MS);
          unref(timer);
          pauseWaiter = () => {
            pauseWaiter = null;
            timers.clearTimeout(timer);
            resolve(true);
          };
          instance.worker.post({ type: "pause" });
        });
        if (!acked && current === instance) {
          logger.warn("export worker did not pause in time; terminated", {
            reason: "pause timeout",
          });
          detach();
          instance.worker.terminate();
        }
      }),

    resume: () =>
      serial(async () => {
        if (state !== "paused") return;
        if (current !== null) {
          current.worker.post({ type: "resume" });
          setState("running");
          return;
        }
        // None ran, or the one that did was terminated: start one if wanted.
        deaths = [];
        consecutive = 0;
        state = "idle";
        deps.onChange?.();
        await startIfWanted();
      }),

    halt: () =>
      serial(async () => {
        if (state === "stopped") return;
        cancelRestart();
        const instance = detach();
        setState("halted");
        if (instance !== null) stopWorker(instance);
      }),

    stop() {
      if (state === "stopped") return;
      cancelRestart();
      cancelIdle();
      const instance = detach();
      state = "stopped";
      if (instance !== null) stopWorker(instance);
    },

    state: () => state,
    statuses: () => latest,
    restarts: () => restarts,
  };
}
