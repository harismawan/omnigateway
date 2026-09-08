import { describe, expect, test } from "bun:test";
import { captureLogger } from "@omni/testkit";
import { RedisClient } from "bun";
import { coordContract } from "../../../../packages/coord/test/contract.ts";
import { redisCoord } from "../../src/coord/redis.ts";

/**
 * The same contract the in-memory coordinator passes, run against a real
 * Redis when one is named. Skipped otherwise — CI names one; a developer
 * without one loses this file and nothing else.
 *
 * Each contract test runs on its own logical database, flushed first, so an
 * earlier test's keys cannot answer for a later one.
 */
const url = process.env.OMNI_TEST_REDIS_URL;

if (url === undefined) {
  test.skip("redis coord contract (set OMNI_TEST_REDIS_URL to run)", () => {});
} else {
  const base = url.replace(/\/\d+$/, "");
  let n = 0;
  coordContract("redis", async (now) => {
    const db = (n++ % 15) + 1;
    const admin = new RedisClient(`${base}/${db}`);
    await admin.send("FLUSHDB", []);
    admin.close();
    return redisCoord({ url: `${base}/${db}`, now });
  });

  describe("redis coord: fail-open", () => {
    test("an unreachable coordinator serves limits from memory and refuses sessions", async () => {
      const logger = captureLogger();
      const coord = redisCoord({ url: "redis://127.0.0.1:1", logger, faultLogIntervalMs: 0 });
      expect((await coord.window.claim("k", 60_000, 1)).before.used).toBe(0);
      expect((await coord.window.claim("k", 60_000, 2)).before.used).toBe(1);
      expect(await coord.gauge.acquire("g", 1000)).toBe(0);
      expect(await coord.lease.acquire("job", "me", 1000)).toBe(false);
      await expect(coord.mutex.withLock("m", 100, 10, async () => 1)).rejects.toThrow(
        "LOCK_UNAVAILABLE",
      );
      await expect(coord.kv.get("s")).rejects.toThrow("coordinator is unreachable");
      expect(coord.healthy()).toBe(false);
      expect(logger.records).toContainEqual(
        expect.objectContaining({
          msg: "coordinator unreachable; serving from memory",
          fields: expect.objectContaining({ coord: "redis", coordFallback: true }),
        }),
      );
      coord.close();
    });

    /**
     * A reachable coordinator that answers too slowly is the same fault as one
     * that is not there. `connected` stays true throughout, so this is the case
     * the connect timeout and the `connected` guard both miss: without a
     * deadline on the command the claim never settles, and because it sits
     * ahead of every other yield in a request, the request hangs having done
     * nothing.
     *
     * The stall is a Lua script rather than `DEBUG SLEEP`, which Redis 7 gates
     * behind `enable-debug-command`. Redis runs scripts on the one thread that
     * serves commands, so a script that spins for a second is a server that
     * accepted the socket and stopped answering — the real shape, not a mock.
     *
     * The warm claims are what make the assertion unambiguous: Redis holds two
     * for this key and the embedded memory coordinator holds none, so `used`
     * says which one answered. A shorter budget alone would not — a loopback
     * reply beats a zero-millisecond timer.
     */
    test("a command that outruns its deadline falls back like an outage", async () => {
      const logger = captureLogger();
      // This test reads the counts back, so it owns the database it reads:
      // the contract harness cycles 1..15 and leaves whatever named this one.
      const blocker = new RedisClient(url);
      await blocker.send("FLUSHDB", []);

      const coord = redisCoord({ url, logger, faultLogIntervalMs: 0, commandTimeoutMs: 50 });
      await coord.window.claim("stalled", 60_000, 1);
      expect((await coord.window.claim("stalled", 60_000, 2)).before.used).toBe(1);
      expect(coord.healthy()).toBe(true);

      // Counted rather than clock-driven: Redis freezes a script's view of
      // TIME so replicas replay it identically, so a loop waiting on the clock
      // never ends and has to be SCRIPT KILLed. Measured near 600ms, an order
      // above the budget, and bounded on any machine.
      const spinning = blocker.send("EVAL", ["for i=1,200000000 do end return 1", "0"]);
      await Bun.sleep(50);
      // Redis would say two; memory has never seen this key.
      expect((await coord.window.claim("stalled", 60_000, 3)).before.used).toBe(0);
      expect(coord.healthy()).toBe(false);
      expect(coord.faults()).toBe(1);
      // Named as slowness, not absence: `healthy` reads true again on the next
      // call, so the line and the count are what say Redis was late.
      expect(logger.records).toContainEqual(
        expect.objectContaining({
          msg: "coordinator slow; serving from memory",
          fields: expect.objectContaining({
            coord: "redis",
            coordFallback: true,
            reason: "command timed out",
          }),
        }),
      );

      await spinning;
      await coord.window.claim("stalled", 60_000, 4);
      expect(coord.healthy()).toBe(true);
      expect(coord.faults()).toBe(1);
      blocker.close();
      coord.close();
    });

    /**
     * The deadline does not cancel the command. For window, gauge and buckets
     * a late-landing claim over-counts, which the limiter permits; for the
     * mutex a late-landing `SET NX` is a lock taken under a token nobody
     * holds, and `fn` never runs, so nothing releases it until the TTL
     * lapses. Measured on the seed lock: a contender waited the whole
     * `SEED_LOCK_MS` on the request path, five times the hang the deadline
     * exists to bound.
     */
    test("a lock claim that outruns its deadline is released, not stranded", async () => {
      const blocker = new RedisClient(url);
      await blocker.send("FLUSHDB", []);
      const slow = redisCoord({ url, faultLogIntervalMs: 0, commandTimeoutMs: 50 });
      await slow.incr("warm");

      const spinning = blocker.send("EVAL", ["for i=1,200000000 do end return 1", "0"]);
      await Bun.sleep(50);
      await expect(slow.mutex.withLock("seed", 5_000, 0, async () => 1)).rejects.toThrow(
        "LOCK_UNAVAILABLE",
      );
      await spinning;

      // A healthy contender, with a wait far below the lock's TTL: with the
      // stranded token in place it polls the whole wait and gives up.
      const contender = redisCoord({ url });
      const started = performance.now();
      expect(await contender.mutex.withLock("seed", 5_000, 500, async () => 1)).toBe(1);
      expect(performance.now() - started).toBeLessThan(400);

      blocker.close();
      slow.close();
      contender.close();
    });

    /**
     * Recovery reseeds the fleet's long-window counters by dropping every
     * bucket hash, which is shared by every replica. That repair is owed only
     * when a debit went to memory and was lost there; a claim answered from
     * memory but never debited leaves the shared picture whole. One slow
     * command on one replica must not cost every replica a reseed, because
     * slowness comes with load, which is when the store can least absorb one.
     */
    test("a timed-out claim without a lost debit does not drop the fleet's buckets", async () => {
      const blocker = new RedisClient(url);
      await blocker.send("FLUSHDB", []);
      const a = redisCoord({ url, faultLogIntervalMs: 0, commandTimeoutMs: 50 });
      const b = redisCoord({ url });
      const delta = { requests: 1, tokens: 1, costUsd: 0 };
      await a.buckets.seed("k", 1_000, 60_000, 10_000, [[9_000, delta]]);
      expect((await b.buckets.sum("k", 1_000, 60_000, 10_000))?.requests).toBe(1);

      let spinning = blocker.send("EVAL", ["for i=1,200000000 do end return 1", "0"]);
      await Bun.sleep(50);
      await a.window.claim("w", 60_000, 1);
      expect(a.healthy()).toBe(false);
      await spinning;
      await a.window.claim("w", 60_000, 2);
      expect(a.healthy()).toBe(true);
      await Bun.sleep(50);
      expect((await b.buckets.sum("k", 1_000, 60_000, 10_000))?.requests).toBe(1);

      // A debit that did go to memory is lost there, so this time the reseed
      // is owed: the shared hash goes and the next admission reads the store.
      spinning = blocker.send("EVAL", ["for i=1,200000000 do end return 1", "0"]);
      await Bun.sleep(50);
      await a.buckets.add("k", 1_000, 60_000, 10_000, delta);
      expect(a.healthy()).toBe(false);
      await spinning;
      await a.window.claim("w", 60_000, 3);
      await Bun.sleep(50);
      expect(await b.buckets.sum("k", 1_000, 60_000, 10_000)).toBeNull();

      blocker.close();
      a.close();
      b.close();
    });
  });
}
