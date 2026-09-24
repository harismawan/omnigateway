import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { HttpClient, HttpRequest } from "@omni/providers";
import { anthropicProfile, parseResetGrants } from "@omni/providers";
import { anthropicOAuth } from "./builtins.ts";

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

/**
 * The `cedar_ember` block as the Claude CLI's own schema reads it (2.1.280).
 * Synthetic (two grants, `next_grant_id` pointing at the second); the live
 * shape is pinned separately below.
 */
const BLOCK = {
  eligible: true,
  at_limit: true,
  exhausted: ["five_hour"],
  next_grant_id: "grant_b",
  grants: [
    {
      id: "grant_a",
      label: "Launch week",
      resets_total: 1,
      resets_left: 1,
      starts_at: "2026-09-01T00:00:00Z",
      ends_at: "2026-09-30T00:00:00Z",
      clears: ["five_hour"],
      paused: false,
      usable_now: true,
    },
    {
      id: "grant_b",
      label: "",
      resets_total: 2,
      resets_left: 2,
      starts_at: null,
      ends_at: "2026-10-15T00:00:00Z",
      clears: ["five_hour", "seven_day"],
      paused: false,
      usable_now: true,
    },
    { id: "grant_c", resets_total: 1, resets_left: 0, usable_now: false },
  ],
};

test("only the grant the server would take now is available, counted by its uses", () => {
  // `grant_a` is usable, but claiming anything but `next_grant_id` is refused
  // as `not_next_grant`, so offering it would offer a guaranteed failure.
  expect(parseResetGrants(BLOCK)).toEqual({
    available: 2,
    credits: [
      {
        id: "grant_a-u1",
        status: "unavailable",
        title: "Launch week",
        grantedAt: Date.parse("2026-09-01T00:00:00Z"),
        expiresAt: Date.parse("2026-09-30T00:00:00Z"),
      },
      {
        id: "grant_b-u2",
        status: "available",
        title: null,
        grantedAt: null,
        expiresAt: Date.parse("2026-10-15T00:00:00Z"),
      },
      { id: "grant_c-u0", status: "used", title: null, grantedAt: null, expiresAt: null },
    ],
  });
});

test("an account not enrolled has an empty list; a malformed block is unreadable", () => {
  expect(parseResetGrants(null)).toEqual({ available: 0, credits: [] });
  expect(parseResetGrants("nope")).toBeNull();
  // Enrolled but no readable grants: "could not read", never "none left".
  expect(parseResetGrants({ eligible: true })).toBeNull();
  expect(parseResetGrants({ eligible: true, grants: "x" })).toBeNull();
  expect(parseResetGrants({ ...BLOCK, grants: [{ ...BLOCK.grants[1], paused: true }] })).toEqual(
    expect.objectContaining({ available: 0 }),
  );
  // A grant that needs the account at its limit is not offered below it.
  const needsLimit = { ...BLOCK.grants[1], use_requires_limit: true };
  expect(parseResetGrants({ ...BLOCK, at_limit: false, grants: [needsLimit] })?.available).toBe(0);
  expect(parseResetGrants({ ...BLOCK, at_limit: true, grants: [needsLimit] })?.available).toBe(2);
});

test("the block as measured live (Pro, 2026-09-24) reads as one spendable reset", () => {
  // Ids shortened; every other field verbatim from `?cedar_ember=1&skip_spend=1`.
  const live = {
    eligible: true,
    ineligible_reason: null,
    at_limit: false,
    exhausted: [],
    grants: [
      {
        id: "opus_launch_grant",
        label: "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
        resets_total: 1,
        resets_left: 1,
        starts_at: "2026-09-22T16:00:00+00:00",
        ends_at: "2026-10-22T16:00:00+00:00",
        clears: ["five_hour", "seven_day", "seven_day_overage_included"],
        paused: false,
        usable_now: true,
        use_requires_limit: false,
        percent_used: { five_hour: 0, seven_day: 7 },
        blocking: [],
        arm: null,
      },
    ],
    next_grant_id: "opus_launch_grant",
    weekly_resets_at: "2026-09-27T19:00:00+00:00",
    cooldown_until: null,
  };
  expect(parseResetGrants(live)).toEqual({
    available: 1,
    credits: [
      {
        id: "opus_launch_grant-u1",
        status: "available",
        title: "Claude Opus 5.5 launch: one usage-limit reset for Pro and Max",
        grantedAt: Date.parse("2026-09-22T16:00:00Z"),
        expiresAt: Date.parse("2026-10-22T16:00:00Z"),
      },
    ],
  });
  // The same grant already spent on another account: shown, not offered.
  const spent = { ...live.grants[0], resets_left: 0, usable_now: false };
  expect(parseResetGrants({ ...live, next_grant_id: null, grants: [spent] })).toEqual({
    available: 0,
    credits: [expect.objectContaining({ status: "used" })],
  });
});

test("listing reads the flagged usage call with the CLI's side-channel identity", async () => {
  const { client, seen } = stubHttp({ status: 200, body: { cedar_ember: BLOCK } });
  const listed = await anthropicOAuth.resetCredits?.(
    { accessToken: "test-token-1" },
    { http: client, now: () => NOW },
    {},
  );

  expect(listed?.available).toBe(2);
  const url = new URL(seen[0]?.url ?? "");
  expect(url.pathname).toBe("/api/oauth/usage");
  expect(url.searchParams.get("cedar_ember")).toBe("1");
  expect(url.searchParams.get("skip_spend")).toBe("1");
  expect(seen[0]?.headers).toContainEqual(["anthropic-beta", "oauth-2025-04-20"]);
  // The inference identity, not the usage probe's: any other User-Agent is
  // answered `ineligible_reason: "surface"`.
  const ua = seen[0]?.headers?.find(([k]) => k === "User-Agent")?.[1];
  expect(ua).toBe(anthropicProfile.headers.find(([k]) => k === "User-Agent")?.[1]);
});

test("a usage body with no cedar_ember block lists nothing rather than failing", async () => {
  const { client } = stubHttp({ status: 200, body: { five_hour: { utilization: 3 } } });
  const listed = await anthropicOAuth.resetCredits?.(
    { accessToken: "t" },
    { http: client, now: () => NOW },
    {},
  );
  expect(listed).toEqual({ available: 0, credits: [] });
});

test("redeeming reads the organization, then claims the named grant under it", async () => {
  const { client, seen } = stubHttp(
    { status: 200, body: { organization: { uuid: "org-123" }, account: { uuid: "acct" } } },
    { status: 200, body: { result: "reset", cleared: ["five_hour", "seven_day"], resets_left: 1 } },
  );
  const redeemed = await anthropicOAuth.redeemReset?.(
    { accessToken: "test-token-1" },
    { http: client, now: () => NOW },
    {},
    "grant_b-u2",
    "req-1",
  );

  expect(redeemed).toEqual({ windowsReset: 2 });
  expect(new URL(seen[0]?.url ?? "").pathname).toBe("/api/oauth/profile");
  expect(seen[1]?.method).toBe("POST");
  expect(seen[1]?.url).toBe(
    "https://api.anthropic.com/api/organizations/org-123/reset_rate_limits",
  );
  expect(JSON.parse(seen[1]?.body ?? "")).toEqual({
    program: "cedar_ember",
    grant_id: "grant_b",
    request_id: "req-1",
  });
  expect(seen[1]?.headers).toContainEqual(["Authorization", "Bearer test-token-1"]);
});

test("a 200 without result 'reset' is never reported as a spend", async () => {
  const cases: [unknown, string][] = [
    [{ result: "already_used" }, "CONFLICT"],
    [{ result: "not_limited" }, "CONFLICT"],
    [{ result: "cooldown", cooldown_until: "2026-09-25T00:00:00Z" }, "RATE_LIMIT"],
    [{ result: "unavailable" }, "UPSTREAM"],
    [{}, "UPSTREAM"],
  ];
  for (const [body, code] of cases) {
    const { client } = stubHttp(
      { status: 200, body: { organization: { uuid: "org-1" } } },
      { status: 200, body },
    );
    const error = await anthropicOAuth
      .redeemReset?.({ accessToken: "t" }, { http: client, now: () => NOW }, {}, "g-u1", "r")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GatewayError);
    expect(`${JSON.stringify(body)}:${(error as GatewayError).code}`).toBe(
      `${JSON.stringify(body)}:${code}`,
    );
  }
});

test("no usable organization, or a refused claim, fails before or without a spend", async () => {
  const noOrg = stubHttp({ status: 200, body: { organization: { uuid: "../x" } } });
  const refused = await anthropicOAuth
    .redeemReset?.({ accessToken: "t" }, { http: noOrg.client, now: () => NOW }, {}, "g-u1", "r")
    .catch((e: unknown) => e);
  expect((refused as GatewayError).code).toBe("UPSTREAM");
  // The malformed id never reached a URL.
  expect(noOrg.seen).toHaveLength(1);

  const denied = stubHttp(
    { status: 200, body: { organization: { uuid: "org-1" } } },
    { status: 403, body: { error: { message: "secret upstream text" } } },
  );
  const error = await anthropicOAuth
    .redeemReset?.({ accessToken: "t" }, { http: denied.client, now: () => NOW }, {}, "g-u1", "r")
    .catch((e: unknown) => e);
  expect((error as GatewayError).code).toBe("AUTH");
  expect((error as GatewayError).message).not.toContain("secret upstream text");
});

test("the built-in registry declares resets for exactly the providers that implement both steps", () => {
  // What `/api/catalog` marks and the console offers: pinned here so a flow
  // gaining or losing one half never silently changes the operator's controls.
  expect(anthropicOAuth.resetCredits).toBeFunction();
  expect(anthropicOAuth.redeemReset).toBeFunction();
});

test("each use of a multi-use grant has its own id, so a repeated submission spends nothing", async () => {
  // Two uses left: the offered id names the second-to-last use.
  const before = parseResetGrants(BLOCK)?.credits.find((c) => c.status === "available");
  expect(before?.id).toBe("grant_b-u2");
  // After one spend the same grant is offered under a new id...
  const after = parseResetGrants({
    ...BLOCK,
    grants: BLOCK.grants.map((g) => (g.id === "grant_b" ? { ...g, resets_left: 1 } : g)),
  })?.credits.find((c) => c.status === "available");
  expect(after?.id).toBe("grant_b-u1");
  // ...so the host's "is this id still offered" check refuses the stale one,
  // and the flow itself refuses an id that names no use before any request.
  const { client, seen } = stubHttp();
  const error = await anthropicOAuth
    .redeemReset?.({ accessToken: "t" }, { http: client, now: () => NOW }, {}, "grant_b", "r")
    .catch((e: unknown) => e);
  expect((error as GatewayError).code).toBe("CONFLICT");
  expect(seen).toHaveLength(0);
});
