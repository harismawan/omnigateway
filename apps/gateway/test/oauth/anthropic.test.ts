import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { HttpClient, HttpRequest } from "@omni/providers";
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
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8787/oauth/callback");
});

test("declares that it supports the manual paste flow", () => {
  expect(anthropicOAuth.kind).toBe("pkce");
  expect(anthropicOAuth.supportsManualPaste).toBe(true);
});

test("the token call carries the same client identity as inference", async () => {
  const http = stubHttp(200, { access_token: "test-token-1", expires_in: 60 });
  await anthropicOAuth.exchange(
    { code: "auth-code", pending: { verifier: "v", challenge: "c", state: "s", redirectUri: "r" } },
    { http, now: () => NOW },
  );

  const sent = new Map(http.last().headers);
  expect(sent.get("User-Agent")).toMatch(/^claude-cli\//);
  expect(sent.get("X-Stainless-Lang")).toBe("js");
  // Authenticating as one client and inferring as another is a louder signal
  // than either alone, so the token endpoint sees the same profile.
  expect(sent.get("x-app")).toBe("cli");
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

test("surfaces a rejected refresh as AUTH so the credential is disabled", async () => {
  expect(
    anthropicOAuth.refresh(
      "test-token-2",
      { http: stubHttp(400, { error: "invalid_grant" }), now: () => NOW },
      {},
    ),
  ).rejects.toThrow(GatewayError);
});
