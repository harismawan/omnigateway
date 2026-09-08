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
      expect(logger.records).toContainEqual(
        expect.objectContaining({
          msg: "coordinator unreachable; serving from memory",
          fields: expect.objectContaining({ coord: "redis", coordFallback: true }),
        }),
      );

      await spinning;
      blocker.close();
      coord.close();
    });
  });
}
