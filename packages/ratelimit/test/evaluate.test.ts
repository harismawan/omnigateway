import { expect, test } from "bun:test";
import type { CounterSnapshot } from "../src/index.ts";
import { evaluate, retryAfterMs } from "../src/index.ts";

const NOW = 1_000_000;

test("no configured limit allows everything and reports no headroom", () => {
  const decision = evaluate({}, { requests: { "1m": { used: 9_999, resetAt: NOW } } }, NOW);
  expect(decision.allowed).toBe(true);
  expect(decision.violation).toBeNull();
  expect(decision.headroom).toEqual({});
});

test("an explicit null is unlimited, exactly as an absent key is", () => {
  const counters: CounterSnapshot = { requests: { "1m": { used: 500, resetAt: NOW + 1_000 } } };
  expect(evaluate({ requests: { "1m": null } }, counters, NOW).allowed).toBe(true);
  expect(evaluate({ requests: {} }, counters, NOW).allowed).toBe(true);
});

test("the request that lands exactly on the limit is allowed; the next is denied", () => {
  // `used` is what the window already holds, so `used === limit` is the request
  // that would take the key over. Parity with the limiter this replaces.
  const at = (used: number) =>
    evaluate(
      { requests: { "1m": 2 } },
      { requests: { "1m": { used, resetAt: NOW + 60_000 } } },
      NOW,
    );
  expect(at(0).allowed).toBe(true);
  expect(at(1).allowed).toBe(true);
  expect(at(2).allowed).toBe(false);
  expect(at(2).violation).toEqual({
    dimension: "requests",
    window: "1m",
    limit: 2,
    used: 2,
    resetAt: NOW + 60_000,
  });
});

test("every dimension is enforced in both directions", () => {
  const config = {
    requests: { "5h": 10 },
    tokens: { "1w": 1_000 },
    spend: { "1w": 25 },
    concurrency: 4,
  };
  const reset = NOW + 1_000;
  const under: CounterSnapshot = {
    requests: { "5h": { used: 9, resetAt: reset } },
    tokens: { "1w": { used: 999, resetAt: reset } },
    spend: { "1w": { used: 24.99, resetAt: reset } },
    concurrency: 3,
  };
  expect(evaluate(config, under, NOW).allowed).toBe(true);

  for (const over of [
    { ...under, requests: { "5h": { used: 10, resetAt: reset } } },
    { ...under, tokens: { "1w": { used: 1_000, resetAt: reset } } },
    { ...under, spend: { "1w": { used: 25, resetAt: reset } } },
    { ...under, concurrency: 4 },
  ] satisfies CounterSnapshot[]) {
    expect(evaluate(config, over, NOW).allowed).toBe(false);
  }
});

test("concurrency is a gauge, so its violation carries no window", () => {
  const decision = evaluate({ concurrency: 2 }, { concurrency: 2 }, NOW);
  expect(decision.violation).toEqual({
    dimension: "concurrency",
    window: null,
    limit: 2,
    used: 2,
    // A gauge clears when a request finishes and nobody knows when that is.
    resetAt: NOW,
  });
  expect(retryAfterMs(decision.violation, NOW)).toBe(0);
});

test("headroom reports the window nearest exhaustion by proportion, not the shortest", () => {
  // The key is comfortable per minute and one request from its weekly ceiling.
  // Reporting `1m` here would tell a client it had 59 requests in hand.
  const decision = evaluate(
    { requests: { "1m": 60, "1w": 2_000 } },
    {
      requests: {
        "1m": { used: 1, resetAt: NOW + 60_000 },
        "1w": { used: 1_999, resetAt: NOW + 604_800_000 },
      },
    },
    NOW,
  );
  expect(decision.allowed).toBe(true);
  expect(decision.headroom.requests).toEqual({
    window: "1w",
    limit: 2_000,
    used: 1_999,
    remaining: 1,
    resetAt: NOW + 604_800_000,
  });
});

test("headroom is per dimension and skips the ones with no configured window", () => {
  const decision = evaluate(
    { requests: { "1m": 10 }, concurrency: 4 },
    { requests: { "1m": { used: 4, resetAt: NOW + 500 } }, concurrency: 1 },
    NOW,
  );
  expect(Object.keys(decision.headroom)).toEqual(["requests"]);
  expect(decision.headroom.requests?.remaining).toBe(6);
});

test("remaining floors at zero, because a post-hoc debit overshoots by one request", () => {
  const decision = evaluate(
    { tokens: { "1w": 1_000 } },
    { tokens: { "1w": { used: 1_400, resetAt: NOW + 10 } } },
    NOW,
  );
  expect(decision.headroom.tokens?.remaining).toBe(0);
  expect(decision.headroom.tokens?.used).toBe(1_400);
});

test("a missing counter reads as zero used and a full window ahead", () => {
  // The gateway supplies what it has; a dimension it has not counted yet must
  // not deny, and its reset must still be a usable instant for a header.
  const decision = evaluate({ requests: { "5h": 10 } }, {}, NOW);
  expect(decision.allowed).toBe(true);
  expect(decision.headroom.requests).toEqual({
    window: "5h",
    limit: 10,
    used: 0,
    remaining: 10,
    resetAt: NOW + 18_000_000,
  });
});

test("of several violations the one clearing last is reported", () => {
  // Anything earlier hands the client a `Retry-After` that guarantees a second
  // 429 at the instant it was told to come back.
  const decision = evaluate(
    { requests: { "1m": 10, "1w": 100 } },
    {
      requests: {
        "1m": { used: 10, resetAt: NOW + 30_000 },
        "1w": { used: 100, resetAt: NOW + 600_000_000 },
      },
    },
    NOW,
  );
  expect(decision.violation?.window).toBe("1w");
  expect(retryAfterMs(decision.violation, NOW)).toBe(600_000_000);
});

/**
 * Two limits clearing at the same instant, decided by overshoot rather than by
 * where the walk happened to reach them.
 *
 * `resetAt` alone cannot separate these — they free together — so without the
 * tie-break the answer is whichever the loop saw first, and which one that is
 * follows from the order the dimensions and windows are enumerated in. Both
 * arrangements are asserted: the deeper overshoot is walked first in one and
 * second in the other, so neither "first wins" nor "last wins" passes.
 */
test("violations that clear together are separated by overshoot, not by walk order", () => {
  const together = NOW + 60_000;

  const walkedFirst = evaluate(
    { requests: { "5h": 10, "1w": 100 } },
    {
      requests: {
        "5h": { used: 50, resetAt: together },
        "1w": { used: 110, resetAt: together },
      },
    },
    NOW,
  );
  expect(walkedFirst.violation?.window).toBe("5h");

  const walkedSecond = evaluate(
    { requests: { "1m": 10 }, tokens: { "1m": 100 } },
    {
      requests: { "1m": { used: 11, resetAt: together } },
      tokens: { "1m": { used: 500, resetAt: together } },
    },
    NOW,
  );
  expect(walkedSecond.violation?.dimension).toBe("tokens");
});

test("retryAfterMs never goes negative on a reset already in the past", () => {
  expect(
    retryAfterMs({ dimension: "requests", window: "1m", limit: 1, used: 1, resetAt: 5 }, 10),
  ).toBe(0);
  expect(retryAfterMs(null, 10)).toBe(0);
});
