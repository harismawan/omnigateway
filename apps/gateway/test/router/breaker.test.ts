import { expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "@omni/store";
import { blankHealth, PENALTY, recordFailure, recordSuccess } from "../../src/router/breaker.ts";
import { health } from "../helpers/fixtures.ts";

const NOW = 1_000_000;
const opts = { settings: DEFAULT_SETTINGS, now: NOW, jitter: 0 };

test("blank health starts closed with no failures", () => {
  const h = blankHealth("c1", "m");
  expect(h).toEqual({
    credentialId: "c1",
    model: "m",
    breakerState: "closed",
    consecutiveFailures: 0,
    openedAt: null,
    rateLimitedUntil: null,
    ewmaTtftMs: null,
    lastUsedAt: null,
  });
});

test("success clears failures and closes the breaker", () => {
  const next = recordSuccess(
    health({ breakerState: "open", consecutiveFailures: 5, openedAt: NOW - 1000 }),
    { ...opts, ttftMs: 400 },
  );
  expect(next.breakerState).toBe("closed");
  expect(next.consecutiveFailures).toBe(0);
  expect(next.openedAt).toBeNull();
  expect(next.lastUsedAt).toBe(NOW);
});

test("success clears a stale rate-limit window", () => {
  const next = recordSuccess(health({ rateLimitedUntil: NOW + 5000 }), { ...opts, ttftMs: 100 });
  expect(next.rateLimitedUntil).toBeNull();
});

test("first latency sample seeds the ewma directly", () => {
  expect(recordSuccess(health(), { ...opts, ttftMs: 500 }).ewmaTtftMs).toBe(500);
});

test("subsequent latency samples blend at alpha 0.3", () => {
  const next = recordSuccess(health({ ewmaTtftMs: 1000 }), { ...opts, ttftMs: 500 });
  expect(next.ewmaTtftMs).toBeCloseTo(850, 5);
});

test("a success with no measured ttft leaves the ewma untouched", () => {
  expect(recordSuccess(health({ ewmaTtftMs: 700 }), { ...opts, ttftMs: null }).ewmaTtftMs).toBe(
    700,
  );
});

test("hard failures accumulate without opening below the threshold", () => {
  const next = recordFailure(health(), { ...opts, code: "UPSTREAM" });
  expect(next.consecutiveFailures).toBe(1);
  expect(next.breakerState).toBe("closed");
});

test("the breaker opens once the threshold is reached", () => {
  const next = recordFailure(health({ consecutiveFailures: 2 }), { ...opts, code: "UPSTREAM" });
  expect(next.consecutiveFailures).toBe(3);
  expect(next.breakerState).toBe("open");
  expect(next.openedAt).toBe(NOW);
});

test("a failure on a half-open probe reopens immediately", () => {
  const next = recordFailure(health({ breakerState: "halfOpen", consecutiveFailures: 1 }), {
    ...opts,
    code: "NETWORK",
  });
  expect(next.breakerState).toBe("open");
  expect(next.openedAt).toBe(NOW);
});

test("an auth failure opens the breaker on the first occurrence", () => {
  const next = recordFailure(health(), { ...opts, code: "AUTH" });
  expect(next.breakerState).toBe("open");
  expect(next.consecutiveFailures).toBe(1);
});

test("a rate limit sets a window without touching the breaker", () => {
  const next = recordFailure(health(), { ...opts, code: "RATE_LIMIT", retryAfterMs: 30_000 });
  expect(next.rateLimitedUntil).toBe(NOW + 30_000);
  expect(next.breakerState).toBe("closed");
  expect(next.consecutiveFailures).toBe(0);
});

test("a rate limit with no retry-after falls back to the default window", () => {
  const next = recordFailure(health(), { ...opts, code: "RATE_LIMIT" });
  expect(next.rateLimitedUntil).toBe(NOW + 60_000);
});

test("jitter spreads the rate-limit window so credentials do not resume in lockstep", () => {
  const a = recordFailure(health(), {
    ...opts,
    code: "RATE_LIMIT",
    retryAfterMs: 10_000,
    jitter: 0,
  });
  const b = recordFailure(health(), {
    ...opts,
    code: "RATE_LIMIT",
    retryAfterMs: 10_000,
    jitter: 1,
  });
  expect(b.rateLimitedUntil as number).toBeGreaterThan(a.rateLimitedUntil as number);
  expect((b.rateLimitedUntil as number) - (a.rateLimitedUntil as number)).toBeLessThanOrEqual(
    2_000,
  );
});

test("quota exhaustion parks the credential for an hour", () => {
  const next = recordFailure(health(), { ...opts, code: "QUOTA_EXHAUSTED" });
  expect(next.rateLimitedUntil).toBe(NOW + 3_600_000);
});

test("request-level errors change nothing", () => {
  const before = health({ consecutiveFailures: 1, ewmaTtftMs: 300 });
  expect(recordFailure(before, { ...opts, code: "BAD_REQUEST" })).toEqual(before);
  expect(recordFailure(before, { ...opts, code: "CAPABILITY_MISMATCH" })).toEqual(before);
  expect(recordFailure(before, { ...opts, code: "CONTENT_FILTER" })).toEqual(before);
});

test("every error code has a penalty class", () => {
  for (const cls of Object.values(PENALTY)) {
    expect(["none", "soft", "hard"]).toContain(cls);
  }
});
