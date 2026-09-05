import { expect, test } from "bun:test";
import type { HttpClient, HttpRequest } from "@omni/providers";
import { ANTIGRAVITY_CLIENT_ID } from "@omni/providers";
import { antigravityOAuth } from "./builtins.ts";

const NOW = 1_000_000;
const REDIRECT = "https://antigravity.google/oauth-callback";
/**
 * Imported rather than restated, which is a real weakening and is why the shape
 * assertions below exist.
 *
 * A literal here would be the stronger pin — it fails when the constant changes
 * — but it is also the string GitHub's push protection refuses, and the flow's
 * own file explains why the value is masked. What the value *is* was proven by a
 * live authorization against Google, recorded in the design spec; what these
 * tests hold is that whatever it is reaches the wire unmangled and is shaped
 * like a Google installed-app client id, which is what catches a broken unmask.
 */
const CLIENT_ID = ANTIGRAVITY_CLIENT_ID;

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const LOAD_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const ONBOARD_URL = "https://cloudcode-pa.googleapis.com/v1internal:onboardUser";
const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";

const pending = { verifier: "", challenge: "", state: "s", redirectUri: REDIRECT };

type Answer = { status: number; body: unknown };

/** Answers per URL, so a step's several calls can each be given their own reply. */
function stubHttp(
  answers: Record<string, Answer>,
): HttpClient & { calls: () => HttpRequest[]; to: (url: string) => HttpRequest | undefined } {
  const seen: HttpRequest[] = [];
  const client = (async (req: HttpRequest) => {
    seen.push(req);
    const answer = answers[req.url] ?? { status: 404, body: {} };
    return {
      status: answer.status,
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
      text: async () =>
        typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body),
    };
  }) as HttpClient & { calls: () => HttpRequest[]; to: (url: string) => HttpRequest | undefined };
  client.calls = () => seen;
  client.to = (url) => seen.find((req) => req.url === url);
  return client;
}

const OK_TOKEN: Answer = {
  status: 200,
  body: { access_token: "test-token-1", refresh_token: "test-token-2", expires_in: 3600 },
};
const OK_EMAIL: Answer = { status: 200, body: { email: "operator@example.test" } };
const OK_PROJECT: Answer = { status: 200, body: { cloudaicompanionProject: "projects/p-1" } };

function deps(http: HttpClient) {
  return { http, now: () => NOW };
}

const body = (req: HttpRequest | undefined) => new URLSearchParams(req?.body ?? "");

test("the masked client id unmasks to a Google installed-app client id", () => {
  // The check the literal used to provide. A broken mask table, a wrong key, or
  // an off-by-one in `unmask` all produce mojibake, which this refuses — and it
  // is the only thing standing between that and a connect flow that fails
  // against Google with an opaque `invalid_client`.
  expect(ANTIGRAVITY_CLIENT_ID).toMatch(/^\d{10,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com$/);
});

test("is registered as a pasteable pkce provider", () => {
  expect(antigravityOAuth.kind).toBe("pkce");
  expect(antigravityOAuth.supportsManualPaste).toBe(true);
  expect(antigravityOAuth.id).toBe("antigravity");
});

test("the authorize url asks Google for offline access", async () => {
  const start = await antigravityOAuth.start({ redirectUri: REDIRECT }, deps(stubHttp({})));
  const url = new URL(start.authorizeUrl);

  expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
  // Without these two Google issues no refresh token, and a second account
  // cannot be authorized on a browser already signed in to a first.
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("prompt")).toBe("consent");
  expect(start.pending.state.length).toBeGreaterThan(0);
});

test("a code challenge reaches the authorize url, and no openid scope does", async () => {
  // The challenge is what the hosted callback requires — measured both ways in
  // the flow's header — so dropping it back to the loopback-era shape fails here
  // rather than at an operator's authorize step. `openid` stays off: it was
  // measured to change nothing either way, and adding it re-consents everyone.
  const start = await antigravityOAuth.start({ redirectUri: REDIRECT }, deps(stubHttp({})));
  const url = new URL(start.authorizeUrl);

  expect(url.searchParams.get("scope")?.split(" ")).toEqual([
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ]);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBe(start.pending.challenge);
  expect(start.pending.challenge.length).toBeGreaterThan(0);
  expect(start.pending.verifier.length).toBeGreaterThan(0);
});

test("the exchange sends the verifier the authorize url committed to", async () => {
  // The half a challenge alone cannot catch: a challenge on the authorize call
  // with no matching `code_verifier` on the exchange is `invalid_grant`, which
  // reads as an expired code rather than as a flow that never sends one.
  const start = await antigravityOAuth.start({ redirectUri: REDIRECT }, deps(stubHttp({})));
  const http = stubHttp({
    [TOKEN_URL]: OK_TOKEN,
    [USERINFO_URL]: OK_EMAIL,
    [LOAD_URL]: OK_PROJECT,
  });

  await antigravityOAuth.exchange(
    { code: `abc#${start.pending.state}`, pending: start.pending },
    deps(http),
  );

  expect(body(http.to(TOKEN_URL)).get("code_verifier")).toBe(start.pending.verifier);
});

test("exchange trades the code, reads the email, and discovers the project", async () => {
  const http = stubHttp({
    [TOKEN_URL]: OK_TOKEN,
    [USERINFO_URL]: OK_EMAIL,
    [LOAD_URL]: OK_PROJECT,
  });

  const result = await antigravityOAuth.exchange({ code: "abc#s", pending }, deps(http));

  const token = body(http.to(TOKEN_URL));
  expect(token.get("grant_type")).toBe("authorization_code");
  expect(token.get("code")).toBe("abc");
  expect(token.get("client_id")).toBe(CLIENT_ID);
  // Google's installed-app client sends its published secret; omitting it is a
  // 401 `invalid_client` rather than a scope problem, which reads as anything
  // but a missing form field.
  expect(token.get("client_secret")?.startsWith("GOCSPX-")).toBe(true);
  expect(token.get("redirect_uri")).toBe(REDIRECT);

  expect(result.secrets.accessToken).toBe("test-token-1");
  expect(result.secrets.refreshToken).toBe("test-token-2");
  expect(result.expiresAt).toBe(NOW + 3_600_000);
  expect(result.accountEmail).toBe("operator@example.test");
  // The whole reason the bootstrap exists: every inference request carries it.
  expect(result.providerData.projectId).toBe("projects/p-1");

  // No onboarding for an account that already has a project.
  expect(http.to(ONBOARD_URL)).toBeUndefined();
});

test("a state that does not match what was minted is refused", async () => {
  const http = stubHttp({ [TOKEN_URL]: OK_TOKEN });
  await expect(
    antigravityOAuth.exchange({ code: "abc#wrong", pending }, deps(http)),
  ).rejects.toThrow(/state mismatch/);
  expect(http.calls()).toHaveLength(0);
});

test("an account with no project is onboarded, and the project read from that answer", async () => {
  const http = stubHttp({
    [TOKEN_URL]: OK_TOKEN,
    [USERINFO_URL]: OK_EMAIL,
    [LOAD_URL]: {
      status: 200,
      body: { allowedTiers: [{ id: "free-tier", isDefault: true }] },
    },
    [ONBOARD_URL]: {
      status: 200,
      body: { done: true, response: { cloudaicompanionProject: { id: "projects/new" } } },
    },
  });

  const result = await antigravityOAuth.exchange({ code: "abc#s", pending }, deps(http));

  // The tier `loadCodeAssist` named, not the fallback: onboarding an account
  // onto the wrong tier is the difference between a working plan and a refusal.
  expect(JSON.parse(http.to(ONBOARD_URL)?.body ?? "{}").tier_id).toBe("free-tier");
  // `cloudaicompanionProject` came back as an object here and as a string above.
  expect(result.providerData.projectId).toBe("projects/new");
});

test("a bootstrap that finds nothing still yields a usable credential", async () => {
  const http = stubHttp({
    [TOKEN_URL]: OK_TOKEN,
    [USERINFO_URL]: OK_EMAIL,
    [LOAD_URL]: { status: 500, body: {} },
    [ONBOARD_URL]: { status: 500, body: {} },
  });

  const result = await antigravityOAuth.exchange({ code: "abc#s", pending }, deps(http));

  // The connect succeeds — the token is real and refreshable — and the codec is
  // what refuses inference, naming the reconnect that fixes it. Failing here
  // instead would throw away a working refresh token over a slow provisioning.
  expect(result.secrets.accessToken).toBe("test-token-1");
  expect(result.providerData.projectId).toBe("");
});

test("refresh keeps the refresh token Google did not resend, and the project", async () => {
  const http = stubHttp({
    [TOKEN_URL]: { status: 200, body: { access_token: "test-token-3", expires_in: 3600 } },
  });

  const result = await antigravityOAuth.refresh("test-token-2", deps(http), {
    projectId: "projects/p-1",
    tier: "free-tier",
  });

  expect(body(http.to(TOKEN_URL)).get("grant_type")).toBe("refresh_token");
  expect(result.secrets.accessToken).toBe("test-token-3");
  // Google omits `refresh_token` from every refresh response. Reading that as
  // null destroys the credential on its first refresh.
  expect(result.secrets.refreshToken).toBe("test-token-2");
  // Carried forward rather than re-read: a refresh that dropped it would break
  // every later request with no failure of its own to explain why.
  expect(result.providerData.projectId).toBe("projects/p-1");
  // One call. The bootstrap does not run again.
  expect(http.calls()).toHaveLength(1);
});

// --- Quota --------------------------------------------------------------------

const SUMMARY = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        { bucketId: "gemini_5h", displayName: "5 hour", remainingFraction: 0.4 },
        { bucketId: "gemini_weekly", displayName: "Weekly", remainingFraction: 0.75 },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [{ bucketId: "claude_weekly", displayName: "Weekly", remainingFraction: 0.1 }],
    },
  ],
};

test("the quota probe reads the Gemini family's two windows", async () => {
  const http = stubHttp({ [QUOTA_URL]: { status: 200, body: SUMMARY } });

  const report = await antigravityOAuth.usage?.({ accessToken: "tok" }, deps(http), {
    projectId: "projects/p-1",
  });

  expect(JSON.parse(http.to(QUOTA_URL)?.body ?? "{}")).toEqual({ project: "projects/p-1" });
  expect(report?.windows).toEqual([
    { windowType: "fiveHour", used: 60, limit: 100, resetsAt: null, windowMs: null },
    { windowType: "weekly", used: 25, limit: 100, resetsAt: null, windowMs: null },
  ]);
});

test("the Claude and GPT family is not stored, because nothing can route to it", async () => {
  const http = stubHttp({ [QUOTA_URL]: { status: 200, body: SUMMARY } });
  const report = await antigravityOAuth.usage?.({ accessToken: "tok" }, deps(http), {
    projectId: "projects/p-1",
  });
  // Its weekly bucket is at 90% used and would win the tightest-window rule if
  // it were stored — and `quota_windows` holds one row per window, so storing
  // it means overwriting the family the catalog actually serves.
  expect(report?.windows.some((w) => w.used === 90)).toBe(false);
});

test("a bucket whose window cannot be named is dropped, not guessed", async () => {
  const http = stubHttp({
    [QUOTA_URL]: {
      status: 200,
      body: {
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              { bucketId: "gemini_fortnightly", displayName: "Fortnightly", remainingFraction: 0 },
              { bucketId: "gemini_weekly", displayName: "Weekly", remainingFraction: 0.5 },
            ],
          },
        ],
      },
    },
  });

  const report = await antigravityOAuth.usage?.({ accessToken: "tok" }, deps(http), {
    projectId: "projects/p-1",
  });

  // The unnamed bucket reports 0% remaining. Filing it under either window would
  // park the account as spent; dropping it reads as unknown, which is what a
  // renamed bucket upstream should look like.
  expect(report?.windows).toEqual([
    { windowType: "weekly", used: 50, limit: 100, resetsAt: null, windowMs: null },
  ]);
});

test("a disabled bucket and a bucket with no fraction are both unknown", async () => {
  const http = stubHttp({
    [QUOTA_URL]: {
      status: 200,
      body: {
        // The nested envelope, which is the other shape this undocumented RPC
        // has been seen to use.
        quotaSummary: {
          groups: [
            {
              displayName: "Gemini Models",
              buckets: [
                { bucketId: "5h", displayName: "5 hour", remainingFraction: 0.9, disabled: true },
                { bucketId: "weekly", displayName: "Weekly" },
              ],
            },
          ],
        },
      },
    },
  });

  const report = await antigravityOAuth.usage?.({ accessToken: "tok" }, deps(http), {
    projectId: "projects/p-1",
  });

  // Nothing readable at all, so no report — never a report of zeroes, which
  // reads as an account with everything left.
  expect(report).toBeNull();
});

test("no project means no probe, rather than a call that cannot succeed", async () => {
  const http = stubHttp({ [QUOTA_URL]: { status: 200, body: SUMMARY } });
  const report = await antigravityOAuth.usage?.({ accessToken: "tok" }, deps(http), {});
  expect(report).toBeNull();
  expect(http.calls()).toHaveLength(0);
});

test("a refused probe reports nothing rather than judging the credential", async () => {
  const http = stubHttp({ [QUOTA_URL]: { status: 401, body: {} } });
  const report = await antigravityOAuth.usage?.({ accessToken: "tok" }, deps(http), {
    projectId: "projects/p-1",
  });
  expect(report).toBeNull();
});
