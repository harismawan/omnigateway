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
 *   client for nothing; the next creation starts a fresh one. While idle the
 *   store is re-read every {@link IDLE_RECHECK_MS}, so a destination another
 *   process created (the CLI, another cluster node) starts one here too.
 * - **Failure isolation**: a worker that dies is restarted after 1 s,
 *   doubling to 60 s; one that lived ten minutes was healthy, and the next
 *   death starts the backoff over. Five deaths within ten minutes and it
 *   stays down until the destinations change — locally, or as seen by
 *   polling the store every {@link DOWN_RECHECK_MS}, compared with what they
 *   were when it went down.
 * - **Gone means exited.** A worker counts as gone only on its exit (`close`),
 *   never on an error notification or on `terminate()` returning — Bun's
 *   `terminate` returns while a native call (a SQLite statement) runs on.
 *   Workers being stopped are tracked until they exit.
 * - **Restore**: `pause` posts `pause` and waits for `paused` — at most
 *   {@link PAUSE_ACK_MS}, then the worker is terminated — and waits, at most
 *   {@link TERMINATE_WAIT_MS}, for every terminated or stopping worker to
 *   exit. If one will not, `pause` rejects: the restore is refused and nothing
 *   is swapped. Restarts are suppressed until `resume`. After a failed swap
 *   (`halt`) export stays stopped through later restores until one swaps.
 * - **Requests** (`test`, `preview`, `skip`, `ackGap`) always settle: with the
 *   worker's reply, `503 export worker not running` when there is no worker
 *   or it dies first, or `504` after {@link REQUEST_TIMEOUT_MS}.
 * - **Stop** posts `stop` and does not wait (stoppers are synchronous); the
 *   worker is terminated after {@link STOP_TERMINATE_MS} if it has not exited.
 *   Stopped is final: lifecycle work still in flight spawns nothing and arms
 *   no timer after it.
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
  /**
   * A worker asked to stop (or terminated) has not exited yet. Nothing new is
   * started beside it; when it exits, the normal start conditions apply.
   */
  | "stopping"
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
/** How often a supervisor that gave up re-reads whether the destinations changed. */
export const DOWN_RECHECK_MS = 30_000;
/** How long `pause` waits for a terminated worker's thread to exit before refusing the swap. */
export const TERMINATE_WAIT_MS = 5_000;

export const NOT_RUNNING = "export worker not running";
const NO_REPLY = "export worker did not reply in time";
const NOT_QUIESCED = "export worker did not stop; nothing was restored";

/**
 * The destinations as the supervisor needs them: how many, and a revision
 * that changes whenever any of them is created, edited or removed
 * (generations and database `revision`s, read through the store's existing
 * list — no trigger, and no clock).
 */
export type DestinationsRead = { count: number; revision: string };

export type SupervisorDeps = {
  init: WorkerInit;
  /** `spawnExportWorker` in production; a fake in tests. */
  spawn: (init: WorkerInit) => ExportWorker;
  /** The destinations, read through the main store. */
  readDestinations: () => Promise<DestinationsRead>;
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
  /**
   * Restore step 1. Resolves once no worker holds a handle: the current one
   * acked `paused`, or every worker — terminated, or still stopping — has
   * exited. Rejects (`503`, fixed message) when one will not exit: the
   * caller must not swap.
   */
  pause(): Promise<void>;
  /**
   * Restore step 3, on success (`swapped`) or on a failure before the swap
   * began. A halted supervisor stays halted unless `swapped`.
   */
  resume(swapped: boolean): Promise<void>;
  /** Restore step 3 after a `SwapFailedError`: export stays stopped. */
  halt(): Promise<void>;
  /** For `stopLoops`: synchronous. */
  stop(): void;
  state(): SupervisorState;
  /** The latest status the worker sent, per destination; empty before the first. */
  statuses(): readonly DestinationStatus[];
  restarts(): number;
};

type Instance = {
  worker: ExportWorker;
  startedAt: number;
  /** Settles when the thread has exited. */
  exited: Promise<void>;
  gone: boolean;
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
  /** Workers asked to stop (or terminated) whose thread has not exited yet. */
  const retiring = new Set<Instance>();
  /**
   * A swap failed: the database is in an unknown state. Survives pause and
   * resume; only a swap that completes (or a process restart) clears it.
   */
  let unsafe = false;
  /** The destinations' revision when the supervisor gave up; null otherwise. */
  let downRevision: string | null = null;
  let restartTimer: unknown = null;
  let pollTimer: unknown = null;
  let consecutive = 0;
  let deaths: number[] = [];
  let restarts = 0;
  let latest: DestinationStatus[] = [];
  let lastKey = materialKey([]);
  let nextRef = 0;
  const pending = new Map<string, Pending>();
  let pauseWaiter: (() => void) | null = null;

  const stopped = (): boolean => state === "stopped";
  /** Held by a restore, a failed swap or shutdown: nothing may start or wake a worker. */
  const held = (): boolean => state === "paused" || state === "halted" || state === "stopped";

  const setState = (next: SupervisorState): void => {
    if (stopped()) return;
    cancelPoll();
    if (state !== next) {
      state = next;
      deps.onChange?.();
    }
    if (next === "idle") schedulePoll(IDLE_RECHECK_MS);
    if (next === "down") schedulePoll(DOWN_RECHECK_MS);
  };

  function cancelPoll(): void {
    if (pollTimer !== null) timers.clearTimeout(pollTimer);
    pollTimer = null;
  }

  /**
   * Idle or down, look at the store again later: a destination another
   * process created or edited reaches this one only through it.
   */
  function schedulePoll(ms: number): void {
    cancelPoll();
    if (stopped()) return;
    pollTimer = timers.setTimeout(() => {
      pollTimer = null;
      void serial(async () => {
        if (state === "idle") {
          await startIfWanted();
          return;
        }
        if (state !== "down") return;
        const read = await readDestinations();
        if (state !== "down") return;
        if (read !== null && read.count < 1) {
          setState("idle");
          return;
        }
        if (read !== null && downRevision === null) {
          // Unreadable when it gave up: this read is the baseline, not a change.
          downRevision = read.revision;
        } else if (read !== null && read.revision !== downRevision) {
          revive();
          return;
        }
        schedulePoll(DOWN_RECHECK_MS);
      });
    }, ms);
    unref(pollTimer);
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

  /** The only way a worker starts. Never beside one that has not exited. */
  function spawn(): void {
    if (stopped()) return;
    if (retiring.size > 0) {
      setState("stopping");
      return;
    }
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
    let markExited = (): void => {};
    const instance: Instance = {
      worker,
      startedAt,
      gone: false,
      exited: new Promise<void>((resolve) => {
        markExited = resolve;
      }),
    };
    current = instance;
    deps.metrics?.instanceStarted();
    worker.onMessage((message) => receive(instance, message));
    worker.onExit(() => {
      instance.gone = true;
      const wasRetiring = retiring.delete(instance);
      markExited();
      exited(instance);
      // The last stopping worker is gone: whatever waited on it may start now.
      if (wasRetiring && retiring.size === 0 && state === "stopping") {
        void serial(async () => {
          if (state === "stopping") await startIfWanted();
        });
      }
    });
    setState("running");
  }

  /** Takes the current worker out of service; its exit is then not a death. */
  function retire(): Instance | null {
    const instance = current;
    current = null;
    rejectAll(notRunning);
    pauseWaiter?.();
    if (instance !== null && !instance.gone) retiring.add(instance);
    return instance;
  }

  function exited(instance: Instance): void {
    if (instance !== current) return;
    current = null;
    rejectAll(notRunning);
    pauseWaiter?.();
    if (state !== "running") return;
    died(instance.startedAt);
  }

  /** A worker that started at `startedAt` is gone while it should run: restart, or give up. */
  function died(startedAt: number): void {
    if (stopped()) return;
    const at = deps.now();
    if (at - startedAt >= RESTART_WINDOW_MS) consecutive = 0;
    consecutive += 1;
    deaths = [...deaths.filter((t) => at - t < RESTART_WINDOW_MS), at];
    if (deaths.length >= RESTART_GIVE_UP) {
      logger.error("export worker stopped restarting", {
        reason: "five deaths in ten minutes",
        count: deaths.length,
      });
      void serial(async () => {
        const read = await readDestinations();
        if (state !== "down") return;
        // Null when unreadable: the next readable poll becomes the baseline.
        downRevision = read?.revision ?? null;
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

  function revive(): void {
    deaths = [];
    consecutive = 0;
    downRevision = null;
    spawn();
  }

  function cancelRestart(): void {
    if (restartTimer !== null) timers.clearTimeout(restartTimer);
    restartTimer = null;
  }

  async function readDestinations(): Promise<DestinationsRead | null> {
    try {
      return await deps.readDestinations();
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

  /**
   * Terminates every retiring worker and waits for each thread to exit, at
   * most {@link TERMINATE_WAIT_MS}. True when none is left.
   */
  async function drainRetiring(): Promise<boolean> {
    if (retiring.size === 0) return true;
    for (const instance of retiring) instance.worker.terminate();
    let timer: unknown = null;
    const allGone = await Promise.race([
      Promise.all([...retiring].map((i) => i.exited)).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = timers.setTimeout(() => resolve(false), TERMINATE_WAIT_MS);
        unref(timer);
      }),
    ]);
    timers.clearTimeout(timer);
    return allGone && retiring.size === 0;
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

  /** Spawns when a destination exists; otherwise idles. Re-checks `stopped` after its read. */
  async function startIfWanted(): Promise<void> {
    const read = await readDestinations();
    if (stopped()) return;
    if (read === null || read.count < 1) {
      setState("idle");
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
        if (held()) return;
        const read = await readDestinations();
        // Re-read after the await: a pause, halt or stop may have landed.
        if (read === null || held()) return;
        if (read.count < 1) {
          cancelRestart();
          const instance = retire();
          if (instance !== null) stopWorker(instance);
          setState("idle");
          forget();
          return;
        }
        switch (state) {
          case "running":
            current?.worker.post({ type: "destinationsChanged" });
            return;
          case "down":
            revive();
            return;
          case "idle":
            spawn();
            return;
          case "restarting":
          case "stopping":
            // The next worker reads configuration when it starts.
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
        if (stopped()) return;
        cancelRestart();
        cancelPoll();
        if (state !== "paused") setState("paused");
        const instance = current;
        if (instance !== null) {
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
            retire();
          }
        }
        // Every worker that is not the acked one — terminated above, or still
        // stopping from an earlier removal — must have exited before the swap.
        if (!(await drainRetiring())) {
          logger.error("export worker did not exit; restore refused", {
            reason: "terminate timeout",
            count: retiring.size,
          });
          throw new GatewayError("OVERLOADED", NOT_QUIESCED);
        }
      }),

    resume: (swapped) =>
      serial(async () => {
        if (state !== "paused") return;
        if (swapped) unsafe = false;
        if (unsafe) {
          // The database is still the one a swap left half-done.
          const instance = retire();
          if (instance !== null) stopWorker(instance);
          setState("halted");
          return;
        }
        if (current !== null) {
          current.worker.post({ type: "resume" });
          setState("running");
          return;
        }
        // None ran, or the one that did was terminated: start one if wanted.
        deaths = [];
        consecutive = 0;
        downRevision = null;
        await startIfWanted();
      }),

    halt: () =>
      serial(async () => {
        if (stopped()) return;
        unsafe = true;
        cancelRestart();
        const instance = retire();
        setState("halted");
        if (instance !== null) stopWorker(instance);
      }),

    stop() {
      if (stopped()) return;
      cancelRestart();
      cancelPoll();
      const instance = retire();
      state = "stopped";
      if (instance !== null) stopWorker(instance);
    },

    state: () => state,
    statuses: () => latest,
    restarts: () => restarts,
  };
}
