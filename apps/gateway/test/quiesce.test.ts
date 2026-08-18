import { expect, test } from "bun:test";
import { createQuiesceLatch } from "../src/quiesce.ts";

test("an open latch admits work and a closed one refuses it", () => {
  const latch = createQuiesceLatch();
  const release = latch.enter();
  expect(release).not.toBeNull();
  release?.();

  void latch.close(1_000);
  expect(latch.enter()).toBeNull();

  latch.open();
  expect(latch.enter()).not.toBeNull();
});

test("closing waits for the work already admitted", async () => {
  const latch = createQuiesceLatch();
  const first = latch.enter();
  const second = latch.enter();
  expect(first).not.toBeNull();

  let settled = false;
  const drain = latch.close(1_000).then((result) => {
    settled = true;
    return result;
  });

  await Bun.sleep(1);
  expect(settled).toBe(false);

  first?.();
  await Bun.sleep(1);
  expect(settled).toBe(false);

  second?.();
  expect(await drain).toEqual({ drained: true, inFlight: 0 });
});

test("closing gives up at the deadline rather than waiting for a request that never ends", async () => {
  const latch = createQuiesceLatch();
  const release = latch.enter();

  expect(await latch.close(5)).toEqual({ drained: false, inFlight: 1 });

  // Releasing after the deadline must not resolve a promise nobody holds, nor
  // leave the count wrong for the next quiesce.
  release?.();
  expect(await latch.close(5)).toEqual({ drained: true, inFlight: 0 });
});

test("a release runs once however many times it is called", async () => {
  const latch = createQuiesceLatch();
  const release = latch.enter();
  latch.enter();

  release?.();
  release?.();

  expect(await latch.close(5)).toEqual({ drained: false, inFlight: 1 });
});

test("an already idle latch closes without waiting", async () => {
  const latch = createQuiesceLatch();
  expect(await latch.close(60_000)).toEqual({ drained: true, inFlight: 0 });
});
