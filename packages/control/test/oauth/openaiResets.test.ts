import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { HttpClient, HttpRequest } from "@omni/providers";
import { parseResetCredits } from "@omni/providers";
import { openaiOAuth } from "./builtins.ts";

const NOW = 1_000_000;

/** Answers each call from the queue in order and remembers every request. */
function stubHttp(...replies: { status: number; body: unknown }[]) {
  const seen: HttpRequest[] = [];
  const client = (async (req: HttpRequest) => {
    seen.push(req);
    const reply = replies.shift() ?? { status: 500, body: {} };
    return {
      status: reply.status,
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
      text: async () => JSON.stringify(reply.body),
    };
  }) as HttpClient;
  return { client, seen };
}

/** Verbatim shape of `GET /wham/rate-limit-reset-credits`, measured 2026-09-24 (ids shortened). */
const LISTED = {
  credits: [
    {
      id: "RateLimitResetCredit_aaa",
      reset_type: "codex_rate_limits",
      is_supported_by_plan: true,
      status: "available",
      granted_at: "2026-09-22T20:29:32.601937Z",
      expires_at: "2026-10-22T20:29:32.601937Z",
      redeem_started_at: null,
      redeemed_at: null,
      title: "Full reset",
      description: "Thanks for using Codex! You've been granted one free rate limit reset.",
    },
    {
      id: "RateLimitResetCredit_bbb",
      status: "redeemed",
      granted_at: "2026-06-12T00:00:00Z",
      expires_at: "2026-07-12T00:00:00Z",
      title: null,
    },
  ],
  available_count: 1,
  total_earned_count: 0,
};

test("the measured reset-credit payload parses to ids, statuses and instants", () => {
  expect(parseResetCredits(LISTED)).toEqual({
    available: 1,
    credits: [
      {
        id: "RateLimitResetCredit_aaa",
        status: "available",
        title: "Full reset",
        grantedAt: Date.parse("2026-09-22T20:29:32.601937Z"),
        expiresAt: Date.parse("2026-10-22T20:29:32.601937Z"),
      },
      {
        id: "RateLimitResetCredit_bbb",
        status: "redeemed",
        title: null,
        grantedAt: Date.parse("2026-06-12T00:00:00Z"),
        expiresAt: Date.parse("2026-07-12T00:00:00Z"),
      },
    ],
  });
});

test("available is counted from the rows, not trusted from available_count", () => {
  // A count the rows disagree with would let the console offer a reset no
  // credit id can back.
  expect(parseResetCredits({ ...LISTED, available_count: 7 })?.available).toBe(1);
});

test("an unreadable payload is nothing, and a malformed row is skipped", () => {
  expect(parseResetCredits(null)).toBeNull();
  expect(parseResetCredits({ available_count: 1 })).toBeNull();
  expect(parseResetCredits({ credits: [{ status: "available" }, { id: 3 }] })).toEqual({
    available: 0,
    credits: [],
  });
});

test("listing sends the bearer token and the account selector to the reset endpoint", async () => {
  const { client, seen } = stubHttp({ status: 200, body: LISTED });
  const listed = await openaiOAuth.resetCredits?.(
    { accessToken: "test-token-1" },
    { http: client, now: () => NOW },
    { accountId: "acct-1" },
  );

  expect(listed?.available).toBe(1);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.method).toBe("GET");
  expect(seen[0]?.url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
  expect(seen[0]?.headers).toContainEqual(["Authorization", "Bearer test-token-1"]);
  expect(seen[0]?.headers).toContainEqual(["chatgpt-account-id", "acct-1"]);
});

test("redeeming posts the named credit with the host's idempotency key", async () => {
  const { client, seen } = stubHttp({ status: 200, body: { code: "reset", windows_reset: 1 } });
  const redeemed = await openaiOAuth.redeemReset?.(
    { accessToken: "test-token-1" },
    { http: client, now: () => NOW },
    { accountId: "acct-1" },
    "RateLimitResetCredit_aaa",
    "req-1",
  );

  expect(redeemed).toEqual({ windowsReset: 1 });
  expect(seen[0]?.method).toBe("POST");
  expect(seen[0]?.url).toBe(
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
  );
  expect(JSON.parse(seen[0]?.body ?? "")).toEqual({
    credit_id: "RateLimitResetCredit_aaa",
    redeem_request_id: "req-1",
  });
  expect(seen[0]?.headers).toContainEqual(["Authorization", "Bearer test-token-1"]);
  expect(seen[0]?.headers).toContainEqual(["chatgpt-account-id", "acct-1"]);
});

test("a refused redeem names the status, never the body, and sorts token from credit", async () => {
  const cases: [number, string][] = [
    [401, "AUTH"],
    [409, "CONFLICT"],
    [404, "CONFLICT"],
    [429, "RATE_LIMIT"],
    [502, "UPSTREAM"],
  ];
  for (const [status, code] of cases) {
    const { client } = stubHttp({ status, body: { detail: "secret upstream text" } });
    const error = await openaiOAuth
      .redeemReset?.({ accessToken: "t" }, { http: client, now: () => NOW }, {}, "c", "r")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect(`${status}:${(error as GatewayError).code}`).toBe(`${status}:${code}`);
    expect((error as GatewayError).message).not.toContain("secret upstream text");
  }
});
