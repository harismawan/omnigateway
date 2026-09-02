import { expect, test } from "bun:test";
import { memoryCoord } from "../src/index.ts";
import { coordContract } from "./contract.ts";

coordContract("memory", async (now) => memoryCoord({ now }));

const T0 = 1_700_000_000_000;

/**
 * The idle-ring sweep is time-gated, and the gate must not turn into "never".
 *
 * A ring that drained is only reclaimable memory, so it is dropped at most once
 * per second rather than on every claim — but a gate that compares the wrong
 * way, or against the wrong instant, either walks every ring on every claim or
 * never walks again. `liveWindows` exists because the drop changes no other
 * answer this implementation gives.
 */
test("memory: drops a drained ring once per interval, and survives a clock step", () => {
  const coord = memoryCoord();
  coord.window.claim("a", 60_000, T0);
  coord.window.claim("b", 60_000, T0 + 500);
  expect(coord.liveWindows()).toBe(2);

  // `a` aged out, `b` has not; this claim sweeps.
  coord.window.claim("c", 60_000, T0 + 60_001);
  expect(coord.liveWindows()).toBe(2);

  // `b` droppable now, but inside the interval that just swept.
  coord.window.claim("c", 60_000, T0 + 60_501);
  expect(coord.liveWindows()).toBe(2);

  // Exactly the interval on, and `b` goes.
  coord.window.claim("c", 60_000, T0 + 61_001);
  expect(coord.liveWindows()).toBe(1);

  // Clock steps back an hour: the latch sits in the future, and must not hold
  // the sweep off for the length of the step.
  const back = T0 - 3_600_000;
  coord.window.claim("x", 60_000, back);
  coord.window.claim("y", 60_000, back + 60_001);
  expect(coord.liveWindows()).toBe(2);
});
