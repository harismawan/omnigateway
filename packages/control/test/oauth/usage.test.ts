import { expect, test } from "bun:test";
import { parseAnthropicUsage } from "../../src/oauth/anthropic.ts";
import { parseKimiUsage } from "../../src/oauth/kimi.ts";
import { parseOpenAIUsage } from "../../src/oauth/openai.ts";
import { windowFrom } from "../../src/oauth/usage.ts";

const NOW = 1_800_000_000_000;

test("a percentage-only window is normalized to a value out of 100", () => {
  expect(windowFrom({ utilization: 62.5 }, "fiveHour", NOW)).toEqual({
    windowType: "fiveHour",
    used: 62.5,
    limit: 100,
    resetsAt: null,
    windowMs: null,
  });
});

test("an explicit used and limit pair is preferred over a percentage", () => {
  // The provider's own arithmetic wins: a rounded percentage next to exact
  // counts would otherwise redraw the same fact less precisely.
  expect(windowFrom({ used: 300, limit: 1_000, utilization: 31 }, "weekly", NOW)).toMatchObject({
    used: 300,
    limit: 1_000,
  });
});

test("a remaining count is read as usage against the same ceiling", () => {
  expect(windowFrom({ remaining: 250, limit: 1_000 }, "daily", NOW)).toMatchObject({
    used: 750,
    limit: 1_000,
  });
});

test("reset times are read as ISO, epoch seconds, epoch milliseconds, or relative", () => {
  const iso = windowFrom({ used: 1, resets_at: "2027-01-01T00:00:00.000Z" }, "fiveHour", NOW);
  expect(iso?.resetsAt).toBe(Date.parse("2027-01-01T00:00:00.000Z"));

  const seconds = windowFrom({ used: 1, resets_at: 1_900_000_000 }, "fiveHour", NOW);
  expect(seconds?.resetsAt).toBe(1_900_000_000_000);

  const millis = windowFrom({ used: 1, resets_at: 1_900_000_000_000 }, "fiveHour", NOW);
  expect(millis?.resetsAt).toBe(1_900_000_000_000);

  const relative = windowFrom({ used: 1, resets_in_seconds: 600 }, "fiveHour", NOW);
  expect(relative?.resetsAt).toBe(NOW + 600_000);
});

test("a window with no numbers is not a window", () => {
  expect(windowFrom({ label: "five hour" }, "fiveHour", NOW)).toBeNull();
  expect(windowFrom(null, "fiveHour", NOW)).toBeNull();
  expect(windowFrom("62%", "fiveHour", NOW)).toBeNull();
});

test("anthropic five-hour and seven-day windows map onto the stored window types", () => {
  const report = parseAnthropicUsage(
    {
      five_hour: { utilization: 62, resets_at: "2026-08-08T18:00:00.000Z" },
      seven_day: { utilization: 18, resets_at: "2026-08-12T00:00:00.000Z" },
    },
    NOW,
  );

  expect(report?.windows.map((w) => w.windowType)).toEqual(["fiveHour", "weekly"]);
  expect(report?.windows[0]).toMatchObject({ used: 62, limit: 100 });
  expect(report?.windows[1]?.resetsAt).toBe(Date.parse("2026-08-12T00:00:00.000Z"));
});

test("anthropic windows are read through a wrapper as well as at the top level", () => {
  const report = parseAnthropicUsage({ usage: { five_hour: { utilization: 5 } } }, NOW);
  expect(report?.windows).toHaveLength(1);
  expect(report?.windows[0]).toMatchObject({ windowType: "fiveHour", used: 5 });
});

test("a plan reporting only one window yields only that window", () => {
  const report = parseAnthropicUsage({ five_hour: { utilization: 5 } }, NOW);
  expect(report?.windows).toHaveLength(1);
});

test("an unreadable anthropic payload reports nothing rather than zero usage", () => {
  // Zero would be a claim about the account. Null is the truth: we do not know.
  expect(parseAnthropicUsage({ five_hour: {} }, NOW)).toBeNull();
  expect(parseAnthropicUsage({}, NOW)).toBeNull();
  expect(parseAnthropicUsage("nope", NOW)).toBeNull();
});

test("codex primary and secondary windows map to five-hour and weekly", () => {
  const report = parseOpenAIUsage(
    {
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 41, reset_after_seconds: 7_200 },
        secondary_window: { used_percent: 9, reset_at: 1_900_000_000 },
      },
    },
    NOW,
  );

  expect(report?.windows.map((w) => w.windowType)).toEqual(["fiveHour", "weekly"]);
  expect(report?.windows[0]).toMatchObject({ used: 41, limit: 100, resetsAt: NOW + 7_200_000 });
  // Codex states its absolute reset in epoch seconds.
  expect(report?.windows[1]?.resetsAt).toBe(1_900_000_000_000);
});

test("a codex payload with only the short window yields only that window", () => {
  const report = parseOpenAIUsage(
    { rate_limit: { primary_window: { used_percent: 12, reset_after_seconds: 60 } } },
    NOW,
  );
  expect(report?.windows).toHaveLength(1);
  expect(report?.windows[0]?.windowType).toBe("fiveHour");
});

test("a codex window is named by the duration it declares, not by its position", () => {
  // Observed on a `prolite` account in August 2026: Codex dropped the five-hour
  // cap, leaving `primary_window` carrying the *weekly* allowance and
  // `secondary_window` null. Reading position alone labels a seven-day window
  // "fiveHour", which the router then prices as if it reset 34 times sooner.
  const report = parseOpenAIUsage(
    {
      plan_type: "prolite",
      rate_limit: {
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 604_800,
          reset_after_seconds: 578_791,
          reset_at: 1_786_776_104,
        },
        secondary_window: null,
      },
    },
    NOW,
  );

  expect(report?.windows).toHaveLength(1);
  expect(report?.windows[0]?.windowType).toBe("weekly");
});

test("a declared duration outranks position for both codex windows", () => {
  const report = parseOpenAIUsage(
    {
      rate_limit: {
        primary_window: { used_percent: 1, limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 2, limit_window_seconds: 604_800 },
      },
    },
    NOW,
  );

  expect(report?.windows.map((w) => w.windowType)).toEqual(["fiveHour", "weekly"]);
});

test("a codex daily window is not rounded up into a weekly one", () => {
  const report = parseOpenAIUsage(
    { rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 86_400 } } },
    NOW,
  );

  expect(report?.windows[0]?.windowType).toBe("daily");
});

test("codex reports the duration it declared, not the one its bucket is named after", () => {
  // The bucket names are three, the durations are not: a three-hour window is
  // stored as `fiveHour`, and inferring its start from five hours would place
  // it two hours too early. Keeping the declared seconds is the correction.
  const report = parseOpenAIUsage(
    {
      rate_limit: {
        primary_window: { used_percent: 1, limit_window_seconds: 10_800 },
        secondary_window: { used_percent: 2, limit_window_seconds: 604_800 },
      },
    },
    NOW,
  );

  expect(report?.windows.map((w) => w.windowType)).toEqual(["fiveHour", "weekly"]);
  expect(report?.windows.map((w) => w.windowMs)).toEqual([10_800_000, 604_800_000]);
});

test("a codex window with no declared duration reports none, and is bucketed as before", () => {
  const report = parseOpenAIUsage(
    {
      rate_limit: {
        primary_window: { used_percent: 41, reset_after_seconds: 7_200 },
        secondary_window: { used_percent: 9, reset_at: 1_900_000_000 },
      },
    },
    NOW,
  );

  expect(report?.windows.map((w) => w.windowType)).toEqual(["fiveHour", "weekly"]);
  expect(report?.windows.map((w) => w.windowMs)).toEqual([null, null]);

  // A nonsense duration is no duration; it must not become a zero-length window.
  const zero = parseOpenAIUsage(
    { rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 0 } } },
    NOW,
  );
  expect(zero?.windows[0]).toMatchObject({ windowType: "fiveHour", windowMs: null });
});

test("anthropic and kimi report no window duration", () => {
  // Neither states one, and inventing a duration from the bucket name would be
  // a claim they never made.
  const anthropic = parseAnthropicUsage(
    { five_hour: { utilization: 62 }, seven_day: { utilization: 18 } },
    NOW,
  );
  expect(anthropic?.windows.map((w) => w.windowMs)).toEqual([null, null]);

  const kimi = parseKimiUsage({ usage: { limit: "100", used: "92" } }, NOW);
  expect(kimi?.windows.map((w) => w.windowMs)).toEqual([null]);
});

test("codex feature caps are not mistaken for the plan window", () => {
  // code_review and the additional_rate_limits entries cap a feature, not the
  // subscription the router is choosing between.
  const report = parseOpenAIUsage(
    {
      code_review_rate_limit: { primary_window: { used_percent: 99 } },
      additional_rate_limits: [{ rate_limit: { primary_window: { used_percent: 99 } } }],
    },
    NOW,
  );
  expect(report).toBeNull();
});

test("kimi reports one plan window whose counters are strings", () => {
  const report = parseKimiUsage(
    {
      user: { id: "u1" },
      usage: { limit: "100", used: "92", remaining: "8", resetTime: "2026-08-15T00:00:00.000Z" },
      limits: [{ detail: { limit: 60, remaining: 12 } }],
    },
    NOW,
  );

  expect(report?.windows).toHaveLength(1);
  expect(report?.windows[0]).toMatchObject({ windowType: "weekly", used: 92, limit: 100 });
  expect(report?.windows[0]?.resetsAt).toBe(Date.parse("2026-08-15T00:00:00.000Z"));
});

test("kimi per-minute rate limits are not read as the plan window", () => {
  // `limits` describes request bursts the breaker already reacts to. Treating
  // one as the subscription would park an account over a minute of throttling.
  const report = parseKimiUsage({ limits: [{ detail: { limit: 60, remaining: 0 } }] }, NOW);
  expect(report).toBeNull();
});
