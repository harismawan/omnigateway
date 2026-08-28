import { expect, test } from "bun:test";
import type { QuotaWindow } from "@omni/store";
import { memoryStore, quota, seedCredential } from "@omni/testkit";
import { type BurnInput, burnEstimates, burnFor } from "../../src/quota/burn.ts";

const HOUR = 3_600_000;
const OBSERVED = 1_700_000_000_000;
const POLL_MS = 300_000;
/** `quotaStaleAfterMs(300_000)` — three poll intervals. */
const STALE_AFTER = 900_000;

/** A five-hour window read two hours in, with three hours still to run. */
function window(overrides: Partial<QuotaWindow> = {}): QuotaWindow {
  return quota({
    credentialId: "c1",
    windowType: "fiveHour",
    used: 100,
    limit: 1_000,
    resetsAt: OBSERVED + 3 * HOUR,
    observedAt: OBSERVED,
    ...overrides,
  });
}

function at(now: number): BurnInput {
  return { now, pollIntervalMs: POLL_MS };
}

test("rate and exhaustion are derived from the reading alone", () => {
  const estimate = burnFor(window(), at(OBSERVED));

  expect(estimate).toEqual({
    credentialId: "c1",
    windowType: "fiveHour",
    // resetsAt minus the nominal five hours.
    windowStartsAt: OBSERVED - 2 * HOUR,
    // 100 units over two hours.
    ratePerHour: 50,
    // 900 left at 50/h is eighteen hours away.
    exhaustsAt: OBSERVED + 18 * HOUR,
    survives: true,
    stale: false,
  });
});

test("survives is false when the estimate falls short of the reset", () => {
  const estimate = burnFor(window({ used: 800 }), at(OBSERVED));

  expect(estimate.ratePerHour).toBe(400);
  expect(estimate.exhaustsAt).toBe(OBSERVED + HOUR / 2);
  expect(estimate.survives).toBe(false);
});

test("survives is true when the estimate falls past the reset", () => {
  // 300 used in two hours is 150/h; the remaining 700 outlast the three hours
  // the window still has to run.
  const estimate = burnFor(window({ used: 300, limit: 1_000 }), at(OBSERVED));

  expect(estimate.exhaustsAt).toBeGreaterThan(OBSERVED + 3 * HOUR);
  expect(estimate.survives).toBe(true);
});

test("a window with no limit reports no exhaustion estimate", () => {
  const estimate = burnFor(window({ limit: null }), at(OBSERVED));

  expect(estimate.exhaustsAt).toBeNull();
  expect(estimate.stale).toBe(false);
});

test("a window with no reset reports no rate at all, rather than zero", () => {
  const estimate = burnFor(window({ resetsAt: null }), at(OBSERVED));

  expect(estimate.windowStartsAt).toBeNull();
  expect(estimate.ratePerHour).toBeNull();
  expect(estimate.exhaustsAt).toBeNull();
});

test("a window that just rolled over reads as not burning rather than as infinite", () => {
  // resetsAt exactly one nominal window out puts the start at the reading.
  const fresh = burnFor(window({ resetsAt: OBSERVED + 5 * HOUR, used: 0 }), at(OBSERVED));
  expect(fresh.ratePerHour).toBe(0);
  expect(fresh.exhaustsAt).toBeNull();
  expect(fresh.survives).toBe(true);

  // A reset further out than the window is long puts the start in the future.
  const ahead = burnFor(window({ resetsAt: OBSERVED + 6 * HOUR, used: 10 }), at(OBSERVED));
  expect(ahead.ratePerHour).toBe(0);
  expect(ahead.exhaustsAt).toBeNull();
});

test("a window with nothing used yet reports a zero rate and no estimate", () => {
  const estimate = burnFor(window({ used: 0 }), at(OBSERVED));

  expect(estimate.ratePerHour).toBe(0);
  expect(estimate.exhaustsAt).toBeNull();
  expect(estimate.survives).toBe(true);
});

test("a reading nobody believes is suppressed rather than extrapolated", () => {
  const estimate = burnFor(window(), at(OBSERVED + STALE_AFTER + 1));

  expect(estimate).toEqual({
    credentialId: "c1",
    windowType: "fiveHour",
    windowStartsAt: null,
    ratePerHour: null,
    exhaustsAt: null,
    survives: null,
    stale: true,
  });
});

test("a window past its own reset is suppressed, however fresh the reading", () => {
  // The row is overwritten by the poller and by nothing else, so for up to one
  // poll interval after a rollover it holds a reading of a window that has
  // already ended. Extrapolating from it reported the spent window's rate and
  // its exhaustion instant while the new one was already running — and the
  // reading itself is minutes old, so no staleness check catches it. The router
  // has always dropped these; this is the same rule, asked once.
  const rolledOver = window({ resetsAt: OBSERVED + 60_000 });
  const estimate = burnFor(rolledOver, at(OBSERVED + 120_000));

  expect(estimate).toEqual({
    credentialId: "c1",
    windowType: "fiveHour",
    // Kept: a restatement of the reset and the window's length, as true of the
    // window that ended as of one still running, and what the console charts
    // the retained readings against. Only the inference is dropped.
    windowStartsAt: OBSERVED + 60_000 - 5 * HOUR,
    ratePerHour: null,
    exhaustsAt: null,
    survives: null,
    stale: true,
  });

  // A minute earlier the same reading still describes a live window.
  expect(burnFor(rolledOver, at(OBSERVED + 59_000)).stale).toBe(false);
});

test("a stale reading keeps nothing, a rolled-over one keeps where it began", () => {
  // The two suppressions are not the same verdict. A reading too old to believe
  // says nothing about the window at all; one whose reset has passed places the
  // window exactly and only stops claiming what is being spent inside it.
  const rolledOver = window({ resetsAt: OBSERVED + 60_000 });

  expect(burnFor(rolledOver, at(OBSERVED + 120_000)).windowStartsAt).not.toBeNull();
  expect(burnFor(window(), at(OBSERVED + STALE_AFTER + 1)).windowStartsAt).toBeNull();
});

test("a window never observed at all is suppressed", () => {
  const estimate = burnFor(window({ observedAt: 0 }), at(OBSERVED));

  expect(estimate.stale).toBe(true);
  expect(estimate.ratePerHour).toBeNull();
});

test("a provider-reported duration overrides the nominal one, and its absence falls back", () => {
  const row = window({ resetsAt: OBSERVED + HOUR, used: 100 });

  // Three hours long: the window began two hours before the reading.
  expect(burnFor({ ...row, windowMs: 3 * HOUR }, at(OBSERVED)).windowStartsAt).toBe(
    OBSERVED - 2 * HOUR,
  );
  expect(burnFor({ ...row, windowMs: 3 * HOUR }, at(OBSERVED)).ratePerHour).toBe(50);

  // Nominal five hours: the window began four hours before the reading.
  expect(burnFor(row, at(OBSERVED)).windowStartsAt).toBe(OBSERVED - 4 * HOUR);
  expect(burnFor(row, at(OBSERVED)).ratePerHour).toBe(25);
});

test("the estimate is invariant under now, and only the staleness verdict flips", () => {
  const row = window();
  const fresh = [0, 1_000, POLL_MS, 2 * POLL_MS, STALE_AFTER].map((ahead) =>
    burnFor(row, at(OBSERVED + ahead)),
  );

  // Byte-identical across five reads spanning three poll intervals: the
  // numerator and the denominator are both as of `observedAt`, so nothing here
  // may sag between probes.
  for (const estimate of fresh) {
    expect(estimate.windowStartsAt).toBe(OBSERVED - 2 * HOUR);
    expect(estimate.ratePerHour).toBe(50);
    expect(estimate.exhaustsAt).toBe(OBSERVED + 18 * HOUR);
    expect(estimate.stale).toBe(false);
    expect(estimate).toEqual(fresh[0] as typeof estimate);
  }

  const past = burnFor(row, at(OBSERVED + STALE_AFTER + 1));
  expect(past.stale).toBe(true);
});

test("the estimate reads no table at all", async () => {
  const store = await memoryStore();
  await seedCredential(store, { id: "c1" });
  await store.credentials.saveQuota([window()]);
  const windows = await store.credentials.listQuota();
  expect(
    await store.credentials.listQuotaSamples({ since: 0, until: OBSERVED + HOUR }),
  ).not.toHaveLength(0);

  // Two claims at once, and only a throw can make either. The estimate is a
  // whole-window average of one reading, so it must not consult the sample
  // series — that is what lets it appear on a freshly upgraded install. And it
  // rides a route the console refetches every ten seconds, so it must not
  // aggregate `request_logs` either.
  store.credentials.listQuotaSamples = async () => {
    throw new Error("the estimate must not read the sample series");
  };
  store.usage.aggregate = () => {
    throw new Error("the estimate must not aggregate request logs");
  };

  const [estimate] = burnEstimates(windows, { now: OBSERVED, pollIntervalMs: POLL_MS });

  expect(estimate?.ratePerHour).toBe(50);
  expect(estimate?.exhaustsAt).toBe(OBSERVED + 18 * HOUR);
});
