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

test("a window shorter than its bucket is judged by the length the provider stated", () => {
  // The three window names are buckets. Codex states a real duration, and a
  // three-hour window measured as five understates how much of it is gone: the
  // remaining fraction comes out `1.5/5` instead of `1.5/3`, headroom is divided
  // by a smaller number, and the account reads healthier than it is.
  const shared = { windowType: "fiveHour" as const, used: 80, limit: 100, observedAt: NOW };
  const resetsAt = NOW + 1.5 * HOUR;

  const nominal = quota({ ...shared, resetsAt, windowMs: null });
  const stated = quota({ ...shared, resetsAt, windowMs: 3 * HOUR });

  // 0.2 headroom over 1.5h of a real 3h window: half the window left, so half.
  expect(read([stated])).toBeCloseTo(0.4, 5);
  // The same reading measured by its five-hour bucket: 1.5/5 left, so 0.667.
  expect(read([nominal])).toBeCloseTo(2 / 3, 5);
  // The direction is the point. Believing the provider is the conservative move.
  expect(read([stated])).toBeLessThan(read([nominal]));
});

test("a window longer than its bucket is judged by that length too", () => {
  // The correction runs both ways: a window bucketed as five-hour that actually
  // runs ten has more of itself left than the bucket implies, and pretending
  // otherwise would hold back an account that has room.
  const shared = { windowType: "fiveHour" as const, used: 90, limit: 100, observedAt: NOW };
  const resetsAt = NOW + 1.5 * HOUR;

  const nominal = quota({ ...shared, resetsAt, windowMs: null });
  const stated = quota({ ...shared, resetsAt, windowMs: 10 * HOUR });

  expect(read([stated])).toBeCloseTo(2 / 3, 5); // 0.1 / (1.5/10)
  expect(read([nominal])).toBeCloseTo(1 / 3, 5); // 0.1 / (1.5/5)
  expect(read([stated])).toBeGreaterThan(read([nominal]));
});

test("a window whose provider stated no duration scores off the nominal bucket", () => {
  // Anthropic and Kimi report no duration, so every window they write keeps the
  // score it had before the reported length existed.
  const window = quota({
    windowType: "weekly",
    used: 50,
    limit: 100,
    observedAt: NOW,
    resetsAt: NOW + 3.5 * 24 * HOUR,
    windowMs: null,
  });
  // Half the week gone, half the quota gone: exactly on pace.
  expect(read([window])).toBeCloseTo(1, 5);
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

test("the router imports no runtime value from the store package root", async () => {
  // `@omni/store` resolves to `src/index.ts`, which re-exports `openDb`,
  // `createStore`, and `encryption.ts` — importing a *value* from it puts
  // `bun:sqlite` and `node:crypto` in the router's module graph and evaluates
  // both at import time. `@omni/store/types` is the leaf, and is where
  // `durationFor` and `cacheReadRate` are read from. A type-only import
  // of the root is erased and so is left alone.
  const sources = new Bun.Glob("**/*.ts").scan({
    cwd: new URL("../src", import.meta.url).pathname,
    absolute: true,
  });

  const offenders: string[] = [];
  for await (const path of sources) {
    const text = await Bun.file(path).text();
    for (const match of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"@omni\/store";/gm)) {
      if (match[1] === undefined) offenders.push(`${path}: ${match[0].replace(/\s+/g, " ")}`);
    }
  }

  expect(offenders).toEqual([]);
});
