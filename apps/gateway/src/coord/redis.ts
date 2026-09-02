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

/**
 * A local-only topic a subscriber may hold to learn the shared channel was
 * (re)established, so state that lives only in fan-out — stream declarations —
 * can be asked for again.
 */
const RECONNECTED = "coord:reconnected";

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

/**
 * ZSET of slots scored by expiry, plus a SET indexing every key under its
 * prefix so `snapshot` is one script and never a `SCAN` of the keyspace.
 * Prunes, reads before, adds. Returns before.
 */
const GAUGE_ACQUIRE = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  local before = redis.call('ZCARD', KEYS[1])
  redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), ARGV[3])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  redis.call('SADD', KEYS[2], KEYS[1])
  return before
`;

const GAUGE_READ = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  return redis.call('ZCARD', KEYS[1])
`;

/** Prunes first, so a lapsed slot is never the one given back for a live one. */
const GAUGE_RELEASE = `
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  redis.call('ZPOPMIN', KEYS[1])
  return 0
`;

/** Every indexed key's live count; drops empty keys from the index as it goes. */
const GAUGE_SNAPSHOT = `
  local out = {}
  for _, key in ipairs(redis.call('SMEMBERS', KEYS[1])) do
    redis.call('ZREMRANGEBYSCORE', key, '-inf', ARGV[1])
    local count = redis.call('ZCARD', key)
    if count > 0 then
      out[#out + 1] = key
      out[#out + 1] = count
    else
      redis.call('SREM', KEYS[1], key)
    end
  end
  return out
`;

/** Replace the picture in one step, so no add lands between the delete and the write. */
const BUCKETS_SEED = `
  redis.call('DEL', KEYS[1])
  redis.call('HSET', KEYS[1], unpack(ARGV, 2))
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  return 0
`;

/**
 * Number and publish in one step, so two processes cannot deliver out of
 * order. The envelope is built here so the number rides inside the payload
 * the way `splitSequenced` reads it.
 */
const PUBLISH_SEQUENCED = `
  local seq = redis.call('INCR', KEYS[1])
  redis.call('PUBLISH', ARGV[1], cjson.encode({ topic = ARGV[2], payload = seq .. ':' .. ARGV[3] }))
  return seq
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

const SCRIPTS = [
  WINDOW_CLAIM,
  WINDOW_ROLLBACK,
  GAUGE_ACQUIRE,
  GAUGE_READ,
  GAUGE_RELEASE,
  GAUGE_SNAPSHOT,
  BUCKETS_ADD,
  BUCKETS_SUM,
  BUCKETS_SEED,
  MUTEX_RELEASE,
  LEASE_ACQUIRE,
  PUBLISH_SEQUENCED,
] as const;

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
  // Unknown until the first connect settles, so `/health` does not report
  // `ok` for a coordinator nothing has reached yet.
  let healthy = false;
  let lastFault = Number.NEGATIVE_INFINITY;
  const key = (kind: string, name: string): string => `${NS}${kind}:${name}`;
  /**
   * The index set a gauge key is listed in: its prefix up to and including
   * the first colon, so `load:<id>` keys share one set and `snapshot("load:")`
   * reads it in one script. A key with no colon is its own set.
   */
  const indexOf = (name: string): string => {
    const colon = name.indexOf(":");
    return `${NS}gidx:${colon === -1 ? name : name.slice(0, colon + 1)}`;
  };

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

  // Every script is loaded at connect and called by digest afterwards, so a
  // call never waits on a load — which matters for ordering: a release sent
  // without awaiting it must reach the server before the next acquire on
  // this connection, and an extra round trip in front of it would let the
  // acquire overtake. A server that lost its script cache (restart, FLUSH)
  // answers NOSCRIPT and the script is sent whole once more.
  const shas = new Map<string, string>();
  const loadScripts = async (): Promise<void> => {
    for (const script of SCRIPTS) {
      shas.set(script, (await client.send("SCRIPT", ["LOAD", script])) as string);
    }
  };
  const evalScript = async (
    script: string,
    keys: string[],
    args: Array<string | number>,
  ): Promise<unknown> => {
    const tail = [String(keys.length), ...keys, ...args.map(String)];
    const sha = shas.get(script);
    if (sha === undefined) return client.send("EVAL", [script, ...tail]);
    try {
      return await client.send("EVALSHA", [sha, ...tail]);
    } catch (error) {
      if (!String(error).includes("NOSCRIPT")) throw error;
      shas.delete(script);
      return client.send("EVAL", [script, ...tail]);
    }
  };

  // With the offline queue off the client does not connect on first use, so
  // the connection is opened here. With reconnection on, `connect()` never
  // rejects — it retries with backoff for as long as the server is away — so
  // it is awaited for at most the connection timeout and then every call
  // reads `connected` instead. A call that finds it down is a fault answered
  // at once, never a wait on a connect that may take the whole timeout.
  const ready = Promise.race([
    client
      .connect()
      .then(loadScripts)
      .then(
        () => {
          healthy = true;
        },
        (error: unknown) => fault(error),
      ),
    Bun.sleep(CONNECT_WAIT_MS),
  ]);

  /** Runs `redis`; on a transport fault records it and runs `instead`. */
  /**
   * Debits made while Redis was away went to the embedded memory coordinator
   * and were dropped there (an unseeded key ignores adds), so on recovery the
   * shared picture is short by every one of them — an under-count, which is
   * the direction the limiter forbids. Dropping every bucket hash makes the
   * next admission reseed from the store, which has the rows.
   */
  const reseedAfterOutage = async (): Promise<void> => {
    const keys = await scan(client, `${key("b", "")}*`);
    if (keys.length > 0) await client.send("UNLINK", keys);
  };

  const attempt = async <T>(redis: () => Promise<T>, instead: () => Promise<T>): Promise<T> => {
    try {
      await ready;
      if (!client.connected) throw new Error("not connected");
      const out = await redis();
      if (!healthy && lastFault !== Number.NEGATIVE_INFINITY) {
        healthy = true;
        void reseedAfterOutage().catch(fault);
      }
      healthy = true;
      return out;
    } catch (error) {
      fault(error);
      return instead();
    }
  };

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
  //
  // Re-subscribed from `onconnect`, which the client fires on the first
  // connect and on every reconnect after a drop — and `onclose` is what it
  // does *not* fire on a killed connection, measured. A subscribe issued
  // after a reconnect without the unsubscribe delivers every frame twice.
  const subscriber = new RedisClient(deps.url, { connectionTimeout: 2_000, autoReconnect: true });
  // Own publishes reach own subscribers through the fallback whenever the
  // shared channel does not carry them; a process is always its own audience.
  fallback.pubsub.subscribe("*", dispatch);
  let listening = false;
  let firstListen: () => void = () => {};
  const listened = Promise.race([
    new Promise<void>((resolve) => {
      firstListen = resolve;
    }),
    Bun.sleep(CONNECT_WAIT_MS),
  ]);
  const onFrame = (message: string): void => {
    const envelope = JSON.parse(message) as Envelope;
    dispatch(envelope.topic, envelope.payload);
  };
  subscriber.onconnect = () => {
    void (async () => {
      try {
        await subscriber.unsubscribe(CHANNEL);
      } catch {
        // Nothing was subscribed on a fresh connection; that is fine.
      }
      await subscriber.subscribe(CHANNEL, onFrame);
      listening = true;
      firstListen();
      // Declarations made while this process was deaf are re-asked for by
      // whoever it tells; the broadcaster answers a hello with its own.
      dispatch(RECONNECTED, "");
    })().catch(fault);
  };
  subscriber.onclose = () => {
    listening = false;
  };
  subscriber.connect().catch(fault);

  return {
    healthy: () => healthy,
    close() {
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
              [key("g", name), indexOf(name)],
              [now(), ttlMs, crypto.randomUUID()],
            )) as number,
          () => fallback.gauge.acquire(name, ttlMs),
        );
      },
      release(name) {
        return attempt(
          async () => {
            // The oldest live slot goes. Which slot is not a distinction the
            // count carries, and the oldest is the one nearest its own expiry.
            await evalScript(GAUGE_RELEASE, [key("g", name)], [now()]);
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
            const flat = (await evalScript(GAUGE_SNAPSHOT, [indexOf(prefix)], [now()])) as Array<
              string | number
            >;
            const out = new Map<string, number>();
            for (let i = 0; i + 1 < flat.length; i += 2) {
              out.set(String(flat[i]).slice(key("g", "").length), Number(flat[i + 1]));
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
            await evalScript(BUCKETS_SEED, [full], [windowMs * 2, ...fields]);
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
      publishSequenced(topic, payload, seqKey) {
        return attempt(
          async () => {
            await listened;
            if (!listening) throw new Error("not listening");
            return (await evalScript(
              PUBLISH_SEQUENCED,
              [key("seq", seqKey)],
              [CHANNEL, topic, payload],
            )) as number;
          },
          () => fallback.pubsub.publishSequenced(topic, payload, seqKey),
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
