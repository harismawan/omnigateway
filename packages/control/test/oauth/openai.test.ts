import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { HttpClient, HttpRequest } from "@omni/providers";
import { openaiOAuth } from "./builtins.ts";

const NOW = 1_000_000;

function idToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(payload)}.signature`;
}

/** Captures the request so tests can assert on the identity headers. */
function stubHttp(status: number, body: unknown): HttpClient & { last: () => HttpRequest } {
  let seen: HttpRequest | null = null;
  const client = (async (req: HttpRequest) => {
    seen = req;
    return {
      status,
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
      text: async () => JSON.stringify(body),
    };
  }) as HttpClient & { last: () => HttpRequest };
  client.last = () => {
    if (seen === null) throw new Error("stubHttp was never called");
    return seen;
  };
  return client;
}

const pending = { verifier: "v", challenge: "c", state: "s", redirectUri: "http://localhost/cb" };

// The token requests wear the shared OpenAI profile, so they move with it: the
// 0.163.0 TUI identity, and the originator header after the protocol headers.
const OPENAI_TOKEN_HEADERS = [
  ["version", "0.163.0"],
  ["x-codex-beta-features", "remote_compaction_v2"],
  ["Accept", "application/json"],
  ["Content-Type", "application/x-www-form-urlencoded"],
  ["originator", "codex-tui"],
  [
    "user-agent",
    "codex-tui/0.163.0 (Windows 10.0.26200; x86_64) WindowsTerminal (codex-tui; 0.163.0)",
  ],
] as const;

/** OpenAI's endpoints are compiled in, so `start` must not reach the network. */
const offline: HttpClient = () => {
  throw new Error("start reached transport");
};

test("builds an authorize url against the openai auth host", async () => {
  const start = await openaiOAuth.start(
    { redirectUri: "http://localhost:8787/oauth/callback" },
    { http: offline, now: () => NOW },
  );
  const url = new URL(start.authorizeUrl);
  expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("scope")).toContain("openid");
  expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
  expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
  // The TUI's login runs in its app-server after `initialize` has set the
  // process originator, so the authorize URL names `codex-tui` too.
  expect(url.searchParams.get("originator")).toBe("codex-tui");
  expect(url.searchParams.get("prompt")).toBe("login");
});

test("sends exchange with the Codex CLI header and form field order", async () => {
  const http = stubHttp(200, { access_token: "test-token-1", expires_in: 60 });
  await openaiOAuth.exchange({ code: "auth-code", pending }, { http, now: () => NOW });

  const sent = http.last();
  expect(sent.headers).toEqual(OPENAI_TOKEN_HEADERS);
  expect(sent.body).toBe(
    "grant_type=authorization_code&code=auth-code&redirect_uri=http%3A%2F%2Flocalhost%2Fcb&code_verifier=v&client_id=app_EMoamEEZ73f0CkXaXp7hrann",
  );
});

test("sends refresh with the Codex CLI header and form field order", async () => {
  const http = stubHttp(200, { access_token: "test-token-3", expires_in: 60 });
  await openaiOAuth.refresh("test-token-2", { http, now: () => NOW }, {});

  const sent = http.last();
  expect(sent.headers).toEqual(OPENAI_TOKEN_HEADERS);
  expect(sent.body).toBe(
    "grant_type=refresh_token&refresh_token=test-token-2&scope=openid+profile+email+offline_access&client_id=app_EMoamEEZ73f0CkXaXp7hrann",
  );
});

test("extracts the account id from the id token claims", async () => {
  const result = await openaiOAuth.exchange(
    { code: "auth-code", pending },
    {
      http: stubHttp(200, {
        access_token: "test-token-1",
        refresh_token: "test-token-2",
        expires_in: 3600,
        id_token: idToken({
          email: "user@example.com",
          "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" },
        }),
      }),
      now: () => NOW,
    },
  );
  expect(result.providerData.accountId).toBe("acct_123");
  expect(result.accountEmail).toBe("user@example.com");
  expect(result.expiresAt).toBe(NOW + 3_600_000);
});

test("tolerates a token response with no id token", async () => {
  const result = await openaiOAuth.exchange(
    { code: "auth-code", pending },
    { http: stubHttp(200, { access_token: "test-token-1", expires_in: 60 }), now: () => NOW },
  );
  expect(result.providerData.accountId).toBeNull();
  expect(result.accountEmail).toBeNull();
});

test("tolerates a malformed id token rather than failing the flow", async () => {
  const result = await openaiOAuth.exchange(
    { code: "auth-code", pending },
    {
      http: stubHttp(200, { access_token: "test-token-1", id_token: "not.a.jwt" }),
      now: () => NOW,
    },
  );
  expect(result.providerData.accountId).toBeNull();
});

test("discards claims from a truncated id token", async () => {
  const payload = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } }),
  ).toString("base64url");
  const result = await openaiOAuth.exchange(
    { code: "auth-code", pending },
    {
      http: stubHttp(200, { access_token: "test-token-1", id_token: `header.${payload}` }),
      now: () => NOW,
    },
  );
  expect(result.providerData.accountId).toBeNull();
});

test("discards claims from an id token with an invalid base64url payload", async () => {
  const result = await openaiOAuth.exchange(
    { code: "auth-code", pending },
    {
      http: stubHttp(200, { access_token: "test-token-1", id_token: "header.@@@.signature" }),
      now: () => NOW,
    },
  );
  expect(result.providerData.accountId).toBeNull();
});

test.each(["", "   "])("discards a blank account claim", async (accountId) => {
  const result = await openaiOAuth.exchange(
    { code: "auth-code", pending },
    {
      http: stubHttp(200, {
        access_token: "test-token-1",
        id_token: idToken({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
      }),
      now: () => NOW,
    },
  );
  expect(result.providerData.accountId).toBeNull();
});

test("discards non-string account claims", async () => {
  const result = await openaiOAuth.exchange(
    { code: "auth-code", pending },
    {
      http: stubHttp(200, {
        access_token: "test-token-1",
        id_token: idToken({
          email: 42,
          "https://api.openai.com/auth": { chatgpt_account_id: { value: "acct_123" } },
        }),
      }),
      now: () => NOW,
    },
  );
  expect(result.accountEmail).toBeNull();
  expect(result.providerData.accountId).toBeNull();
});

test("maps a rejected exchange to AUTH", async () => {
  expect(
    openaiOAuth.exchange(
      { code: "bad", pending },
      { http: stubHttp(400, { error: "invalid_grant" }), now: () => NOW },
    ),
  ).rejects.toThrow(GatewayError);
});

async function refreshCode(status: number, body: unknown): Promise<string> {
  try {
    await openaiOAuth.refresh("test-token-2", { http: stubHttp(status, body), now: () => NOW }, {});
  } catch (e) {
    return (e as GatewayError).code;
  }
  throw new Error("expected throw");
}

test("classifies a token endpoint 5xx as transient, not as a repudiation", async () => {
  // A provider having a bad minute must not disable a healthy credential:
  // createRefresher disables only on AUTH.
  expect(await refreshCode(500, { error: "internal_error" })).toBe("UPSTREAM");
  expect(await refreshCode(503, {})).toBe("UPSTREAM");
  expect(await refreshCode(400, { error: "invalid_grant" })).toBe("AUTH");
});

test("classifies a token endpoint 429 as rate limited, not as a repudiation", async () => {
  expect(await refreshCode(429, { error: "rate_limited" })).toBe("RATE_LIMIT");
});

test("refresh preserves the account id from the new id token", async () => {
  const result = await openaiOAuth.refresh(
    "test-token-2",
    {
      http: stubHttp(200, {
        access_token: "test-token-3",
        expires_in: 60,
        id_token: idToken({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } }),
      }),
      now: () => NOW,
    },
    {},
  );
  expect(result.secrets.accessToken).toBe("test-token-3");
  expect(result.secrets.refreshToken).toBe("test-token-2");
  expect(result.providerData.accountId).toBe("acct_123");
});

test("refresh keeps the prior account id when no id token is returned", async () => {
  const result = await openaiOAuth.refresh(
    "test-token-2",
    { http: stubHttp(200, { access_token: "test-token-3", expires_in: 60 }), now: () => NOW },
    { accountId: "acct_123" },
  );
  expect(result.providerData.accountId).toBe("acct_123");
});

/**
 * The per-credential secret the Codex fingerprint keys its ids with, and the
 * installation id it reports. Both are minted at connect, stored beside the
 * account id, and must survive every refresh — or every conversation's ids and
 * the "machine" the credential claims to be would move at each token rotation.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SALT = /^[0-9a-f]{64}$/;

test("connect mints a random installation id and id salt per credential", async () => {
  const exchange = () =>
    openaiOAuth.exchange(
      { code: "auth-code", pending },
      { http: stubHttp(200, { access_token: "test-token-1", expires_in: 60 }), now: () => NOW },
    );
  const one = await exchange();
  const two = await exchange();
  expect(one.providerData.installationId).toMatch(UUID_V4);
  expect(one.providerData.idSalt).toMatch(SALT);
  expect(two.providerData.installationId).not.toBe(one.providerData.installationId);
  expect(two.providerData.idSalt).not.toBe(one.providerData.idSalt);
});

test("refresh keeps the stored installation id and salt", async () => {
  const stored = {
    accountId: "acct_123",
    installationId: "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
    idSalt: "ab".repeat(32),
  };
  const result = await openaiOAuth.refresh(
    "test-token-2",
    { http: stubHttp(200, { access_token: "test-token-3", expires_in: 60 }), now: () => NOW },
    stored,
  );
  expect(result.providerData).toEqual(stored);
});

test("refresh backfills a credential connected before either value existed", async () => {
  // The refresher merges what this returns over the stored providerData, so a
  // credential gains both on its next refresh.
  const result = await openaiOAuth.refresh(
    "test-token-2",
    { http: stubHttp(200, { access_token: "test-token-3", expires_in: 60 }), now: () => NOW },
    { accountId: "acct_123" },
  );
  expect(result.providerData.installationId).toMatch(UUID_V4);
  expect(result.providerData.idSalt).toMatch(SALT);
});

test("refresh replaces a malformed stored value rather than keeping it", async () => {
  for (const bad of [
    { installationId: "not-a-uuid", idSalt: "short" },
    { installationId: 42, idSalt: null },
  ]) {
    const result = await openaiOAuth.refresh(
      "test-token-2",
      { http: stubHttp(200, { access_token: "test-token-3", expires_in: 60 }), now: () => NOW },
      { accountId: "acct_123", ...bad },
    );
    expect(result.providerData.installationId).toMatch(UUID_V4);
    expect(result.providerData.idSalt).toMatch(SALT);
  }
});

test.each(["", "   "])("refresh discards a blank prior account id", async (accountId) => {
  const result = await openaiOAuth.refresh(
    "test-token-2",
    { http: stubHttp(200, { access_token: "test-token-3", expires_in: 60 }), now: () => NOW },
    { accountId },
  );
  expect(result.providerData.accountId).toBeNull();
});

test("discards a non-string refresh token", async () => {
  const result = await openaiOAuth.exchange(
    { code: "auth-code", pending },
    {
      http: stubHttp(200, { access_token: "test-token-1", refresh_token: 42 }),
      now: () => NOW,
    },
  );
  expect(result.secrets.refreshToken).toBeNull();
});

test("discards a non-string id token", async () => {
  const result = await openaiOAuth.exchange(
    { code: "auth-code", pending },
    {
      http: stubHttp(200, { access_token: "test-token-1", id_token: { unexpected: true } }),
      now: () => NOW,
    },
  );
  expect(result.secrets.idToken).toBeNull();
});
