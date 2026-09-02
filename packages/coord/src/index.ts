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
   * Counters in time buckets, for the long rate-limit windows.
   *
   * A window is the sum of its live buckets — those whose start is within
   * `windowMs` of `now` — so it slides at the grain and over-counts by at most
   * one bucket at the trailing edge, which is the direction the limiter
   * permits. `sum` answers `null` for a key nothing has seeded, and that is a
   * distinct answer from zero: the caller seeds from the store and asks again.
   */
  buckets: {
    add(key: string, grainMs: number, windowMs: number, now: number, delta: Counts): Promise<void>;
    sum(key: string, grainMs: number, windowMs: number, now: number): Promise<Counts | null>;
    /**
     * Installs a starting picture, replacing whatever was there. Until a key
     * is seeded, `add` on it is ignored: the row behind the debit is already in
     * the store the seed reads, and a picture holding one request must not
     * pass for a complete one.
     */
    seed(
      key: string,
      grainMs: number,
      windowMs: number,
      now: number,
      rows: ReadonlyArray<readonly [bucketStart: number, counts: Counts]>,
    ): Promise<void>;
  };
  /**
   * One holder at a time for a named job, for the background loops.
   *
   * A lease that cannot be confirmed is one the caller does not hold; the
   * in-memory implementation always grants, because one process is always the
   * one.
   */
  lease: {
    acquire(name: string, holderId: string, ttlMs: number): Promise<boolean>;
    release(name: string, holderId: string): Promise<void>;
  };
  /**
   * Fan-out between processes. In memory it is an emitter; the subscriber sees
   * every publish, its own included, so a consumer must be written for that.
   */
  pubsub: {
    publish(topic: string, payload: string): Promise<void>;
    /** `pattern` may end in `*`, matching any suffix. Returns the unsubscribe. */
    subscribe(pattern: string, fn: (topic: string, payload: string) => void): () => void;
  };
  /** A counter shared by every process, starting at 1. */
  incr(key: string): Promise<number>;
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

export type Counts = { requests: number; tokens: number; costUsd: number };

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
  const buckets = new Map<string, Map<number, Counts>>();
  const leases = new Map<string, { holder: string; expiresAt: number }>();
  const subscribers = new Set<{ pattern: string; fn: (topic: string, payload: string) => void }>();
  const counters = new Map<string, number>();
  let lastSweep = Number.NEGATIVE_INFINITY;

  const bucketOf = (grainMs: number, at: number): number => Math.floor(at / grainMs) * grainMs;

  /** Drops buckets outside the window. A key keeps its seeded status even when empty. */
  const trimBuckets = (key: string, grainMs: number, windowMs: number, now: number): void => {
    const held = buckets.get(key);
    if (held === undefined) return;
    const oldest = bucketOf(grainMs, now - windowMs);
    for (const start of held.keys()) if (start < oldest) held.delete(start);
  };

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

    buckets: {
      add(key, grainMs, windowMs, now, delta) {
        trimBuckets(key, grainMs, windowMs, now);
        const held = buckets.get(key);
        // An unseeded key stays unseeded. The row this debit describes is
        // already in the store, so the seed that follows will count it; adding
        // it here would make a picture holding one request look complete.
        if (held === undefined) return Promise.resolve();
        const start = bucketOf(grainMs, now);
        const current = held.get(start) ?? { requests: 0, tokens: 0, costUsd: 0 };
        held.set(start, {
          requests: current.requests + delta.requests,
          tokens: current.tokens + delta.tokens,
          costUsd: current.costUsd + delta.costUsd,
        });
        return Promise.resolve();
      },
      sum(key, grainMs, windowMs, now) {
        trimBuckets(key, grainMs, windowMs, now);
        const held = buckets.get(key);
        if (held === undefined) return Promise.resolve(null);
        const total: Counts = { requests: 0, tokens: 0, costUsd: 0 };
        for (const counts of held.values()) {
          total.requests += counts.requests;
          total.tokens += counts.tokens;
          total.costUsd += counts.costUsd;
        }
        return Promise.resolve(total);
      },
      seed(key, grainMs, windowMs, now, rows) {
        const held = new Map<number, Counts>();
        for (const [start, counts] of rows) held.set(bucketOf(grainMs, start), { ...counts });
        buckets.set(key, held);
        trimBuckets(key, grainMs, windowMs, now);
        return Promise.resolve();
      },
    },

    lease: {
      acquire(name, holderId, ttlMs) {
        const held = leases.get(name);
        const at = now();
        if (held !== undefined && held.holder !== holderId && held.expiresAt > at) {
          return Promise.resolve(false);
        }
        leases.set(name, { holder: holderId, expiresAt: at + ttlMs });
        return Promise.resolve(true);
      },
      release(name, holderId) {
        if (leases.get(name)?.holder === holderId) leases.delete(name);
        return Promise.resolve();
      },
    },

    pubsub: {
      publish(topic, payload) {
        for (const sub of subscribers) {
          const hit = sub.pattern.endsWith("*")
            ? topic.startsWith(sub.pattern.slice(0, -1))
            : topic === sub.pattern;
          if (hit) sub.fn(topic, payload);
        }
        return Promise.resolve();
      },
      subscribe(pattern, fn) {
        const sub = { pattern, fn };
        subscribers.add(sub);
        return () => {
          subscribers.delete(sub);
        };
      },
    },

    incr(key) {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return Promise.resolve(next);
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
