import { SlidingWindow, type WindowCounter } from "@omni/ratelimit";

/**
 * Coordination between the processes serving one installation.
 *
 * Every counter that used to be a module-scope `Map` lives behind this
 * interface, so that one gateway process and a fleet of them run the same
 * code: the fleet hands in an implementation backed by a shared service, the
 * single process hands in `memoryCoord`, which is the maps it had before.
 *
 * Pure like `@omni/ratelimit`: no clock, no I/O, `now` a parameter wherever
 * time matters. The one property every implementation must hold is that a
 * claim is visible to every concurrent claimant **the instant the call is
 * made** — before the returned promise settles. A claim recorded after a yield
 * lets every concurrent check judge the same pre-burst snapshot, which is
 * exactly what the callers exist to prevent.
 */
export interface Coord {
  window: {
    /**
     * Records one event at `now` and reports what the window held before it.
     *
     * Unconditional: the ceiling is judged by the caller, which holds every
     * dimension's figure and renders headroom from the one evaluation. What
     * this guarantees is that two claims taken together each see the other.
     */
    claim(key: string, windowMs: number, now: number): Promise<WindowClaim>;
    /** Gives back one stamp. Silent when it already aged out. */
    rollback(key: string, stamp: number): Promise<void>;
  };
  gauge: {
    /**
     * Raises the gauge and reports what it held before.
     *
     * `ttlMs` bounds how long a slot is held by a process that never releases
     * it. An in-memory gauge dies with its process and ignores it; a shared one
     * cannot know a holder died any other way.
     */
    acquire(key: string, ttlMs: number): Promise<number>;
    /** Lowers the gauge. Never below zero. */
    release(key: string): Promise<void>;
    read(key: string): Promise<number>;
    /** Every held key under `prefix`, with its count. Zero counts are absent. */
    snapshot(prefix: string): Promise<ReadonlyMap<string, number>>;
  };
  mutex: {
    /**
     * Runs `fn` while holding `key`, or throws `LOCK_UNAVAILABLE` once `waitMs`
     * has passed without acquiring it. `ttlMs` bounds a holder that never
     * returns.
     */
    withLock<T>(key: string, ttlMs: number, waitMs: number, fn: () => Promise<T>): Promise<T>;
  };
  /**
   * Small values with a lifetime: sessions, pending OAuth flows, probe
   * cooldowns. Nothing here is durable, and a value that outlives its TTL is
   * the one thing an implementation must never serve.
   */
  kv: {
    set(key: string, value: string, ttlMs: number): Promise<void>;
    get(key: string): Promise<string | null>;
    del(key: string): Promise<void>;
    /** Every key under `prefix`. For ending sessions of one kind, not for listing. */
    delPrefix(prefix: string): Promise<void>;
  };
}

export type WindowClaim = { stamp: number; before: WindowCounter };

export class LockUnavailable extends Error {
  constructor(key: string) {
    super(`LOCK_UNAVAILABLE: ${key}`);
    this.name = "LockUnavailable";
  }
}

/** How often the drained-ring sweep may run; see `sweep`. */
const SWEEP_INTERVAL_MS = 1_000;

export type MemoryCoord = Coord & {
  /** Rings currently held, which is everything the window map can grow. */
  liveWindows(): number;
};

export type MemoryCoordOptions = {
  /** The clock `kv` expires against. Injected so a test can move it. */
  now?: () => number;
};

/**
 * The single-process implementation: the maps the gateway held before it had
 * an interface to put them behind.
 *
 * Every method mutates synchronously and returns an already-settled promise,
 * which is what makes the visibility property above hold here without a lock.
 */
export function memoryCoord(options: MemoryCoordOptions = {}): MemoryCoord {
  const now = options.now ?? (() => Date.now());
  const windows = new Map<string, SlidingWindow>();
  const gauges = new Map<string, number>();
  const locks = new Map<string, Promise<void>>();
  const values = new Map<string, { value: string; expiresAt: number }>();
  let lastSweep = Number.NEGATIVE_INFINITY;

  /**
   * Drops rings that drained, at most once per interval.
   *
   * A latch on wall-clock time, so a backward clock step leaves it in the
   * future and the elapsed figure negative; that must read as "sweep now", not
   * "swept recently", or the sweep is held off for the length of the step.
   */
  const sweep = (now: number): void => {
    const since = now - lastSweep;
    if (since >= 0 && since < SWEEP_INTERVAL_MS) return;
    lastSweep = now;
    for (const [key, ring] of windows) {
      ring.count(now);
      if (ring.empty) windows.delete(key);
    }
  };

  return {
    liveWindows: () => windows.size,

    window: {
      claim(key, windowMs, now) {
        sweep(now);
        let ring = windows.get(key);
        if (ring === undefined) {
          ring = new SlidingWindow(windowMs);
          windows.set(key, ring);
        }
        const before = { used: ring.count(now), resetAt: ring.resetAt(now) };
        ring.record(now);
        return Promise.resolve({ stamp: now, before });
      },
      rollback(key, stamp) {
        windows.get(key)?.forget(stamp);
        return Promise.resolve();
      },
    },

    gauge: {
      acquire(key) {
        const before = gauges.get(key) ?? 0;
        gauges.set(key, before + 1);
        return Promise.resolve(before);
      },
      release(key) {
        const next = (gauges.get(key) ?? 0) - 1;
        if (next > 0) gauges.set(key, next);
        else gauges.delete(key);
        return Promise.resolve();
      },
      read(key) {
        return Promise.resolve(gauges.get(key) ?? 0);
      },
      snapshot(prefix) {
        const out = new Map<string, number>();
        for (const [key, count] of gauges) if (key.startsWith(prefix)) out.set(key, count);
        return Promise.resolve(out);
      },
    },

    kv: {
      set(key, value, ttlMs) {
        values.set(key, { value, expiresAt: now() + ttlMs });
        return Promise.resolve();
      },
      get(key) {
        const entry = values.get(key);
        if (entry === undefined) return Promise.resolve(null);
        if (entry.expiresAt <= now()) {
          values.delete(key);
          return Promise.resolve(null);
        }
        return Promise.resolve(entry.value);
      },
      del(key) {
        values.delete(key);
        return Promise.resolve();
      },
      delPrefix(prefix) {
        for (const key of values.keys()) if (key.startsWith(prefix)) values.delete(key);
        return Promise.resolve();
      },
    },

    mutex: {
      async withLock(key, _ttlMs, waitMs, fn) {
        // One timer for the whole wait, cleared once the lock is taken so a
        // short wait leaves nothing ticking behind it. No clock is read: the
        // timer firing is the only statement about elapsed time made here.
        // ponytail: contenders race, no fairness; a queue if one key ever
        // sees real contention.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const expired = new Promise<"expired">((resolve) => {
          timer = setTimeout(() => resolve("expired"), waitMs);
        });
        try {
          for (;;) {
            const held = locks.get(key);
            if (held === undefined) break;
            const outcome = await Promise.race([held.then(() => "released" as const), expired]);
            if (outcome === "expired") throw new LockUnavailable(key);
          }
        } finally {
          clearTimeout(timer);
        }
        let release: () => void = () => {};
        locks.set(
          key,
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        );
        try {
          return await fn();
        } finally {
          locks.delete(key);
          release();
        }
      },
    },
  };
}
