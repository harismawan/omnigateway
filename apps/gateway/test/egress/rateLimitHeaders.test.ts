import { expect, test } from "bun:test";
import type { HeadroomByDimension } from "@omni/ratelimit";
import { anthropicRateLimitHeaders } from "../../src/egress/anthropic.ts";
import { openaiRateLimitHeaders } from "../../src/egress/openai.ts";

/** 2026-08-18T09:32:07Z, so five hours on is the instant the design writes out. */
const NOW = Date.UTC(2026, 7, 18, 9, 32, 7);
const FIVE_HOURS = 5 * 60 * 60 * 1000;

const HEADROOM: HeadroomByDimension = {
  requests: { window: "5h", limit: 2000, used: 159, remaining: 1841, resetAt: NOW + FIVE_HOURS },
  tokens: {
    window: "1w",
    limit: 50_000_000,
    used: 1_879_666,
    remaining: 48_120_334,
    resetAt: NOW + 17_482_000,
  },
};

test("the Anthropic dialect names an instant, in RFC3339 to the second", () => {
  expect(anthropicRateLimitHeaders(HEADROOM)).toEqual({
    "anthropic-ratelimit-requests-limit": "2000",
    "anthropic-ratelimit-requests-remaining": "1841",
    "anthropic-ratelimit-requests-reset": "2026-08-18T14:32:07Z",
    "anthropic-ratelimit-tokens-limit": "50000000",
    "anthropic-ratelimit-tokens-remaining": "48120334",
    "anthropic-ratelimit-tokens-reset": "2026-08-18T14:23:29Z",
  });
});

test("the OpenAI dialect names a duration, in the spelling its own headers use", () => {
  expect(openaiRateLimitHeaders(HEADROOM, NOW)).toEqual({
    "x-ratelimit-limit-requests": "2000",
    "x-ratelimit-remaining-requests": "1841",
    "x-ratelimit-reset-requests": "5h0m0s",
    "x-ratelimit-limit-tokens": "50000000",
    "x-ratelimit-remaining-tokens": "48120334",
    "x-ratelimit-reset-tokens": "4h51m22s",
  });
});

/**
 * The components are not independent: a zero minute between a live hour and a
 * live second is still printed, and a zero hour is not. Asserted against known
 * instants rather than for shape, because "some digits and an s" passes for any
 * arithmetic at all.
 */
test("an OpenAI duration prints the components its magnitude reaches and no others", () => {
  const cases: Array<[number, string]> = [
    [0, "0s"],
    // Rounded up, both because a client sent back early is refused twice and
    // because a sub-second wait rendered as `0s` is a busy loop.
    [1, "1s"],
    [22_000, "22s"],
    [360_000, "6m0s"],
    [3_600_000, "1h0m0s"],
    [17_482_000, "4h51m22s"],
    // A reset already in the past is not a negative duration.
    [-5_000, "0s"],
  ];
  for (const [ms, expected] of cases) {
    const headroom: HeadroomByDimension = {
      requests: { window: "1m", limit: 1, used: 0, remaining: 1, resetAt: NOW + ms },
    };
    expect(openaiRateLimitHeaders(headroom, NOW)["x-ratelimit-reset-requests"]).toBe(expected);
  }
});

/**
 * A ceiling nobody set has no distance from it to report. `limit: unlimited` is
 * not a number any client parses, and an SDK that reads one of the three
 * headers and not the others backs off from a half-rendered pair.
 */
test("a dimension with no configured limit contributes nothing on either dialect", () => {
  const requestsOnly: HeadroomByDimension = {
    requests: { window: "1m", limit: 60, used: 3, remaining: 57, resetAt: NOW + 60_000 },
  };
  expect(Object.keys(anthropicRateLimitHeaders(requestsOnly)).sort()).toEqual([
    "anthropic-ratelimit-requests-limit",
    "anthropic-ratelimit-requests-remaining",
    "anthropic-ratelimit-requests-reset",
  ]);
  expect(Object.keys(openaiRateLimitHeaders(requestsOnly, NOW)).sort()).toEqual([
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
  ]);
  expect(anthropicRateLimitHeaders({})).toEqual({});
  expect(openaiRateLimitHeaders({}, NOW)).toEqual({});
});

/**
 * Neither vendor defines a header for either, so a rendered one is a number no
 * client parses, on every response, forever.
 */
test("spend and concurrency are never rendered, on either dialect", () => {
  const spending: HeadroomByDimension = {
    spend: { window: "1w", limit: 25, used: 20, remaining: 5, resetAt: NOW + 60_000 },
  };
  expect(anthropicRateLimitHeaders(spending)).toEqual({});
  expect(openaiRateLimitHeaders(spending, NOW)).toEqual({});
});
