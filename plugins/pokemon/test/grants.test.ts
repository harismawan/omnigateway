import { expect, test } from "bun:test";
import { WINDOW_MS } from "@omni/ratelimit/catalog";
import { decideGrant, grantSize, windowKey } from "../src/grants.ts";

const NOW = 1_700_000_000_000;

test("a window's key is its dimension and window, and nothing volatile", () => {
  // The bug this prevents has shipped twice, in two codebases. A reset instant
  // is recomputed on every evaluation, so keying on it re-fires the grant on
  // every refresh while the key sits at its ceiling.
  expect(windowKey({ dimension: "tokens", window: "1w" })).toBe("tokens:1w");
  expect(windowKey({ dimension: "spend", window: "5h" })).toBe(
    windowKey({ dimension: "spend", window: "5h" }),
  );
});

test("different windows on the same dimension are different keys", () => {
  // Otherwise filling a minute limit would mark the weekly one as paid.
  expect(windowKey({ dimension: "tokens", window: "1m" })).not.toBe(
    windowKey({ dimension: "tokens", window: "1w" }),
  );
});

test("a week's ceiling is worth more than an afternoon's", () => {
  expect(grantSize("1w")).toBe(5);
  expect(grantSize("5h")).toBe(1);
  expect(grantSize("1m")).toBe(1);
});

test("the first sighting of a key seeds and pays nothing", () => {
  // Installing against a key already at its ceiling must not be a backdated
  // windfall.
  const decision = decideGrant({ window: "1w", lastGrantedAt: null, seeded: false, now: NOW });
  expect(decision.grant).toBe(false);
  if (decision.grant) return;
  expect(decision.seedAt).toBe(NOW);
});

test("a seeded key's next filled window pays", () => {
  expect(decideGrant({ window: "1w", lastGrantedAt: null, seeded: true, now: NOW })).toEqual({
    grant: true,
    count: 5,
    at: NOW,
  });
});

test("a key parked at its ceiling is not paid on every evaluation", () => {
  // `LimitReached` fires continuously while a key is at its limit. Paying each
  // time turns a rate limit into a faucet.
  const justPaid = decideGrant({
    window: "1w",
    lastGrantedAt: NOW,
    seeded: true,
    now: NOW + 1_000,
  });
  expect(justPaid).toEqual({ grant: false });
});

test("a window pays again once its own duration has passed", () => {
  // The correction that an integration test forced, and the reason this is a
  // rate limit rather than an edge trigger. There is no event for a window
  // emptying — `LimitReached` says nothing when a key drops below its ceiling —
  // so an "already paid" latch never re-arms and the window pays exactly once
  // for the life of the installation. A window cannot legitimately fill more
  // often than its own length, so that length is the rate.
  for (const window of ["1m", "5h", "1w"] as const) {
    const justBefore = decideGrant({
      window,
      lastGrantedAt: NOW,
      seeded: true,
      now: NOW + WINDOW_MS[window] - 1,
    });
    expect(justBefore).toEqual({ grant: false });

    const after = decideGrant({
      window,
      lastGrantedAt: NOW,
      seeded: true,
      now: NOW + WINDOW_MS[window],
    });
    expect(after).toEqual({ grant: true, count: grantSize(window), at: NOW + WINDOW_MS[window] });
  }
});

test("a short window re-arms sooner than a long one", () => {
  // Each window is rated by its own length rather than by one shared cooldown,
  // so a minute limit is not throttled to a weekly cadence.
  const at = NOW + WINDOW_MS["1m"];
  expect(decideGrant({ window: "1m", lastGrantedAt: NOW, seeded: true, now: at }).grant).toBe(true);
  expect(decideGrant({ window: "1w", lastGrantedAt: NOW, seeded: true, now: at }).grant).toBe(
    false,
  );
});

test("seeding takes precedence, so the very first event never pays", () => {
  // Both conditions true at once: an unseeded key whose window looks payable is
  // still the install moment, not an achievement.
  expect(decideGrant({ window: "1w", lastGrantedAt: null, seeded: false, now: NOW }).grant).toBe(
    false,
  );
});
