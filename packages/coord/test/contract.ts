import { expect, test } from "bun:test";
import type { Coord } from "../src/index.ts";

const T0 = 1_700_000_000_000;

/**
 * The one suite every `Coord` implementation runs.
 *
 * A second implementation that passes this and drifts from the first drifts in
 * a way no consumer can see, so the properties here are the ones consumers
 * lean on: a claim is visible to every concurrent claimant the instant it is
 * taken, a rollback gives back exactly one stamp, and a gauge never goes
 * negative.
 *
 * `make` receives a clock; an implementation that expires `kv` against its own
 * clock ignores it, and the expiry test then waits out a real TTL instead.
 */
export function coordContract(name: string, make: (now: () => number) => Promise<Coord>): void {
  test(`${name}: window claim reports what was held before it`, async () => {
    const coord = await make(() => T0);
    const a = await coord.window.claim("k", 60_000, T0);
    const b = await coord.window.claim("k", 60_000, T0 + 1);
    expect(a.before).toEqual({ used: 0, resetAt: T0 });
    expect(b.before).toEqual({ used: 1, resetAt: T0 + 60_000 });
  });

  test(`${name}: window ages a stamp out at exactly the window`, async () => {
    const coord = await make(() => T0);
    await coord.window.claim("k", 60_000, T0);
    expect((await coord.window.claim("k", 60_000, T0 + 60_000)).before.used).toBe(0);
  });

  test(`${name}: window rollback gives back exactly one stamp`, async () => {
    const coord = await make(() => T0);
    const first = await coord.window.claim("k", 60_000, T0);
    await coord.window.claim("k", 60_000, T0 + 1);
    await coord.window.rollback("k", first.stamp);
    expect((await coord.window.claim("k", 60_000, T0 + 2)).before.used).toBe(1);
    // A stamp already given back is silently nothing: exactly one goes.
    await coord.window.rollback("k", first.stamp);
    expect((await coord.window.claim("k", 60_000, T0 + 3)).before.used).toBe(2);
  });

  /**
   * The seam. Ten claims issued without awaiting between them must each see
   * the ones before it — a claim recorded only after a yield lets every
   * concurrent check judge the same pre-burst snapshot.
   */
  test(`${name}: concurrent window claims see each other`, async () => {
    const coord = await make(() => T0);
    const claims = await Promise.all(
      Array.from({ length: 10 }, () => coord.window.claim("k", 60_000, T0)),
    );
    const seen = claims.map((claim) => claim.before.used).sort((x, y) => x - y);
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test(`${name}: gauge counts acquisitions and never goes negative`, async () => {
    const coord = await make(() => T0);
    expect(await coord.gauge.acquire("g", 1_000)).toBe(0);
    expect(await coord.gauge.acquire("g", 1_000)).toBe(1);
    expect(await coord.gauge.read("g")).toBe(2);
    await coord.gauge.release("g");
    await coord.gauge.release("g");
    await coord.gauge.release("g");
    expect(await coord.gauge.read("g")).toBe(0);
    expect(await coord.gauge.read("never")).toBe(0);
  });

  test(`${name}: concurrent gauge acquisitions see each other`, async () => {
    const coord = await make(() => T0);
    const before = await Promise.all(
      Array.from({ length: 10 }, () => coord.gauge.acquire("g", 1_000)),
    );
    expect(before.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  test(`${name}: gauge snapshot lists every held key under a prefix`, async () => {
    const coord = await make(() => T0);
    await coord.gauge.acquire("load:a", 1_000);
    await coord.gauge.acquire("load:a", 1_000);
    await coord.gauge.acquire("load:b", 1_000);
    await coord.gauge.acquire("other:c", 1_000);
    await coord.gauge.release("load:b");
    expect(await coord.gauge.snapshot("load:")).toEqual(new Map([["load:a", 2]]));
  });

  test(`${name}: mutex serialises holders of one key`, async () => {
    const coord = await make(() => T0);
    const order: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = coord.mutex.withLock("m", 1_000, 1_000, async () => {
      order.push("first:in");
      await held;
      order.push("first:out");
    });
    const second = coord.mutex.withLock("m", 1_000, 1_000, async () => {
      order.push("second:in");
    });
    // Let the second contend, then let the first finish.
    await Promise.resolve();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:in", "first:out", "second:in"]);
  });

  test(`${name}: mutex gives up after waitMs`, async () => {
    const coord = await make(() => T0);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = coord.mutex.withLock("m", 10_000, 10_000, () => held);
    await expect(coord.mutex.withLock("m", 10_000, 20, async () => "x")).rejects.toThrow(
      "LOCK_UNAVAILABLE",
    );
    release();
    await first;
    expect(await coord.mutex.withLock("m", 10_000, 20, async () => "x")).toBe("x");
  });

  test(`${name}: mutex releases on throw`, async () => {
    const coord = await make(() => T0);
    await expect(
      coord.mutex.withLock("m", 1_000, 1_000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await coord.mutex.withLock("m", 1_000, 20, async () => 1)).toBe(1);
  });

  test(`${name}: kv holds a value for its ttl and not past it`, async () => {
    let clock = T0;
    const coord = await make(() => clock);
    await coord.kv.set("s", "v", 50);
    expect(await coord.kv.get("s")).toBe("v");
    clock += 49;
    await Bun.sleep(49);
    expect(await coord.kv.get("s")).toBe("v");
    clock += 1;
    await Bun.sleep(2);
    expect(await coord.kv.get("s")).toBeNull();
  });

  test(`${name}: kv del and delPrefix remove exactly what they name`, async () => {
    const coord = await make(() => T0);
    await coord.kv.set("sess:admin:1", "a", 10_000);
    await coord.kv.set("sess:admin:2", "b", 10_000);
    await coord.kv.set("sess:viewer:1", "c", 10_000);
    await coord.kv.set("other:1", "d", 10_000);
    await coord.kv.del("sess:admin:1");
    expect(await coord.kv.get("sess:admin:1")).toBeNull();
    await coord.kv.delPrefix("sess:admin:");
    expect(await coord.kv.get("sess:admin:2")).toBeNull();
    expect(await coord.kv.get("sess:viewer:1")).toBe("c");
    await coord.kv.delPrefix("sess:");
    expect(await coord.kv.get("sess:viewer:1")).toBeNull();
    expect(await coord.kv.get("other:1")).toBe("d");
  });
}
