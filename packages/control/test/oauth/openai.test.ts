import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { HttpClient, HttpRequest } from "@omni/providers";
import { openaiOAuth } from "../../src/oauth/openai.ts";

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

const OPENAI_TOKEN_HEADERS = [
  ["Content-Type", "application/x-www-form-urlencoded"],
  ["originator", "codex_cli_rs"],
  ["Version", "0.144.1"],
  ["Openai-Beta", "responses=experimental"],
  ["X-Codex-Beta-Features", "responses_websockets"],
  ["Accept", "application/json"],
  ["User-Agent", "codex-cli/0.144.1 (Windows 10.0.26200; x64)"],
] as const;

test("builds an authorize url against the openai auth host", () => {
  const start = openaiOAuth.start({ redirectUri: "http://localhost:8787/oauth/callback" });
  const url = new URL(start.authorizeUrl);
  expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("scope")).toContain("openid");
  expect(url.searchParams.get("id_token_add_organizations")).toBe("true");
  expect(url.searchParams.get("codex_cli_simplified_flow")).toBe("true");
  expect(url.searchParams.get("originator")).toBe("codex_cli_rs");
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
