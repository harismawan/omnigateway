import { type Coord, LockUnavailable, memoryCoord } from "@omni/coord";
import { describeError, GatewayError, type Logger, noopLogger } from "@omni/ir";
import { RedisClient } from "bun";

export type RedisCoordDeps = {
  url: string;
  logger?: Logger;
  now?: () => number;
  /** How long between two log lines about the same fault. */
  faultLogIntervalMs?: number;
};

export type RedisCoord = Coord & {
  /** Whether the last call reached Redis. What `/health` reports as `coord`. */
  healthy(): boolean;
  close(): void;
};

/** Every key this process writes, so an operator can find them and a flush can miss them. */
const NS = "omni:";

/** One channel carries every topic; the topic rides in the envelope. */
const CHANNEL = `${NS}pubsub`;

/** How often a contender re-tries a held lock. */
const LOCK_POLL_MS = 50;

const FAULT_LOG_INTERVAL_MS = 30_000;

/** How long the first call waits for the first connect before reading `connected`. */
const CONNECT_WAIT_MS = 2_000;

/** How often a dropped subscription is re-established. */
const RELISTEN_INTERVAL_MS = 5_000;

// --- Lua -----------------------------------------------------------------
//
// Each script is the atomic half of one primitive: what the in-memory
// implementation does between one call and the next return, done server-side
// so N processes see one another's claims the instant they land.

/** ZSET of stamps. Prunes, reads before, records. Returns [used, oldest|nil]. */
const WINDOW_CLAIM = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
  local used = redis.call('ZCARD', KEYS[1])
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[3])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return { used, oldest[2] }
`;

/** Removes exactly one member at the stamp's score. Silent when none. */
const WINDOW_ROLLBACK = `
  local one = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], ARGV[1], 'LIMIT', 0, 1)
  if one[1] then redis.call('ZREM', KEYS[1], one[1]) end
  return 0
`;

/** ZSET of slots scored by expiry. Prunes, reads before, adds. Returns before. */
const GAUGE_ACQUIRE = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  local before = redis.call('ZCARD', KEYS[1])
  redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), ARGV[3])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return before
`;

const GAUGE_READ = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  return redis.call('ZCARD', KEYS[1])
`;

/**
 * HASH of buckets: `<start>:r|t|c` fields plus a `seeded` marker. An unseeded
 * key ignores adds, for the reason the memory implementation gives.
 */
const BUCKETS_ADD = `
  if redis.call('HEXISTS', KEYS[1], 'seeded') == 0 then return 0 end
  local start = math.floor(tonumber(ARGV[1]) / tonumber(ARGV[2])) * tonumber(ARGV[2])
  redis.call('HINCRBY', KEYS[1], start .. ':r', ARGV[4])
  redis.call('HINCRBY', KEYS[1], start .. ':t', ARGV[5])
  redis.call('HINCRBYFLOAT', KEYS[1], start .. ':c', ARGV[6])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
  return 1
`;

/** Prunes aged buckets, sums the rest. Returns nil when unseeded. */
const BUCKETS_SUM = `
  if redis.call('HEXISTS', KEYS[1], 'seeded') == 0 then return nil end
  local oldest = math.floor((tonumber(ARGV[1]) - tonumber(ARGV[3])) / tonumber(ARGV[2])) * tonumber(ARGV[2])
  local all = redis.call('HGETALL', KEYS[1])
  local r, t, c = 0, 0, 0
  for i = 1, #all, 2 do
    local field = all[i]
    local sep = string.find(field, ':')
    if sep then
      local start = tonumber(string.sub(field, 1, sep - 1))
      local kind = string.sub(field, sep + 1)
      if start < oldest then
        redis.call('HDEL', KEYS[1], field)
      elseif kind == 'r' then r = r + tonumber(all[i + 1])
      elseif kind == 't' then t = t + tonumber(all[i + 1])
      elseif kind == 'c' then c = c + tonumber(all[i + 1])
      end
    end
  end
  return { tostring(r), tostring(t), tostring(c) }
`;

/** Release only what this holder took. */
const MUTEX_RELEASE = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
  return 0
`;

/** Renew only what this holder holds. Returns 1 when held afterwards. */
const LEASE_ACQUIRE = `
  local holder = redis.call('GET', KEYS[1])
  if holder == false or holder == ARGV[1] then
    redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
    return 1
  end
  return 0
`;

const LEASE_RELEASE = MUTEX_RELEASE;

type Envelope = { topic: string; payload: string };

/**
 * The fleet's coordinator, and what it does when Redis is not there.
 *
 * Every call is tried against Redis and, on a transport fault, answered the
 * way the table in the design says: the proxy-path primitives — window,
 * gauge, buckets, pubsub, incr — fall through to an embedded in-memory
 * coordinator, so limits degrade to per-process until Redis returns and no
 * request is refused over it; a lease that cannot be confirmed is not held;
 * a lock that cannot be taken is `LOCK_UNAVAILABLE`; and `kv` refuses with
 * `OVERLOADED`, because a session verified against a fallback map is one a
 * password change on another process cannot end. Logged once per interval
 * through two closed `LogFields` keys, never with the fault's text.
 */
export function redisCoord(deps: RedisCoordDeps): RedisCoord {
  const logger = deps.logger ?? noopLogger;
  const now = deps.now ?? (() => Date.now());
  const faultInterval = deps.faultLogIntervalMs ?? FAULT_LOG_INTERVAL_MS;
  const fallback = memoryCoord({ now });
  // Offline queueing off: a command issued while Redis is away must fail now,
  // not sit in a queue and succeed after the request it belonged to has been
  // answered from memory. Reconnection stays on, so the next call tries again.
  const client = new RedisClient(deps.url, {
    connectionTimeout: 2_000,
    autoReconnect: true,
    enableOfflineQueue: false,
  });
  let healthy = true;
  let lastFault = Number.NEGATIVE_INFINITY;
  const key = (kind: string, name: string): string => `${NS}${kind}:${name}`;

  const fault = (error: unknown): void => {
    healthy = false;
    const at = now();
    if (at - lastFault < faultInterval) return;
    lastFault = at;
    logger.warn("coordinator unreachable; serving from memory", {
      coord: "redis",
      coordFallback: true,
      reason: describeError(error, "unknown"),
    });
  };

  // With the offline queue off the client does not connect on first use, so
  // the connection is opened here. With reconnection on, `connect()` never
  // rejects — it retries with backoff for as long as the server is away — so
  // it is awaited for at most the connection timeout and then every call
  // reads `connected` instead. A call that finds it down is a fault answered
  // at once, never a wait on a connect that may take the whole timeout.
  const ready = Promise.race([client.connect().catch(fault), Bun.sleep(CONNECT_WAIT_MS)]);

  /** Runs `redis`; on a transport fault records it and runs `instead`. */
  const attempt = async <T>(redis: () => Promise<T>, instead: () => Promise<T>): Promise<T> => {
    try {
      await ready;
      if (!client.connected) throw new Error("not connected");
      const out = await redis();
      healthy = true;
      return out;
    } catch (error) {
      fault(error);
      return instead();
    }
  };

  const evalScript = (script: string, keys: string[], args: Array<string | number>) =>
    client.send("EVAL", [script, String(keys.length), ...keys, ...args.map(String)]);

  // --- pubsub: one subscriber connection, dispatched locally ---------------
  const subscribers = new Set<{ pattern: string; fn: (topic: string, payload: string) => void }>();
  const dispatch = (topic: string, payload: string): void => {
    for (const sub of subscribers) {
      const hit = sub.pattern.endsWith("*")
        ? topic.startsWith(sub.pattern.slice(0, -1))
        : topic === sub.pattern;
      if (hit) sub.fn(topic, payload);
    }
  };
  // A second connection, because a subscribed connection can issue nothing
  // else. Opened explicitly: without `connect()` a subscribe never settles.
  const subscriber = new RedisClient(deps.url, { connectionTimeout: 2_000, autoReconnect: true });
  // Own publishes reach own subscribers through the fallback whenever the
  // shared channel does not carry them; a process is always its own audience.
  fallback.pubsub.subscribe("*", dispatch);
  let listening = false;
  let connecting = false;
  const listen = (): Promise<void> => {
    if (listening || connecting) return Promise.resolve();
    connecting = true;
    return subscriber
      .connect()
      .then(() =>
        subscriber.subscribe(CHANNEL, (message) => {
          const envelope = JSON.parse(message) as Envelope;
          dispatch(envelope.topic, envelope.payload);
        }),
      )
      .then(() => {
        listening = true;
      })
      .catch(fault)
      .finally(() => {
        connecting = false;
      });
  };
  subscriber.onclose = () => {
    listening = false;
  };
  const listened = Promise.race([listen(), Bun.sleep(CONNECT_WAIT_MS)]);
  const relisten = setInterval(() => void listen(), RELISTEN_INTERVAL_MS);
  relisten.unref?.();

  return {
    healthy: () => healthy,
    close() {
      clearInterval(relisten);
      subscriber.close();
      client.close();
    },

    window: {
      claim(name, windowMs, at) {
        const member = `${at}-${crypto.randomUUID()}`;
        return attempt(
          async () => {
            const [used, oldest] = (await evalScript(
              WINDOW_CLAIM,
              [key("w", name)],
              [at, windowMs, member],
            )) as [number, string | null | undefined];
            const resetAt = oldest == null ? at : Number(oldest) + windowMs;
            return { stamp: at, before: { used, resetAt } };
          },
          () => fallback.window.claim(name, windowMs, at),
        );
      },
      rollback(name, stamp) {
        return attempt(
          async () => {
            await evalScript(WINDOW_ROLLBACK, [key("w", name)], [stamp]);
          },
          () => fallback.window.rollback(name, stamp),
        );
      },
    },

    gauge: {
      acquire(name, ttlMs) {
        return attempt(
          async () =>
            (await evalScript(
              GAUGE_ACQUIRE,
              [key("g", name)],
              [now(), ttlMs, crypto.randomUUID()],
            )) as number,
          () => fallback.gauge.acquire(name, ttlMs),
        );
      },
      release(name) {
        return attempt(
          async () => {
            // The oldest slot goes. Which slot is not a distinction the count
            // carries, and the oldest is the one nearest its own expiry.
            await client.send("ZPOPMIN", [key("g", name)]);
          },
          () => fallback.gauge.release(name),
        );
      },
      read(name) {
        return attempt(
          async () => (await evalScript(GAUGE_READ, [key("g", name)], [now()])) as number,
          () => fallback.gauge.read(name),
        );
      },
      snapshot(prefix) {
        return attempt(
          async () => {
            const out = new Map<string, number>();
            const at = now();
            for (const full of await scan(client, `${key("g", prefix)}*`)) {
              const count = (await evalScript(GAUGE_READ, [full], [at])) as number;
              if (count > 0) out.set(full.slice(key("g", "").length), count);
            }
            return out;
          },
          () => fallback.gauge.snapshot(prefix),
        );
      },
    },

    buckets: {
      add(name, grainMs, windowMs, at, delta) {
        return attempt(
          async () => {
            await evalScript(
              BUCKETS_ADD,
              [key("b", name)],
              [at, grainMs, windowMs, delta.requests, delta.tokens, delta.costUsd],
            );
          },
          () => fallback.buckets.add(name, grainMs, windowMs, at, delta),
        );
      },
      sum(name, grainMs, windowMs, at) {
        return attempt(
          async () => {
            const out = (await evalScript(
              BUCKETS_SUM,
              [key("b", name)],
              [at, grainMs, windowMs],
            )) as [string, string, string] | null;
            if (out === null) return null;
            return { requests: Number(out[0]), tokens: Number(out[1]), costUsd: Number(out[2]) };
          },
          () => fallback.buckets.sum(name, grainMs, windowMs, at),
        );
      },
      seed(name, grainMs, windowMs, at, rows) {
        return attempt(
          async () => {
            const full = key("b", name);
            const fields: string[] = ["seeded", "1"];
            const oldest = Math.floor((at - windowMs) / grainMs) * grainMs;
            for (const [start, counts] of rows) {
              const bucket = Math.floor(start / grainMs) * grainMs;
              if (bucket < oldest) continue;
              fields.push(
                `${bucket}:r`,
                String(counts.requests),
                `${bucket}:t`,
                String(counts.tokens),
                `${bucket}:c`,
                String(counts.costUsd),
              );
            }
            // DEL then HSET rather than a transaction: a reader between the two
            // sees "unseeded" and seeds again, which installs the same picture.
            await client.del(full);
            await client.send("HSET", [full, ...fields]);
            await client.send("PEXPIRE", [full, String(windowMs * 2)]);
          },
          () => fallback.buckets.seed(name, grainMs, windowMs, at, rows),
        );
      },
    },

    lease: {
      acquire(name, holderId, ttlMs) {
        return attempt(
          async () =>
            ((await evalScript(
              LEASE_ACQUIRE,
              [key("lease", name)],
              [holderId, ttlMs],
            )) as number) === 1,
          async () => false,
        );
      },
      release(name, holderId) {
        return attempt(
          async () => {
            await evalScript(LEASE_RELEASE, [key("lease", name)], [holderId]);
          },
          async () => {},
        );
      },
    },

    mutex: {
      async withLock(name, ttlMs, waitMs, fn) {
        const full = key("lock", name);
        const token = crypto.randomUUID();
        // Wall-clock elapsed rather than the injected clock: the wait is real
        // time spent polling, and a test that froze `now` would poll forever.
        const deadline = performance.now() + waitMs;
        for (;;) {
          const taken = await attempt(
            async () => (await client.set(full, token, "PX", String(ttlMs), "NX")) === "OK",
            async () => {
              throw new LockUnavailable(name);
            },
          );
          if (taken) break;
          if (performance.now() >= deadline) throw new LockUnavailable(name);
          await Bun.sleep(LOCK_POLL_MS);
        }
        try {
          return await fn();
        } finally {
          await attempt(
            async () => {
              await evalScript(MUTEX_RELEASE, [full], [token]);
            },
            async () => {},
          );
        }
      },
    },

    kv: {
      set(name, value, ttlMs) {
        return attempt(
          async () => {
            await client.set(key("kv", name), value, "PX", ttlMs);
          },
          () => unavailable(),
        );
      },
      get(name) {
        return attempt(
          () => client.get(key("kv", name)),
          () => unavailable(),
        );
      },
      del(name) {
        return attempt(
          async () => {
            await client.send("UNLINK", [key("kv", name)]);
          },
          () => unavailable(),
        );
      },
      delPrefix(prefix) {
        return attempt(
          async () => {
            const found = await scan(client, `${key("kv", prefix)}*`);
            if (found.length > 0) await client.send("UNLINK", found);
          },
          () => unavailable(),
        );
      },
    },

    pubsub: {
      publish(topic, payload) {
        return attempt(
          async () => {
            await listened;
            if (!listening) throw new Error("not listening");
            await client.publish(CHANNEL, JSON.stringify({ topic, payload } satisfies Envelope));
          },
          () => fallback.pubsub.publish(topic, payload),
        );
      },
      subscribe(pattern, fn) {
        const sub = { pattern, fn };
        subscribers.add(sub);
        return () => {
          subscribers.delete(sub);
        };
      },
    },

    incr(name) {
      return attempt(
        () => client.incr(key("seq", name)),
        () => fallback.incr(name),
      );
    },
  };
}

function unavailable(): never {
  throw new GatewayError("OVERLOADED", "the coordinator is unreachable; try again shortly");
}

/** Every key matching `pattern`. `SCAN`, never `KEYS`, so a big keyspace never blocks the server. */
async function scan(client: RedisClient, pattern: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await client.scan(cursor, "MATCH", pattern);
    out.push(...keys);
    cursor = next;
  } while (cursor !== "0");
  return out;
}
