import { expect, test } from "bun:test";
import { memoryCoord } from "@omni/coord";
import { underLease } from "../src/lease.ts";

/**
 * Two processes sharing one coordinator: the first to ask holds the job and
 * the second skips its tick, until the lease lapses.
 */
test("one holder runs, the other skips, until the lease lapses", async () => {
  let clock = 0;
  const coord = memoryCoord({ now: () => clock });
  const ran: string[] = [];
  const tick = (node: string) =>
    underLease({ coord, nodeId: node }, "job", 1_000, async () => {
      ran.push(node);
    });

  expect(await tick("a")).toBe(true);
  expect(await tick("b")).toBe(false);
  expect(await tick("a")).toBe(true);
  clock = 1_001;
  expect(await tick("b")).toBe(true);
  expect(ran).toEqual(["a", "a", "b"]);
});

test("without a lease the tick always runs", async () => {
  let ran = 0;
  expect(
    await underLease(undefined, "job", 1_000, async () => {
      ran += 1;
    }),
  ).toBe(true);
  expect(ran).toBe(1);
});
