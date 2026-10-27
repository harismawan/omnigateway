import { GatewayError, type Logger } from "@omni/ir";

/** `onExit` means the thread's close event, not error or terminate returning. */
export type HostedWorker<In, Out> = {
  post(message: In): void;
  onMessage(listener: (message: Out) => void): void;
  onExit(listener: () => void): void;
  terminate(): void;
};

export type Timers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type WorkerHostState =
  | "idle"
  | "running"
  | "restarting"
  | "down"
  | "paused"
  | "halted"
  | "stopping"
  | "stopped";

export const PAUSE_ACK_MS = 5_000;
export const STOP_TERMINATE_MS = 5_000;
export const TERMINATE_WAIT_MS = 5_000;
export const RESTART_MIN_MS = 1_000;
export const RESTART_MAX_MS = 60_000;
export const RESTART_WINDOW_MS = 10 * 60 * 1000;
export const RESTART_GIVE_UP = 5;

export type WorkerHostDeps<In, Out> = {
  spawn: () => HostedWorker<In, Out>;
  /** Protocol values are supplied by the owner; the host knows no message shape. */
  lifecycle: { pause: In; resume: In; stop: In };
  timers: Timers;
  now: () => number;
  logger: Logger;
  name: string;
  onMessage(message: Out): void;
  /** Actual exit, including a retired worker. */
  onExit?(): void;
  /** Current worker left service (retired or exited): reject pending requests. */
  onUnavailable?(): void;
  onStarted?(): void;
  onRestart?(total: number): void;
  onStateChange?(state: WorkerHostState, previous: WorkerHostState): void;
  /** Owner policy, rechecked on resume without a worker and after a late exit. */
  shouldStart?(): Promise<boolean>;
};

export type WorkerHost<In, Out = unknown> = {
  start(): Promise<void>;
  post(message: In): void;
  pause(ack: (message: Out) => boolean): Promise<void>;
  resume(swapped: boolean): Promise<void>;
  halt(): Promise<void>;
  stop(terminate?: boolean): void;
  /** Stop serving without making shutdown final (e.g. no destinations). */
  idle(): Promise<void>;
  /** Explicit owner-policy change clears the death storm/backoff history. */
  revive(): Promise<void>;
  state(): WorkerHostState;
  restarts(): number;
};

type Instance<In, Out> = {
  worker: HostedWorker<In, Out>;
  startedAt: number;
  exited: Promise<void>;
  gone: boolean;
};

const unref = (handle: unknown): void => {
  (handle as { unref?: () => void } | null)?.unref?.();
};

/** Shared worker lifecycle; configuration polling and request routing stay with the owner. */
export function createWorkerHost<In, Out>(deps: WorkerHostDeps<In, Out>): WorkerHost<In, Out> {
  const { timers, logger, name } = deps;
  let state: WorkerHostState = "idle";
  let current: Instance<In, Out> | null = null;
  const retiring = new Set<Instance<In, Out>>();
  // Only a completed swap (or process restart) clears an unsafe database.
  let unsafe = false;
  let restartTimer: unknown = null;
  let consecutive = 0;
  let deaths: number[] = [];
  let restarts = 0;
  let pauseWaiter: { ack: (message: Out) => boolean; done: () => void } | null = null;

  const stopped = (): boolean => state === "stopped";
  const held = (): boolean => state === "paused" || state === "halted" || stopped();
  const setState = (next: WorkerHostState): void => {
    if (stopped()) return;
    const previous = state;
    state = next;
    deps.onStateChange?.(next, previous);
  };

  /** Lifecycle work is ordered, and one rejected pause never poisons the chain. */
  let chain: Promise<void> = Promise.resolve();
  const serial = (work: () => Promise<void>): Promise<void> => {
    const next = chain.then(work, work);
    chain = next.catch(() => {});
    return next;
  };

  function cancelRestart(): void {
    if (restartTimer !== null) timers.clearTimeout(restartTimer);
    restartTimer = null;
  }

  async function startIfWanted(): Promise<void> {
    const wanted = (await deps.shouldStart?.()) ?? true;
    if (stopped()) return;
    if (!wanted) {
      setState("idle");
      return;
    }
    spawn();
  }

  /** Never start alongside a retiring thread, even after a refused restore. */
  function spawn(): void {
    if (stopped()) return;
    if (retiring.size > 0) {
      setState("stopping");
      return;
    }
    const startedAt = deps.now();
    let worker: HostedWorker<In, Out>;
    try {
      worker = deps.spawn();
    } catch {
      logger.error(`${name} could not be started`, { reason: "spawn failed" });
      setState("running");
      died(startedAt);
      return;
    }
    let markExited = (): void => {};
    const instance: Instance<In, Out> = {
      worker,
      startedAt,
      gone: false,
      exited: new Promise<void>((resolve) => {
        markExited = resolve;
      }),
    };
    current = instance;
    deps.onStarted?.();
    worker.onMessage((message) => {
      if (instance !== current) return;
      if (pauseWaiter?.ack(message)) pauseWaiter.done();
      deps.onMessage(message);
    });
    worker.onExit(() => {
      instance.gone = true;
      const wasRetiring = retiring.delete(instance);
      markExited();
      if (instance === current) {
        current = null;
        deps.onUnavailable?.();
        pauseWaiter?.done();
        if (state === "running") died(instance.startedAt);
      }
      deps.onExit?.();
      if (wasRetiring && retiring.size === 0 && state === "stopping") {
        void serial(async () => {
          if (state === "stopping") await startIfWanted();
        });
      }
    });
    setState("running");
  }

  function retire(): Instance<In, Out> | null {
    const instance = current;
    current = null;
    deps.onUnavailable?.();
    pauseWaiter?.done();
    if (instance !== null && !instance.gone) retiring.add(instance);
    return instance;
  }

  function died(startedAt: number): void {
    if (stopped()) return;
    const at = deps.now();
    if (at - startedAt >= RESTART_WINDOW_MS) consecutive = 0;
    consecutive += 1;
    deaths = [...deaths.filter((t) => at - t < RESTART_WINDOW_MS), at];
    if (deaths.length >= RESTART_GIVE_UP) {
      logger.error(`${name} stopped restarting`, {
        reason: "five deaths in ten minutes",
        count: deaths.length,
      });
      setState("down");
      return;
    }
    const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** (consecutive - 1));
    logger.warn(`${name} died; restarting`, { retryAfterMs: delay });
    setState("restarting");
    restartTimer = timers.setTimeout(() => {
      restartTimer = null;
      if (state !== "restarting") return;
      restarts += 1;
      deps.onRestart?.(restarts);
      spawn();
    }, delay);
    unref(restartTimer);
  }

  function stopWorker(instance: Instance<In, Out>): void {
    try {
      instance.worker.post(deps.lifecycle.stop);
    } catch {
      // Already gone.
    }
    const timer = timers.setTimeout(() => instance.worker.terminate(), STOP_TERMINATE_MS);
    unref(timer);
    instance.worker.onExit(() => timers.clearTimeout(timer));
  }

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

  function resetDeaths(): void {
    deaths = [];
    consecutive = 0;
  }

  return {
    start: () =>
      serial(async () => {
        if (state === "idle") spawn();
      }),
    post(message) {
      if (state !== "running" || current === null) {
        throw new GatewayError("OVERLOADED", `${name} not running`);
      }
      current.worker.post(message);
    },
    idle: () =>
      serial(async () => {
        if (held()) return;
        cancelRestart();
        const instance = retire();
        if (instance !== null) stopWorker(instance);
        setState("idle");
      }),
    revive: () =>
      serial(async () => {
        if (held() || state === "running" || state === "stopping") return;
        cancelRestart();
        resetDeaths();
        spawn();
      }),
    pause: (ack) =>
      serial(async () => {
        if (stopped()) return;
        cancelRestart();
        setState("paused");
        const instance = current;
        if (instance !== null) {
          const acked = await new Promise<boolean>((resolve) => {
            const timer = timers.setTimeout(() => {
              pauseWaiter = null;
              resolve(false);
            }, PAUSE_ACK_MS);
            unref(timer);
            pauseWaiter = {
              ack,
              done: () => {
                pauseWaiter = null;
                timers.clearTimeout(timer);
                resolve(true);
              },
            };
            instance.worker.post(deps.lifecycle.pause);
          });
          if (!acked && current === instance) {
            logger.warn(`${name} did not pause in time; terminated`, { reason: "pause timeout" });
            retire();
          }
        }
        if (!(await drainRetiring())) {
          logger.error(`${name} did not exit; restore refused`, {
            reason: "terminate timeout",
            count: retiring.size,
          });
          throw new GatewayError("OVERLOADED", `${name} did not stop; nothing was restored`);
        }
      }),
    resume: (swapped) =>
      serial(async () => {
        if (state !== "paused") return;
        if (swapped) unsafe = false;
        if (unsafe) {
          const instance = retire();
          if (instance !== null) stopWorker(instance);
          setState("halted");
          return;
        }
        if (current !== null) {
          current.worker.post(deps.lifecycle.resume);
          setState("running");
          return;
        }
        resetDeaths();
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
    stop(terminate = false) {
      if (stopped()) return;
      cancelRestart();
      const instance = retire();
      state = "stopped";
      if (instance !== null) {
        if (terminate) instance.worker.terminate();
        else stopWorker(instance);
      }
    },
    state: () => state,
    restarts: () => restarts,
  };
}
