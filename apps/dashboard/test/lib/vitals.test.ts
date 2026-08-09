import { describe, expect, test } from "bun:test";
import {
  bucketLogs,
  credentialStatus,
  groupBy,
  isError,
  lampLabel,
  lampState,
  percentile,
  quotaUsage,
  summarize,
} from "../../src/lib/vitals.ts";
import { health, log, NOW, quota } from "../helpers/fixtures.ts";

describe("isError", () => {
  test("counts a 4xx or 5xx status and any recorded error code", () => {
    expect(isError(log())).toBe(false);
    expect(isError(log({ status: 502 }))).toBe(true);
    expect(isError(log({ status: 200, errorCode: "TIMEOUT" }))).toBe(true);
  });

  // A pending row carries `status: 0`, which is neither a success nor a
  // failure. Reading it as either would put a running request in the failure
  // count the moment it started.
  test("a request still in flight is not a failure", () => {
    expect(isError(log({ state: "pending", status: 0 }))).toBe(false);
  });
});

describe("lampState", () => {
  test("distinguishes in flight from finished, and names each for a reader", () => {
    const pending = log({ state: "pending", status: 0 });
    expect(lampState(pending)).toBe("live");
    expect(lampLabel(pending)).toBe("in flight");
    expect(lampState(log())).toBe("ok");
    expect(lampState(log({ status: 502 }))).toBe("down");
  });
});

describe("summarize", () => {
  test("derives rate, error share, and latency percentiles", () => {
    const logs = [
      log({ id: "a", ttftMs: 100 }),
      log({ id: "b", ttftMs: 200 }),
      log({ id: "c", ttftMs: 900, status: 500, errorCode: "UPSTREAM" }),
      log({ id: "d", ttftMs: 300 }),
    ];
    const vitals = summarize(logs, 600_000);

    expect(vitals.requests).toBe(4);
    expect(vitals.errors).toBe(1);
    expect(vitals.errorRate).toBeCloseTo(0.25, 5);
    expect(vitals.ratePerMin).toBeCloseTo(0.4, 5);
    expect(vitals.ttftP50).toBe(200);
    expect(vitals.ttftP95).toBe(900);
    expect(vitals.costUsd).toBeCloseTo(0.048, 5);
  });

  // Its tokens, cost and duration are placeholder zeros the gateway filed to
  // keep the columns NOT NULL. Counting the row would divide real work by a
  // request that has produced none of it.
  test("ignores a request that has not finished", () => {
    const vitals = summarize(
      [
        log({ id: "a", ttftMs: 100 }),
        log({ id: "b", state: "pending", status: 0, ttftMs: null, costUsd: 0, durationMs: 0 }),
      ],
      600_000,
    );

    expect(vitals.requests).toBe(1);
    expect(vitals.ttftP50).toBe(100);
    expect(vitals.costUsd).toBeCloseTo(0.012, 5);
  });

  test("reports zeroes rather than NaN for an idle window", () => {
    const vitals = summarize([], 600_000);
    expect(vitals.errorRate).toBe(0);
    expect(vitals.ratePerMin).toBe(0);
    expect(vitals.ttftP50).toBeNull();
  });
});

describe("bucketLogs", () => {
  test("always returns the requested number of buckets, oldest first", () => {
    const buckets = bucketLogs([], { now: NOW, spanMs: 600_000, count: 12 });
    expect(buckets).toHaveLength(12);
    expect(buckets[0]?.at).toBeLessThan(buckets[11]?.at ?? 0);
    expect(buckets.every((bucket) => bucket.total === 0)).toBe(true);
  });

  test("places each log in its slice and splits out failures", () => {
    const logs = [
      log({ id: "a", at: NOW - 30_000, ttftMs: 100 }),
      log({ id: "b", at: NOW - 25_000, ttftMs: 300 }),
      log({ id: "c", at: NOW - 570_000, status: 503, errorCode: "OVERLOADED" }),
    ];
    const buckets = bucketLogs(logs, { now: NOW, spanMs: 600_000, count: 10 });

    expect(buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(3);
    expect(buckets.reduce((sum, bucket) => sum + bucket.errors, 0)).toBe(1);
    expect(buckets.at(-1)?.total).toBe(2);
    // Nearest-rank median: with two samples the lower one is the p50.
    expect(buckets.at(-1)?.ttftMs).toBe(100);
  });

  test("ignores a request that has not finished", () => {
    const buckets = bucketLogs(
      [
        log({ id: "a", at: NOW - 30_000 }),
        log({ id: "b", at: NOW - 30_000, state: "pending", status: 0, ttftMs: null }),
      ],
      { now: NOW, spanMs: 600_000, count: 10 },
    );

    expect(buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(1);
  });

  test("ignores anything outside the window", () => {
    const buckets = bucketLogs([log({ at: NOW - 10_000_000 })], {
      now: NOW,
      spanMs: 600_000,
      count: 6,
    });
    expect(buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(0);
  });
});

describe("credentialStatus", () => {
  test("a disabled credential is idle, whatever its health says", () => {
    const status = credentialStatus([health({ breakerState: "open" })], NOW, false);
    expect(status.state).toBe("idle");
    expect(status.note).toBe("disabled");
  });

  test("an unused credential is idle", () => {
    expect(credentialStatus([], NOW, true).state).toBe("idle");
  });

  test("the worst row wins", () => {
    const status = credentialStatus(
      [health(), health({ model: "other", breakerState: "open", consecutiveFailures: 4 })],
      NOW,
      true,
    );
    expect(status.state).toBe("down");
    expect(status.note).toBe("breaker open");
    expect(status.consecutiveFailures).toBe(4);
  });

  test("an active rate limit warns but does not fault", () => {
    const status = credentialStatus([health({ rateLimitedUntil: NOW + 60_000 })], NOW, true);
    expect(status.state).toBe("warn");
    expect(status.note).toBe("rate limited");
  });

  test("an expired rate limit is not a warning", () => {
    const status = credentialStatus([health({ rateLimitedUntil: NOW - 1 })], NOW, true);
    expect(status.state).toBe("ok");
  });

  test("a half-open breaker reads as probing", () => {
    const status = credentialStatus([health({ breakerState: "halfOpen" })], NOW, true);
    expect(status.state).toBe("warn");
    expect(status.note).toBe("probing");
  });

  test("latency is the slowest model, not the first row", () => {
    const status = credentialStatus(
      [health({ ewmaTtftMs: 200 }), health({ model: "b", ewmaTtftMs: 900 })],
      NOW,
      true,
    );
    expect(status.ttftMs).toBe(900);
  });
});

describe("quotaUsage", () => {
  test("reports every window the provider gave a limit for", () => {
    const windows = quotaUsage([
      quota({ windowType: "weekly", used: 200, limit: 1_000 }),
      quota({ windowType: "fiveHour", used: 950, limit: 1_000 }),
    ]);

    expect(windows).toHaveLength(2);
    expect(windows[0]?.fraction).toBeCloseTo(0.95, 5);
    expect(windows[1]?.fraction).toBeCloseTo(0.2, 5);
  });

  test("orders windows shortest first, whatever order they arrived in", () => {
    const windows = quotaUsage([
      quota({ windowType: "weekly", used: 1, limit: 10 }),
      quota({ windowType: "fiveHour", used: 1, limit: 10 }),
      quota({ windowType: "daily", used: 1, limit: 10 }),
    ]);

    expect(windows.map((w) => w.window.windowType)).toEqual(["fiveHour", "daily", "weekly"]);
  });

  test("drops windows the provider reported without a limit", () => {
    // Usage without a ceiling is not the same claim as an unused window, so
    // there is nothing honest to draw.
    expect(quotaUsage([quota({ limit: null })])).toEqual([]);
  });

  test("never reports more than fully spent", () => {
    expect(quotaUsage([quota({ used: 5_000, limit: 1_000 })])[0]?.fraction).toBe(1);
  });
});

test("percentile handles single values and empty input", () => {
  expect(percentile([], 0.5)).toBeNull();
  expect(percentile([7], 0.95)).toBe(7);
  expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
});

test("groupBy collects rows under their key", () => {
  const grouped = groupBy(
    [health(), health({ credentialId: "cred-2" }), health()],
    (row) => row.credentialId,
  );
  expect(grouped.get("cred-1")).toHaveLength(2);
  expect(grouped.get("cred-2")).toHaveLength(1);
});
