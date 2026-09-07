import { expect, test } from "bun:test";
import { DEFAULT_SETTINGS } from "@omni/store";
import { health } from "@omni/testkit";
import healthTrigger from "../../store/src/postgres/migrations/002_health_measurements.sql" with {
  type: "text",
};
import {
  blankHealth,
  PENALTY,
  recordFailure,
  recordSuccess,
  SUCCESS_RESETS,
  successWouldChange,
} from "../src/breaker.ts";

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
  });
});

test("success clears failures and closes the breaker", () => {
  const next = recordSuccess(
    health({ breakerState: "open", consecutiveFailures: 5, openedAt: NOW - 1000 }),
  );
  expect(next.breakerState).toBe("closed");
  expect(next.consecutiveFailures).toBe(0);
  expect(next.openedAt).toBeNull();
});

test("success clears a stale rate-limit window", () => {
  const next = recordSuccess(health({ rateLimitedUntil: NOW + 5000 }));
  expect(next.rateLimitedUntil).toBeNull();
});

test("a success against a closed, zero-count row, or no row, would change nothing", () => {
  expect(successWouldChange(undefined)).toBe(false);
  expect(successWouldChange(health())).toBe(false);
  // The sub-threshold count is the case a narrower predicate misses, and it
  // is the one that turns consecutive failures into cumulative ones.
  expect(successWouldChange(health({ consecutiveFailures: 1 }))).toBe(true);
  expect(successWouldChange(health({ breakerState: "open" }))).toBe(true);
  expect(successWouldChange(health({ breakerState: "halfOpen" }))).toBe(true);
  expect(successWouldChange(health({ rateLimitedUntil: NOW + 1 }))).toBe(true);
  expect(successWouldChange(health({ openedAt: NOW - 1 }))).toBe(true);
});

test("successWouldChange is exactly whether recordSuccess would change the row", () => {
  const cases = [
    health(),
    health({ consecutiveFailures: 2 }),
    health({ breakerState: "open", openedAt: NOW }),
    health({ rateLimitedUntil: NOW + 10 }),
  ];
  for (const h of cases) {
    const changed = JSON.stringify(recordSuccess(h)) !== JSON.stringify(h);
    expect(successWouldChange(h)).toBe(changed);
  }
});

// The predicate asks "would this write change anything"; the Postgres trigger
// asks "must every replica rebuild". The second is a strict subset: the failure
// count is patched into a held snapshot, so it belongs in the predicate and
// not in the trigger. Equality here would force `consecutive_failures` into
// the trigger and bring back a rebuild on every sub-threshold failure.
test("the success predicate is a strict superset of the trigger's WHEN columns", () => {
  const when = /WHEN \(([^)]*)\)/.exec(healthTrigger)?.[1] ?? "";
  const triggerColumns = new Set(
    [...when.matchAll(/OLD\.(\w+)\s+IS DISTINCT FROM NEW\.\1/g)].map((m) =>
      (m[1] as string).replace(/_(\w)/g, (_, c: string) => c.toUpperCase()),
    ),
  );
  expect(triggerColumns.size).toBeGreaterThan(0);
  const predicate = new Set<string>(SUCCESS_RESETS);
  for (const column of triggerColumns) expect(predicate).toContain(column);
  expect(predicate.size).toBeGreaterThan(triggerColumns.size);
  expect(predicate).toContain("consecutiveFailures");
  expect(triggerColumns).not.toContain("consecutiveFailures");
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
  const before = health({ consecutiveFailures: 1 });
  expect(recordFailure(before, { ...opts, code: "BAD_REQUEST" })).toEqual(before);
  expect(recordFailure(before, { ...opts, code: "CAPABILITY_MISMATCH" })).toEqual(before);
  expect(recordFailure(before, { ...opts, code: "CONTENT_FILTER" })).toEqual(before);
});

test("every error code has a penalty class", () => {
  for (const cls of Object.values(PENALTY)) {
    expect(["none", "soft", "hard"]).toContain(cls);
  }
});
