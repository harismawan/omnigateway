import { describe, expect, test } from "bun:test";
import { SAME_WINDOW_TOLERANCE_MS } from "@omni/store/types";
import type { QuotaSample, QuotaWindow } from "../../src/api/types.ts";
import { formatRelative } from "../../src/lib/format.ts";
import {
  bucketLogs,
  budgetPace,
  burnOf,
  credentialStatus,
  groupBy,
  isError,
  lampLabel,
  lampState,
  percentile,
  projectedPace,
  quotaLegend,
  quotaSegments,
  quotaUsage,
  rateRatioOf,
  readingOf,
  summarize,
  withLiveReading,
} from "../../src/lib/vitals.ts";
import { burn, health, log, NOW, quota, quotaSample } from "../helpers/fixtures.ts";

const POLL_MS = 300_000;

/**
 * The fixtures in the ratio space the chart helpers speak.
 *
 * The assertions below stay written in the counts a provider actually reports,
 * and `readingOf` — the one place a used/limit pair becomes a ratio — is
 * exercised on the way in rather than stubbed around.
 */
const reading = (patch: Partial<QuotaSample> = {}) => readingOf(quotaSample(patch));
const liveWindow = (patch: Partial<QuotaWindow> = {}) => readingOf(quota(patch));

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

  test("adds every token class to the bucket volume", () => {
    const buckets = bucketLogs(
      [
        log({
          at: NOW - 30_000,
          inputTokens: 1_000,
          outputTokens: 200,
          cacheReadTokens: 3_000,
          cacheWriteTokens: 400,
        }),
      ],
      { now: NOW, spanMs: 600_000, count: 10 },
    );

    expect(buckets.at(-1)?.tokens).toBe(4_600);
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

describe("quotaLegend", () => {
  test("names the estimate before the reset when the window will not survive", () => {
    const legend = quotaLegend(quota(), NOW, POLL_MS, formatRelative, burn());

    expect(legend).toBe("5h · empty ~30m · resets in 1h");
  });

  test("says a window already at its ceiling is empty now, not in some past hour", () => {
    const legend = quotaLegend(
      quota({ used: 1_000, limit: 1_000 }),
      NOW,
      POLL_MS,
      formatRelative,
      burn({ exhaustsAt: NOW - 600_000, survives: false }),
    );

    expect(legend).toBe("5h · empty now · resets in 1h");
  });

  test("keeps today's reset phrasing when the window survives", () => {
    // "You will not run out" is what the reset time already says; a distant
    // instant beside it would only invite arithmetic.
    const legend = quotaLegend(
      quota(),
      NOW,
      POLL_MS,
      formatRelative,
      burn({ survives: true, exhaustsAt: NOW + 86_400_000 }),
    );

    expect(legend).toBe("5h · resets in 1h");
    expect(legend).not.toContain("empty");
  });

  test("prints no estimate when nothing can be compared to a reset", () => {
    const legend = quotaLegend(
      quota(),
      NOW,
      POLL_MS,
      formatRelative,
      burn({ survives: null, exhaustsAt: null }),
    );

    expect(legend).toBe("5h · resets in 1h");
  });

  test("says a window is waiting on its next reading once its reset has passed", () => {
    // The poller overwrites the row and nothing else does, so for up to one
    // poll interval after a rollover this reading describes a window that has
    // already ended. "resets 5m ago" is a countdown run backwards, printed
    // beside a bar drawn from the spent window's own `used`.
    const legend = quotaLegend(
      quota({ observedAt: NOW - 240_000, resetsAt: NOW - 300_000 }),
      NOW,
      POLL_MS,
      formatRelative,
      burn(),
    );

    expect(legend).toBe("5h · rolled over, waiting for the next reading");
    expect(legend).not.toContain("empty");
  });

  test("a stale reading is reported as stale even once its reset has passed", () => {
    // Both are true of a probe that has not got through for hours, and only one
    // of them is the operator's problem. Reporting the rollover would describe
    // the provider's clock while the gateway is the thing that stopped asking.
    const legend = quotaLegend(
      quota({ observedAt: NOW - 3_600_000, resetsAt: NOW - 1_800_000 }),
      NOW,
      POLL_MS,
      formatRelative,
      burn(),
    );

    expect(legend).toBe("5h · stale, read 1h ago");
  });

  test("suppression wins over the estimate on a stale reading", () => {
    // The burn block deliberately still carries numbers: the guard is the
    // staleness of the reading, not whether an ETA happens to be present.
    const legend = quotaLegend(
      quota({ observedAt: NOW - 3_600_000 }),
      NOW,
      POLL_MS,
      formatRelative,
      burn(),
    );

    expect(legend).toBe("5h · stale, read 1h ago");
    expect(legend).not.toContain("empty");
  });

  test("suppression wins over the estimate when the server marked it stale", () => {
    const legend = quotaLegend(quota(), NOW, POLL_MS, formatRelative, burn({ stale: true }));

    expect(legend).toBe("5h · resets in 1h");
    expect(legend).not.toContain("empty");
  });

  test("a never-observed window says so rather than carrying an estimate", () => {
    const legend = quotaLegend(quota({ observedAt: 0 }), NOW, POLL_MS, formatRelative, burn());

    expect(legend).toBe("5h · never observed");
    expect(legend).not.toContain("empty");
  });

  test("reads as it did before when the gateway sent no estimate at all", () => {
    expect(quotaLegend(quota(), NOW, POLL_MS, formatRelative, undefined)).toBe("5h · resets in 1h");
    expect(quotaLegend(quota({ resetsAt: null }), NOW, POLL_MS, formatRelative, undefined)).toBe(
      "5h",
    );
  });
});

describe("burnOf", () => {
  test("finds the estimate for one window and reports nothing for the rest", () => {
    const rows = [burn(), burn({ windowType: "weekly" })];

    expect(burnOf(rows, "weekly")?.windowType).toBe("weekly");
    expect(burnOf(rows, "daily")).toBeUndefined();
  });
});

describe("quotaSegments", () => {
  test("keeps one window's readings as a single series, oldest first", () => {
    const segments = quotaSegments([
      reading({ observedAt: NOW - 1_000, used: 400 }),
      reading({ observedAt: NOW - 3_000, used: 100 }),
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.points.map((point) => point.at)).toEqual([NOW - 3_000, NOW - 1_000]);
    expect(segments[0]?.points.map((point) => point.percent)).toEqual([10, 40]);
  });

  test("breaks the series at a rollover rather than letting it fall to zero", () => {
    // `resetsAt` moves on every rollover, which is the only signal that the
    // drop in `used` is a new window and not consumption running backwards.
    const segments = quotaSegments([
      reading({ observedAt: NOW - 4_000, used: 200, resetsAt: NOW }),
      reading({ observedAt: NOW - 3_000, used: 800, resetsAt: NOW }),
      reading({ observedAt: NOW - 2_000, used: 50, resetsAt: NOW + 18_000_000 }),
      reading({ observedAt: NOW - 1_000, used: 300, resetsAt: NOW + 18_000_000 }),
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.points.map((point) => point.percent)).toEqual([20, 80]);
    expect(segments[1]?.points.map((point) => point.percent)).toEqual([5, 30]);
    expect(segments[0]?.key).not.toBe(segments[1]?.key);
  });

  test("holds one series through a reset time that only jittered", () => {
    // A provider stating a whole-second countdown has its absolute reset derived
    // per probe, so it drifts by milliseconds while the window stands still.
    // Split on that and every sample becomes its own single-point series, which
    // `stepAfter` with `dot={false}` draws as nothing at all: a blank chart with
    // `segments.length !== 0` suppressing the "not yet observed" note.
    const resets = NOW + 18_000_000;
    const segments = quotaSegments([
      reading({ observedAt: NOW - 1_200_000, used: 100, resetsAt: resets }),
      reading({ observedAt: NOW - 900_000, used: 200, resetsAt: resets + 137 }),
      reading({ observedAt: NOW - 600_000, used: 300, resetsAt: resets - 402 }),
      reading({ observedAt: NOW - 300_000, used: 400, resetsAt: resets + 1_985 }),
      reading({ observedAt: NOW, used: 500, resetsAt: resets + 44 }),
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.points.map((point) => point.percent)).toEqual([10, 20, 30, 40, 50]);
  });

  test("does not draw one budget per idle reading when reset follows the probe", () => {
    const windowMs = 18_000_000;
    const segments = quotaSegments([
      reading({
        observedAt: NOW - 1_200_000,
        used: 0,
        resetsAt: NOW - 1_200_000 + windowMs,
        windowMs,
      }),
      reading({
        observedAt: NOW - 900_000,
        used: 0,
        resetsAt: NOW - 900_000 + windowMs,
        windowMs,
      }),
      reading({
        observedAt: NOW - 600_000,
        used: 0,
        resetsAt: NOW - 600_000 + windowMs,
        windowMs,
      }),
      reading({ observedAt: NOW - 300_000, used: 50, resetsAt: NOW + windowMs, windowMs }),
      reading({ observedAt: NOW, used: 100, resetsAt: NOW + windowMs, windowMs }),
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.points.map((point) => point.percent)).toEqual([0, 0, 0]);
    expect(segments[0]?.startsAt).toBeNull();
    expect(segments[0]?.resetsAt).toBeNull();
    expect(segments[1]?.points.map((point) => point.percent)).toEqual([5, 10]);
    expect(segments.filter((segment) => budgetPace(segment) !== null)).toHaveLength(1);
    const activeSegment = segments[1];
    expect(activeSegment).toBeDefined();
    if (activeSegment === undefined) throw new Error("missing active segment");
    expect(budgetPace(activeSegment)).not.toBeNull();
  });

  test("keeps fixed idle resets and changing active resets unchanged", () => {
    const windowMs = 18_000_000;
    const fixedReset = NOW + windowMs;
    const fixedIdle = quotaSegments([
      reading({ observedAt: NOW - 600_000, used: 0, resetsAt: fixedReset, windowMs }),
      reading({ observedAt: NOW - 300_000, used: 0, resetsAt: fixedReset, windowMs }),
    ]);
    expect(fixedIdle).toHaveLength(1);
    const fixedIdleSegment = fixedIdle[0];
    expect(fixedIdleSegment).toBeDefined();
    if (fixedIdleSegment === undefined) throw new Error("missing fixed idle segment");
    expect(budgetPace(fixedIdleSegment)).not.toBeNull();

    const changingActive = quotaSegments([
      reading({
        observedAt: NOW - 600_000,
        used: 100,
        resetsAt: NOW - 600_000 + windowMs,
        windowMs,
      }),
      reading({
        observedAt: NOW - 300_000,
        used: 200,
        resetsAt: NOW - 300_000 + windowMs,
        windowMs,
      }),
    ]);
    expect(changingActive).toHaveLength(2);
  });

  test("does not merge idle resets when only one reading follows its probe", () => {
    const windowMs = 18_000_000;
    const previousOnly = quotaSegments([
      reading({
        observedAt: NOW - 600_000,
        used: 0,
        resetsAt: NOW - 600_000 + windowMs,
        windowMs,
      }),
      reading({ observedAt: NOW - 300_000, used: 0, resetsAt: NOW + windowMs, windowMs }),
    ]);
    const sampleOnly = quotaSegments([
      reading({
        observedAt: NOW - 600_000,
        used: 0,
        resetsAt: NOW - 1_200_000 + windowMs,
        windowMs,
      }),
      reading({
        observedAt: NOW - 300_000,
        used: 0,
        resetsAt: NOW - 300_000 + windowMs,
        windowMs,
      }),
    ]);

    expect(previousOnly).toHaveLength(2);
    expect(sampleOnly).toHaveLength(2);
  });

  test("the chart splits windows exactly where the shared tolerance does", () => {
    // Pins this site to `SAME_WINDOW_TOLERANCE_MS`, the same constant
    // `saveQuota` dedups on. If the chart and the store ever answered "is this
    // the same window" differently, one of them would be describing a series
    // the other never wrote.
    const resets = NOW + 18_000_000;
    const held = quotaSegments([
      reading({ observedAt: NOW - 1_000, resetsAt: resets }),
      reading({ observedAt: NOW, resetsAt: resets + SAME_WINDOW_TOLERANCE_MS }),
    ]);
    expect(held).toHaveLength(1);

    const split = quotaSegments([
      reading({ observedAt: NOW - 1_000, resetsAt: resets }),
      reading({ observedAt: NOW, resetsAt: resets + SAME_WINDOW_TOLERANCE_MS + 1 }),
    ]);
    expect(split).toHaveLength(2);
  });

  test("drops readings with no ceiling to draw them against", () => {
    expect(quotaSegments([reading({ limit: null }), reading({ limit: 0 })])).toEqual([]);
  });

  test("never draws past a full window", () => {
    const segments = quotaSegments([reading({ used: 4_000, limit: 1_000 })]);

    expect(segments[0]?.points[0]?.percent).toBe(100);
  });
});

describe("withLiveReading", () => {
  const RESETS_AT = NOW + 3_600_000;

  /** Two readings inside the live window, the newest of them long before now. */
  function idleRun() {
    return quotaSegments([
      reading({ observedAt: NOW - 3_000_000, used: 100, resetsAt: RESETS_AT }),
      reading({ observedAt: NOW - 2_000_000, used: 300, resetsAt: RESETS_AT }),
    ]);
  }

  test("carries the live window's run up to the reading the snapshot was taken at", () => {
    // An account nobody is spending changes nothing, dedup retains nothing, and
    // the run ends at the last change rather than at the last probe. The
    // snapshot is that probe, and the stretch between them was measured.
    // 500 against the run's own newest reading of 300, so the appended percent
    // can only come from the snapshot. Reusing the retained one would pass an
    // assertion written against a fixture where the two agree.
    const segments = withLiveReading(
      idleRun(),
      liveWindow({ used: 500, limit: 1_000, observedAt: NOW - 30_000, resetsAt: RESETS_AT }),
    );

    expect(segments).toHaveLength(1);
    expect(segments[0]?.points.map((point) => point.at)).toEqual([
      NOW - 3_000_000,
      NOW - 2_000_000,
      NOW - 30_000,
    ]);
    expect(segments[0]?.points[1]?.percent).toBe(30);
    expect(segments[0]?.points[2]?.percent).toBe(50);
  });

  test("attaches the snapshot to the newest run it could belong to", () => {
    // `sameWindow` is a ±60s tolerance, and a tolerance is not transitive: two
    // runs 100s apart split from each other, yet each sits within 60s of the
    // snapshot's own reset and matches it. The newest is the window the
    // snapshot was read in — hanging it off the older one draws that run's line
    // forward across the newer one it already ended before.
    const older = RESETS_AT - 50_000;
    const newer = RESETS_AT + 50_000;
    const runs = quotaSegments([
      reading({ observedAt: NOW - 3_000_000, used: 100, resetsAt: older }),
      reading({ observedAt: NOW - 2_500_000, used: 200, resetsAt: older }),
      reading({ observedAt: NOW - 2_000_000, used: 300, resetsAt: newer }),
      reading({ observedAt: NOW - 1_500_000, used: 400, resetsAt: newer }),
    ]);
    expect(runs).toHaveLength(2);

    const segments = withLiveReading(
      runs,
      liveWindow({ used: 600, limit: 1_000, observedAt: NOW - 30_000, resetsAt: RESETS_AT }),
    );

    expect(segments[0]?.points.map((point) => point.at)).toEqual([
      NOW - 3_000_000,
      NOW - 2_500_000,
    ]);
    expect(segments[1]?.points.map((point) => point.at)).toEqual([
      NOW - 2_000_000,
      NOW - 1_500_000,
      NOW - 30_000,
    ]);
  });

  test("draws a snapshot past its own ceiling at a full window, not past one", () => {
    // Load-bearing on the chart, not cosmetic: the y domain is `[0, ceiling]`
    // with `allowDataOverflow`, and `ceiling` is computed from the projection
    // alone. A reading above it is clipped off the top of the plot, taking the
    // trailing stretch of the line with it.
    const segments = withLiveReading(
      idleRun(),
      liveWindow({ used: 1_500, limit: 1_000, observedAt: NOW - 30_000, resetsAt: RESETS_AT }),
    );

    expect(segments[0]?.points[2]?.percent).toBe(100);
  });

  test("leaves a settled run alone rather than handing it the next window's reading", () => {
    // The run belongs to a window that has already rolled over. Its readings
    // counted down to their own reset, and the live one is a different window
    // with a different ceiling to have spent.
    const rolled = RESETS_AT + SAME_WINDOW_TOLERANCE_MS + 1;
    const segments = withLiveReading(
      idleRun(),
      liveWindow({ used: 900, limit: 1_000, observedAt: NOW - 30_000, resetsAt: rolled }),
    );

    expect(segments[0]?.points.map((point) => point.at)).toEqual([
      NOW - 3_000_000,
      NOW - 2_000_000,
    ]);
  });

  test("creates no run where nothing was retained", () => {
    // What keeps "not yet observed" reachable: one snapshot is a reading, not a
    // history, and a panel drawing it alone would claim a chart it has no data
    // for.
    expect(
      withLiveReading([], liveWindow({ used: 300, limit: 1_000, resetsAt: RESETS_AT })),
    ).toHaveLength(0);
  });

  test("adds nothing when the newest retained reading is the snapshot itself", () => {
    // The reading moved, so it was retained, and the snapshot reports the same
    // instant. Appending it again would put two points on one x.
    const segments = withLiveReading(
      idleRun(),
      liveWindow({ used: 300, limit: 1_000, observedAt: NOW - 2_000_000, resetsAt: RESETS_AT }),
    );

    expect(segments[0]?.points).toHaveLength(2);
  });

  test("draws nothing from a snapshot with no ceiling to draw it against", () => {
    // The same rule the retained readings are dropped under: a percentage of an
    // unstated limit is not a number.
    const runs = idleRun();
    expect(
      withLiveReading(runs, liveWindow({ used: 300, limit: null, resetsAt: RESETS_AT })),
    ).toEqual(runs);
    expect(withLiveReading(runs, liveWindow({ used: 300, limit: 0, resetsAt: RESETS_AT }))).toEqual(
      runs,
    );
  });

  test("leaves the runs it was given untouched", () => {
    // The panel derives budgets and rows from the same list, so a run that grew
    // a point in place would be a different chart depending on read order.
    const runs = idleRun();
    const extended = withLiveReading(
      runs,
      liveWindow({ used: 300, limit: 1_000, observedAt: NOW, resetsAt: RESETS_AT }),
    );

    expect(runs[0]?.points).toHaveLength(2);
    expect(extended[0]?.points).toHaveLength(3);
    expect(extended[0]).not.toBe(runs[0]);
  });
});

const HOUR = 3_600_000;

/** The one run of readings in a set of samples, or a failure saying so. */
function onlySegment(samples: Parameters<typeof quotaSegments>[0]) {
  const segments = quotaSegments(samples);
  const segment = segments[0];
  if (segments.length !== 1 || segment === undefined) throw new Error("expected one segment");
  return segment;
}

describe("budgetPace", () => {
  test("runs from empty at the window start to full at the reset", () => {
    const resetsAt = NOW + HOUR;
    const pace = budgetPace(onlySegment([reading({ observedAt: NOW - 600_000, resetsAt })]));

    // Five hours back from the reset, which is where this window began.
    expect(pace).toEqual({
      from: { at: resetsAt - 5 * HOUR, percent: 0 },
      to: { at: resetsAt, percent: 100 },
    });
  });

  test("believes a provider that stated its own window length", () => {
    // A three-hour window read as five puts the budget two hours too early, and
    // every reading then looks ahead of a pace it was never on.
    const resetsAt = NOW + HOUR;
    const pace = budgetPace(onlySegment([reading({ resetsAt, windowMs: 3 * HOUR })]));

    expect(pace?.from.at).toBe(resetsAt - 3 * HOUR);
  });

  test("gives the preceding window the budget of its own window, not the current one's", () => {
    const resetsAt = NOW + HOUR;
    const previous = resetsAt - 5 * HOUR;
    const segments = quotaSegments([
      reading({ observedAt: previous - HOUR, used: 400, resetsAt: previous }),
      reading({ observedAt: previous + HOUR, used: 100, resetsAt }),
    ]);
    const [before, current] = segments.map((segment) => budgetPace(segment));

    expect(before).toEqual({
      from: { at: previous - 5 * HOUR, percent: 0 },
      to: { at: previous, percent: 100 },
    });
    expect(current?.to.at).toBe(resetsAt);
  });

  test("has no budget for a run the provider named no reset for", () => {
    // Nothing to count back from and no endpoint to draw to. Falling back to
    // the current window's reset would draw a pace for a different window.
    expect(budgetPace(onlySegment([reading({ resetsAt: null })]))).toBeNull();
  });
});

describe("projectedPace", () => {
  test("carries the reading forward at the rate it was read at", () => {
    const window = quota({ used: 500, limit: 1_000, observedAt: NOW, resetsAt: NOW + 2 * HOUR });
    const pace = projectedPace(readingOf(window), rateRatioOf(window, burn({ ratePerHour: 100 })));

    // 100 units an hour against a thousand-unit ceiling is ten points an hour.
    expect(pace).toEqual({
      from: { at: NOW, percent: 50 },
      to: { at: NOW + 2 * HOUR, percent: 70 },
    });
  });

  test("crosses the ceiling at the instant the estimate names", () => {
    // The projection and `exhaustsAt` are the same claim drawn two ways: both
    // start at `observedAt` and both run at `ratePerHour`. If they disagree,
    // one of them is anchored to the wrong instant — which is what reaching for
    // `now` here would do, and what nothing else in this panel would catch.
    const observedAt = NOW - 5 * 60_000;
    const resetsAt = NOW + 3 * HOUR;
    const ratePerHour = 240;
    const window = quota({ used: 620, limit: 1_000, observedAt, resetsAt });
    // As `@omni/control` defines it: the remaining allowance at that rate.
    const exhaustsAt = observedAt + ((1_000 - 620) / ratePerHour) * HOUR;

    const pace = projectedPace(
      readingOf(window),
      rateRatioOf(window, burn({ ratePerHour, exhaustsAt })),
    );
    if (pace === null) throw new Error("expected a projection");
    const crossesAt =
      pace.from.at +
      ((100 - pace.from.percent) / (pace.to.percent - pace.from.percent)) *
        (pace.to.at - pace.from.at);

    expect(Math.abs(crossesAt - exhaustsAt)).toBeLessThan(1);
  });

  test("stops at the ceiling rather than projecting past it", () => {
    // The minutes after a rollover are the case this exists for: `used` is
    // divided by an elapsed span of minutes, so the rate is enormous and an
    // unbounded endpoint lands in the thousands of percent. The panel scales
    // its axis to whatever the projection reached, so one such endpoint flattens
    // every measured reading onto the floor and the chart stops being readable.
    const observedAt = NOW;
    const resetsAt = NOW + 7 * 24 * HOUR;
    const ratePerHour = 6_000;
    const window = quota({ used: 500, limit: 1_000, observedAt, resetsAt });
    const pace = projectedPace(readingOf(window), rateRatioOf(window, burn({ ratePerHour })));
    if (pace === null) throw new Error("expected a projection");

    // Truncated at the ceiling, not clipped flat against it: the endpoint moves
    // to the instant the line reaches 100%, which is the same instant
    // `exhaustsAt` names, so the slope drawn is still the rate that was read.
    expect(pace.to.percent).toBe(100);
    expect(pace.to.at).toBe(observedAt + ((1_000 - 500) / ratePerHour) * HOUR);
    expect(pace.from).toEqual({ at: observedAt, percent: 50 });
  });

  test("a window read past its own ceiling projects no further", () => {
    // `used` over `limit` is what a provider reports when the window is spent.
    // There is no crossing instant ahead of the reading, so the projection is a
    // point at the ceiling rather than a line climbing away from it.
    const window = quota({ used: 1_400, limit: 1_000, observedAt: NOW, resetsAt: NOW + HOUR });
    const pace = projectedPace(readingOf(window), rateRatioOf(window, burn({ ratePerHour: 100 })));

    expect(pace).toEqual({
      from: { at: NOW, percent: 100 },
      to: { at: NOW, percent: 100 },
    });
  });

  test("says nothing when there is no ceiling to be a percentage of", () => {
    const window = quota({ used: 500, limit: null, observedAt: NOW, resetsAt: NOW + HOUR });

    expect(
      projectedPace(readingOf(window), rateRatioOf(window, burn({ ratePerHour: 100 }))),
    ).toBeNull();
  });

  test("says nothing when the provider named no reset to project to", () => {
    const window = quota({ used: 500, limit: 1_000, observedAt: NOW, resetsAt: null });

    expect(
      projectedPace(readingOf(window), rateRatioOf(window, burn({ ratePerHour: 100 }))),
    ).toBeNull();
  });

  test("says nothing when the rate is unknown or standing still", () => {
    // Zero is not a projection of "stays where it is": it is what an account
    // with one reading reports, and a flat line would claim it will never move.
    const window = quota({ used: 500, limit: 1_000, observedAt: NOW, resetsAt: NOW + HOUR });

    expect(
      projectedPace(readingOf(window), rateRatioOf(window, burn({ ratePerHour: null }))),
    ).toBeNull();
    expect(
      projectedPace(readingOf(window), rateRatioOf(window, burn({ ratePerHour: 0 }))),
    ).toBeNull();
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
