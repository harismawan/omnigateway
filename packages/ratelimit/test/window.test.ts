import { expect, test } from "bun:test";
import { SlidingWindow } from "../src/window.ts";

const MINUTE = 60_000;

test("a window counts only what has not aged out", () => {
  const window = new SlidingWindow(MINUTE);
  window.record(1_000);
  window.record(2_000);
  expect(window.count(2_000)).toBe(2);
  // 61_000 is one whole minute after the first event, so it has aged out.
  expect(window.count(61_000)).toBe(1);
  expect(window.count(62_000)).toBe(0);
});

test("an event exactly one window old is out, and one tick younger is in", () => {
  // The boundary the whole design turns on, asserted at the tick.
  const window = new SlidingWindow(MINUTE);
  window.record(0);
  expect(window.count(59_999)).toBe(1);
  expect(window.count(60_000)).toBe(0);
});

/**
 * The regression this package exists to fix.
 *
 * `Math.floor(now / WINDOW_MS) * WINDOW_MS` reset the count on a clock edge, so
 * a key limited to 60 could send 60 at T+59s and 60 more at T+61s — twice the
 * ceiling, no rule broken. A sliding window still holds the first burst.
 */
test("a burst on either side of a minute boundary is one window, not two", () => {
  const window = new SlidingWindow(MINUTE);
  for (let i = 0; i < 60; i++) window.record(59_000);
  expect(window.count(61_000)).toBe(60);
  // The old fixed window read this instant as a fresh bucket holding zero.
  expect(window.count(61_000)).not.toBe(0);
  // Only once the first burst is a full minute behind does the window clear.
  expect(window.count(119_000)).toBe(0);
});

test("reset is when the oldest held event ages out, not the next clock edge", () => {
  const window = new SlidingWindow(MINUTE);
  window.record(59_000);
  window.record(59_500);
  window.count(59_600);
  expect(window.resetAt(59_600)).toBe(119_000);
});

test("an empty window resets now, so an idle key is told to retry immediately", () => {
  const window = new SlidingWindow(MINUTE);
  expect(window.resetAt(5_000)).toBe(5_000);
  window.record(1_000);
  window.count(70_000);
  expect(window.resetAt(70_000)).toBe(70_000);
});

test("a drained window reports empty so its caller can drop the whole entry", () => {
  const window = new SlidingWindow(MINUTE);
  expect(window.empty).toBe(true);
  window.record(1_000);
  expect(window.count(1_000)).toBe(1);
  expect(window.empty).toBe(false);
  expect(window.count(61_000)).toBe(0);
  expect(window.empty).toBe(true);
});
