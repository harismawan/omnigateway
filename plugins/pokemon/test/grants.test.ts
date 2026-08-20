import { expect, test } from "bun:test";
import { WINDOW_MS } from "@omnigateway/plugin-api/events";
import { decideGrant, grantSize, windowKey } from "../src/grants.ts";

const NOW = 1_700_000_000_000;

test("a window's key is its dimension and its length", () => {
  // The bug this prevents has shipped twice, in two codebases: a reset instant
  // is recomputed on every evaluation, so keying on it re-fires the grant on
  // every refresh while the key sits at its ceiling.
  expect(windowKey({ dimension: "tokens", window: "1w" })).toBe("tokens:1w");
});

test("different windows on the same dimension are different keys", () => {
  // Otherwise filling a minute limit would mark the weekly one as paid.
  expect(windowKey({ dimension: "tokens", window: "1m" })).not.toBe(
    windowKey({ dimension: "tokens", window: "1w" }),
  );
});

test("a week is worth more than an afternoon, and a minute is worth nothing", () => {
  // A one-minute ceiling rated by its own duration would pay a candy a minute —
  // 100M XP each, ~144B a day, against a 750M–6B graduation. The economy's
  // premise is that growth costs real work, and a minute is not a span in which
  // work happened.
  expect(grantSize("1w")).toBe(5);
  expect(grantSize("5h")).toBe(1);
  expect(grantSize("1m")).toBe(0);
});

test("a minute window never pays, however long it has been", () => {
  expect(decideGrant({ window: "1m", lastGrantedAt: NOW - WINDOW_MS["1w"], now: NOW }).grant).toBe(
    false,
  );
  expect(decideGrant({ window: "1m", lastGrantedAt: null, now: NOW })).toEqual({ grant: false });
});

test("a window that has never been seen seeds itself and pays nothing", () => {
  // Per WINDOW, not per key. This test previously asserted the opposite — that a
  // seeded *key* pays on another window's first event — and so pinned the bug:
  // with four dimensions and three lengths, an install against a key already at
  // its ceilings paid out up to eleven free candies at the install instant, for
  // work nobody watched happen.
  for (const window of ["1w", "5h"] as const) {
    const decision = decideGrant({ window, lastGrantedAt: null, now: NOW });
    expect(decision.grant).toBe(false);
    if (decision.grant) return;
    expect(decision.seedAt).toBe(NOW);
  }
});

test("a key at every ceiling at once is paid for none of them", () => {
  // The install-instant windfall, stated as the scenario rather than the rule.
  // Every window is unseen, so every window seeds and none pays.
  const windows = ["1w", "5h"] as const;
  const total = windows
    .map((window) => decideGrant({ window, lastGrantedAt: null, now: NOW }))
    .reduce((sum, d) => sum + (d.grant ? d.count : 0), 0);
  expect(total).toBe(0);
});

test("a seeded window pays once its own duration has passed", () => {
  for (const window of ["1w", "5h"] as const) {
    expect(
      decideGrant({ window, lastGrantedAt: NOW, now: NOW + WINDOW_MS[window] - 1 }).grant,
    ).toBe(false);
    expect(decideGrant({ window, lastGrantedAt: NOW, now: NOW + WINDOW_MS[window] })).toEqual({
      grant: true,
      count: grantSize(window),
      at: NOW + WINDOW_MS[window],
    });
  }
});

test("a key parked at its ceiling is not a faucet", () => {
  // `LimitReached` fires continuously while a key is at its limit; paying each
  // time turns a rate limit into an income.
  expect(decideGrant({ window: "1w", lastGrantedAt: NOW, now: NOW + 1_000 })).toEqual({
    grant: false,
  });
});

test("each window re-arms on its own schedule, not a shared one", () => {
  const at = NOW + WINDOW_MS["5h"];
  expect(decideGrant({ window: "5h", lastGrantedAt: NOW, now: at }).grant).toBe(true);
  expect(decideGrant({ window: "1w", lastGrantedAt: NOW, now: at }).grant).toBe(false);
});
