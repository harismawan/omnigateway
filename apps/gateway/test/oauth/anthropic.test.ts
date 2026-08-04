import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { type HttpClient, type HttpRequest, stainlessHost } from "@omni/providers";
import { anthropicOAuth } from "../../src/oauth/anthropic.ts";

const NOW = 1_000_000;

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

test("builds an authorize url with pkce and state", () => {
  const start = anthropicOAuth.start({ redirectUri: "http://localhost:8787/oauth/callback" });
  const url = new URL(start.authorizeUrl);
  expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBe(start.pending.challenge);
  expect(url.searchParams.get("state")).toBe(start.pending.state);
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("redirect_uri")).toBe(
    "https://platform.claude.com/oauth/code/callback",
  );
  expect(start.pending.redirectUri).toBe("https://platform.claude.com/oauth/code/callback");
});

test("declares that it supports the manual paste flow", () => {
  expect(anthropicOAuth.kind).toBe("pkce");
  expect(anthropicOAuth.supportsManualPaste).toBe(true);
});

const ANTHROPIC_TOKEN_HEADERS = [
  ["Accept", "application/json"],
  ["Content-Type", "application/json"],
  ["User-Agent", "claude-cli/2.1.219 (external, cli)"],
  ["X-Stainless-Arch", stainlessHost(process.platform, process.arch).arch],
  ["X-Stainless-Lang", "js"],
  ["X-Stainless-OS", stainlessHost(process.platform, process.arch).os],
  ["X-Stainless-Package-Version", "0.94.0"],
  ["X-Stainless-Retry-Count", "0"],
  ["X-Stainless-Runtime", "node"],
  ["X-Stainless-Runtime-Version", "v26.3.0"],
  ["anthropic-dangerous-direct-browser-access", "true"],
  ["x-app", "cli"],
] as const;

test("sends exchange with the Anthropic CLI header and JSON field order", async () => {
  const http = stubHttp(200, { access_token: "test-token-1", expires_in: 60 });
  await anthropicOAuth.exchange(
    { code: "auth-code", pending: { verifier: "v", challenge: "c", state: "s", redirectUri: "r" } },
    { http, now: () => NOW },
  );

  const sent = http.last();
  expect(sent.url).toBe("https://api.anthropic.com/v1/oauth/token");
  expect(sent.headers).toEqual(ANTHROPIC_TOKEN_HEADERS);
  expect(sent.body).toBe(
    '{"grant_type":"authorization_code","code":"auth-code","redirect_uri":"r","code_verifier":"v","state":"s","client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}',
  );
});

test("sends refresh with the Anthropic CLI header and JSON field order", async () => {
  const http = stubHttp(200, { access_token: "test-token-3", expires_in: 60 });
  await anthropicOAuth.refresh("test-token-2", { http, now: () => NOW }, {});

  const sent = http.last();
  expect(sent.headers).toEqual(ANTHROPIC_TOKEN_HEADERS);
  expect(sent.body).toBe(
    '{"grant_type":"refresh_token","refresh_token":"test-token-2","client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}',
  );
});

test("exchanges a code for tokens", async () => {
  const result = await anthropicOAuth.exchange(
    { code: "auth-code", pending: { verifier: "v", challenge: "c", state: "s", redirectUri: "r" } },
    {
      http: stubHttp(200, {
        access_token: "test-token-1",
        refresh_token: "test-token-2",
        expires_in: 3600,
        account: { email_address: "user@example.com" },
      }),
      now: () => NOW,
    },
  );
  expect(result.secrets.accessToken).toBe("test-token-1");
  expect(result.secrets.refreshToken).toBe("test-token-2");
  expect(result.expiresAt).toBe(NOW + 3_600_000);
  expect(result.accountEmail).toBe("user@example.com");
});

test("splits a code#state paste and validates the state", async () => {
  const pending = { verifier: "v", challenge: "c", state: "the-state", redirectUri: "r" };
  const result = await anthropicOAuth.exchange(
    { code: "auth-code#the-state", pending },
    { http: stubHttp(200, { access_token: "test-token-1", expires_in: 60 }), now: () => NOW },
  );
  expect(result.secrets.accessToken).toBe("test-token-1");
});

test("rejects a pasted code whose state does not match", async () => {
  const pending = { verifier: "v", challenge: "c", state: "the-state", redirectUri: "r" };
  expect(
    anthropicOAuth.exchange(
      { code: "auth-code#wrong-state", pending },
      { http: stubHttp(200, { access_token: "test-token-1" }), now: () => NOW },
    ),
  ).rejects.toThrow(GatewayError);
});

test("maps a token endpoint failure to an AUTH error without echoing the body", async () => {
  try {
    await anthropicOAuth.exchange(
      { code: "c", pending: { verifier: "v", challenge: "c", state: "s", redirectUri: "r" } },
      {
        http: stubHttp(400, { error: "invalid_grant", secret_field: "test-token-9" }),
        now: () => NOW,
      },
    );
    throw new Error("expected throw");
  } catch (e) {
    expect((e as GatewayError).code).toBe("AUTH");
    expect((e as GatewayError).message).toContain("invalid_grant");
    expect((e as GatewayError).message).not.toContain("test-token-9");
  }
});

test("refreshes an access token and keeps the old refresh token when none is returned", async () => {
  const result = await anthropicOAuth.refresh(
    "test-token-2",
    { http: stubHttp(200, { access_token: "test-token-3", expires_in: 60 }), now: () => NOW },
    {},
  );
  expect(result.secrets.accessToken).toBe("test-token-3");
  expect(result.secrets.refreshToken).toBe("test-token-2");
  expect(result.expiresAt).toBe(NOW + 60_000);
});

test("rotates the refresh token when the provider returns a new one", async () => {
  const result = await anthropicOAuth.refresh(
    "test-token-2",
    {
      http: stubHttp(200, {
        access_token: "test-token-3",
        refresh_token: "test-token-4",
        expires_in: 60,
      }),
      now: () => NOW,
    },
    {},
  );
  expect(result.secrets.refreshToken).toBe("test-token-4");
});

async function refreshCode(status: number, body: unknown): Promise<string> {
  try {
    await anthropicOAuth.refresh(
      "test-token-2",
      { http: stubHttp(status, body), now: () => NOW },
      {},
    );
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

test("surfaces a rejected refresh as AUTH so the credential is disabled", async () => {
  expect(
    anthropicOAuth.refresh(
      "test-token-2",
      { http: stubHttp(400, { error: "invalid_grant" }), now: () => NOW },
      {},
    ),
  ).rejects.toThrow(GatewayError);
});
