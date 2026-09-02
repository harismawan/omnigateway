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
  });
}
