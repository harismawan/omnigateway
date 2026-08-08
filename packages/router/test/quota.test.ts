import { expect, test } from "bun:test";
import { credential, quota } from "@omni/testkit";
import { QUOTA_FLOOR, quotaHeadroom, UNKNOWN_QUOTA } from "../src/quota.ts";

const NOW = 1_000_000_000;
const POLL_MS = 300_000;
const HOUR = 3_600_000;

const read = (windows: Parameters<typeof quotaHeadroom>[1], cred = credential({ id: "a" })) =>
  quotaHeadroom(cred, windows, NOW, POLL_MS);

test("an oauth credential the provider reports nothing for scores as unknown", () => {
  // Not 1: ranking an account we know nothing about above one we know has room
  // is how an unreported account silently absorbs the whole pool.
  expect(read([])).toBe(UNKNOWN_QUOTA);
});

test("an api-key credential with no window is unconstrained, not unknown", () => {
  // Pay-as-you-go has no subscription window to run out of, so an absent
  // window is the normal state rather than a gap in what we know.
  expect(read([], credential({ id: "a", authType: "apiKey" }))).toBe(1);
});

test("a reading older than three poll intervals is not believed", () => {
  const stale = quota({ used: 10, limit: 100, observedAt: NOW - POLL_MS * 3 - 1 });
  expect(read([stale])).toBe(UNKNOWN_QUOTA);

  const fresh = quota({ used: 10, limit: 100, observedAt: NOW - POLL_MS });
  expect(read([fresh])).toBeGreaterThan(UNKNOWN_QUOTA);
});

test("a row that was never observed is not believed either", () => {
  expect(read([quota({ used: 10, limit: 100, observedAt: 0 })])).toBe(UNKNOWN_QUOTA);
});

test("an exhausted window past its own reset no longer counts against the account", () => {
  const rolled = quota({
    used: 100,
    limit: 100,
    observedAt: NOW - 60_000,
    resetsAt: NOW - 1,
  });
  expect(read([rolled])).toBe(UNKNOWN_QUOTA);
});

test("headroom is judged against how much of the window is left", () => {
  // 20% left with 10% of the five-hour window to run is comfortable...
  const ahead = quota({
    windowType: "fiveHour",
    used: 80,
    limit: 100,
    observedAt: NOW,
    resetsAt: NOW + 0.5 * HOUR,
  });
  expect(read([ahead])).toBe(1);

  // ...while the same 20% with the whole window still ahead is not.
  const behind = quota({
    windowType: "fiveHour",
    used: 80,
    limit: 100,
    observedAt: NOW,
    resetsAt: NOW + 5 * HOUR,
  });
  expect(read([behind])).toBeCloseTo(0.2, 5);
});

test("the same headroom is judged differently in a five-hour and a weekly window", () => {
  const observedAt = NOW;
  const fiveHour = quota({
    windowType: "fiveHour",
    used: 95,
    limit: 100,
    observedAt,
    resetsAt: NOW + 15 * 60_000,
  });
  const weekly = quota({
    windowType: "weekly",
    used: 95,
    limit: 100,
    observedAt,
    resetsAt: NOW + 6 * 24 * HOUR,
  });

  // Five percent that refills in a quarter of an hour is not the same fact as
  // five percent that has to last six days.
  expect(read([fiveHour])).toBeGreaterThan(read([weekly]));
  expect(read([weekly])).toBeLessThan(QUOTA_FLOOR);
});

test("a window with no reported reset falls back to plain headroom", () => {
  const window = quota({ used: 25, limit: 100, observedAt: NOW, resetsAt: null });
  expect(read([window])).toBeCloseTo(0.75, 5);
});

test("the tightest usable window decides", () => {
  const roomy = quota({ windowType: "fiveHour", used: 10, limit: 100, observedAt: NOW });
  const tight = quota({ windowType: "weekly", used: 90, limit: 100, observedAt: NOW });
  expect(read([roomy, tight])).toBeCloseTo(0.1, 5);
});

test("a window the provider reported without a limit cannot be measured", () => {
  expect(read([quota({ used: 5_000, limit: null, observedAt: NOW })])).toBe(UNKNOWN_QUOTA);
});
