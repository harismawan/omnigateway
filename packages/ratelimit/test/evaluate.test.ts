import { expect, test } from "bun:test";
import type { CounterSnapshot } from "../src/index.ts";
import { combine, evaluate, retryAfterMs } from "../src/index.ts";

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

/**
 * `combine` joins the key-wide decision and a model override's.
 *
 * Built from `evaluate` rather than written by hand, so the shapes the tests
 * feed it are the shapes the limiter feeds it.
 */
const keyWide = (used: number, resetAt: number) =>
  evaluate({ requests: { "1m": 10 } }, { requests: { "1m": { used, resetAt } } }, NOW);
const modelScope = (used: number, resetAt: number) =>
  evaluate({ requests: { "5h": 4 } }, { requests: { "5h": { used, resetAt } } }, NOW);

test("combine allows only what both scopes allow", () => {
  expect(combine(keyWide(1, NOW + 1), modelScope(1, NOW + 2)).allowed).toBe(true);

  const keyOnly = combine(keyWide(10, NOW + 30_000), modelScope(1, NOW + 2));
  expect(keyOnly.allowed).toBe(false);
  expect(keyOnly.violation).toEqual({
    dimension: "requests",
    window: "1m",
    limit: 10,
    used: 10,
    resetAt: NOW + 30_000,
  });

  const modelOnly = combine(keyWide(1, NOW + 1), modelScope(4, NOW + 90_000));
  expect(modelOnly.allowed).toBe(false);
  expect(modelOnly.violation?.window).toBe("5h");
  expect(modelOnly.violation?.resetAt).toBe(NOW + 90_000);
});

test("combine reports the violation clearing last, whichever scope holds it", () => {
  // Asserted in both arrangements, so neither "key wins" nor "model wins" passes.
  const modelLater = combine(keyWide(10, NOW + 30_000), modelScope(4, NOW + 90_000));
  expect(modelLater.violation?.window).toBe("5h");
  const keyLater = combine(keyWide(10, NOW + 95_000), modelScope(4, NOW + 90_000));
  expect(keyLater.violation?.window).toBe("1m");
  expect(retryAfterMs(keyLater.violation, NOW)).toBe(95_000);
});

test("combine reports, per dimension, the headroom nearer exhaustion", () => {
  // Key-wide 6/10 against the model's 1/4: the key is nearer.
  const keyNearer = combine(keyWide(6, NOW + 1), modelScope(1, NOW + 2));
  expect(keyNearer.headroom.requests).toEqual({
    window: "1m",
    limit: 10,
    used: 6,
    remaining: 4,
    resetAt: NOW + 1,
  });
  // Key-wide 6/10 against the model's 3/4: the model is.
  const modelNearer = combine(keyWide(6, NOW + 1), modelScope(3, NOW + 2));
  expect(modelNearer.headroom.requests).toEqual({
    window: "5h",
    limit: 4,
    used: 3,
    remaining: 1,
    resetAt: NOW + 2,
  });
});

test("combine keeps a dimension only one scope configures", () => {
  const key = evaluate(
    { tokens: { "1m": 100 } },
    { tokens: { "1m": { used: 5, resetAt: 7 } } },
    NOW,
  );
  const model = evaluate({ spend: { "1w": 4 } }, { spend: { "1w": { used: 1, resetAt: 9 } } }, NOW);
  const combined = combine(key, model);
  expect(combined.headroom.tokens?.limit).toBe(100);
  expect(combined.headroom.spend?.limit).toBe(4);
  expect(combined.headroom.requests).toBeUndefined();
  // Either side alone, in either position.
  expect(combine(model, key).headroom).toEqual(combined.headroom);
});

test("combine keeps the key-wide headroom when both scopes are equally near", () => {
  // 5/10 against 2/4: the same proportion. Either position must give the same
  // answer about which entry wins, so the rule is "strictly nearer replaces".
  const combined = combine(keyWide(5, NOW + 1), modelScope(2, NOW + 2));
  expect(combined.headroom.requests?.window).toBe("1m");
});
