import { expect, test } from "bun:test";
import { hostname } from "node:os";
import { GatewayError } from "@omni/ir";
import type { HttpClient, HttpRequest } from "@omni/providers";
import { grokOAuth } from "./builtins.ts";

const NOW = 1_000_000;
const DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const AUTHORIZE_URL = "https://auth.x.ai/oauth2/auth";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const SCOPES =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write";

const pending = {
  verifier: "v",
  challenge: "c",
  state: "s",
  redirectUri: "http://127.0.0.1:56121/callback",
};

type Answer = { status: number; body: unknown };

function response(answer: Answer) {
  return {
    status: answer.status,
    headers: new Headers({ "content-type": "application/json" }),
    body: null,
    text: async () => (typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)),
  };
}

/**
 * Answers discovery and the token endpoint separately, since every grok flow
 * makes both calls. `token()` is the request the assertions care about.
 */
function stubHttp(
  token: Answer,
  discovery: Answer = {
    status: 200,
    body: { authorization_endpoint: AUTHORIZE_URL, token_endpoint: TOKEN_URL },
  },
): HttpClient & { token: () => HttpRequest; calls: () => HttpRequest[] } {
  const seen: HttpRequest[] = [];
  const client = (async (req: HttpRequest) => {
    seen.push(req);
    return response(req.url === DISCOVERY_URL ? discovery : token);
  }) as HttpClient & { token: () => HttpRequest; calls: () => HttpRequest[] };
  client.token = () => {
    const sent = seen.find((req) => req.url !== DISCOVERY_URL);
    if (sent === undefined) throw new Error("the token endpoint was never called");
    return sent;
  };
  client.calls = () => seen;
  return client;
}

const OK_TOKEN: Answer = {
  status: 200,
  body: { access_token: "test-token-1", refresh_token: "test-token-2", expires_in: 3600 },
};

function deps(http: HttpClient) {
  return { http, now: () => NOW };
}

test("is registered as a pasteable pkce provider", () => {
  expect(grokOAuth.kind).toBe("pkce");
  expect(grokOAuth.supportsManualPaste).toBe(true);
  // Not `OAUTH_PROVIDERS.grok === grokOAuth`: `builtins.ts` defines the second
  // *as* the first, so that comparison became `x === x` when the flows moved.
  // `id` is what the registry keys on and what `builtins.ts` does not assert.
  expect(grokOAuth.id).toBe("grok");
});

test("reads no usage, so a grok account is unknown rather than unlimited", () => {
  expect(grokOAuth.usage).toBeUndefined();
});

test("builds an authorize url on the discovered endpoint", async () => {
  const http = stubHttp(OK_TOKEN);
  const start = await grokOAuth.start({ redirectUri: pending.redirectUri }, deps(http));
  const url = new URL(start.authorizeUrl);

  expect(url.origin + url.pathname).toBe(AUTHORIZE_URL);
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(url.searchParams.get("redirect_uri")).toBe(pending.redirectUri);
  expect(url.searchParams.get("scope")).toBe(SCOPES);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBe(start.pending.challenge);
  expect(url.searchParams.get("state")).toBe(start.pending.state);
  expect(url.searchParams.get("nonce")).not.toBeNull();
  expect(start.pending.redirectUri).toBe(pending.redirectUri);
});

test("identifies as xAI's own build client and never as hermes-agent", async () => {
  const start = await grokOAuth.start(
    { redirectUri: pending.redirectUri },
    deps(stubHttp(OK_TOKEN)),
  );
  const url = new URL(start.authorizeUrl);
  expect(url.searchParams.get("referrer")).toBe("grok-build");
  // `plan=generic` belongs to a different third-party product: sending it would
  // identify this gateway as that product.
  expect(url.searchParams.has("plan")).toBe(false);
});

test("derives the challenge from the verifier it kept", async () => {
  const start = await grokOAuth.start(
    { redirectUri: pending.redirectUri },
    deps(stubHttp(OK_TOKEN)),
  );
  expect(start.pending.verifier).toHaveLength(43);
  expect(start.pending.challenge).toBe(Bun.SHA256.hash(start.pending.verifier, "base64url"));
});

test("exchanges a code with a form-encoded body and no client secret", async () => {
  const http = stubHttp(OK_TOKEN);
  await grokOAuth.exchange({ code: "auth-code", pending }, deps(http));

  const sent = http.token();
  expect(sent.url).toBe(TOKEN_URL);
  expect(sent.method).toBe("POST");
  expect(sent.headers).toContainEqual(["Content-Type", "application/x-www-form-urlencoded"]);
  expect(sent.body).toBe(
    "grant_type=authorization_code&code=auth-code&redirect_uri=http%3A%2F%2F127.0.0.1%3A56121%2Fcallback&client_id=b1a00492-073a-47ea-816f-4c329264a828&code_verifier=v",
  );
  expect(sent.body).not.toContain("client_secret");
});

test("presents the grok client identity to the token endpoint", async () => {
  const http = stubHttp(OK_TOKEN);
  await grokOAuth.exchange({ code: "auth-code", pending }, deps(http));

  const sent = http.token();
  expect(sent.headers).toContainEqual(["x-grok-client-identifier", "grok-shell"]);
  expect(sent.headers).toContainEqual(["Accept", "application/json"]);
});

test("unpicks a pasted callback and refuses a forged state", async () => {
  const http = stubHttp(OK_TOKEN);
  await grokOAuth.exchange({ code: "auth-code#s", pending }, deps(http));
  expect(http.token().body).toContain("code=auth-code&");

  expect(
    grokOAuth.exchange({ code: "auth-code#forged", pending }, deps(stubHttp(OK_TOKEN))),
  ).rejects.toThrow(GatewayError);
});

test("mints a synthetic agent id at connect time", async () => {
  const result = await grokOAuth.exchange({ code: "auth-code", pending }, deps(stubHttp(OK_TOKEN)));
  const agentId = result.providerData.agentId;

  // Synthetic, not the machine's own name: this id goes upstream on every
  // request, and a hostname is routinely the operator's name or an asset tag.
  expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
  expect(agentId).not.toBe(hostname());
  expect(result.secrets.accessToken).toBe("test-token-1");
  expect(result.secrets.refreshToken).toBe("test-token-2");
  expect(result.expiresAt).toBe(NOW + 3_600_000);
});

test("reads the account email from the id token when there is one", async () => {
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const idToken = `${b64({ alg: "RS256" })}.${b64({ email: "user@example.com" })}.signature`;
  const result = await grokOAuth.exchange(
    { code: "auth-code", pending },
    deps(stubHttp({ status: 200, body: { access_token: "test-token-1", id_token: idToken } })),
  );
  expect(result.accountEmail).toBe("user@example.com");
});

test("tolerates a token response with no id token", async () => {
  const result = await grokOAuth.exchange(
    { code: "auth-code", pending },
    deps(stubHttp({ status: 200, body: { access_token: "test-token-1" } })),
  );
  expect(result.accountEmail).toBeNull();
  expect(result.expiresAt).toBeNull();
});

test("refreshes with the client id and the stored refresh token", async () => {
  const http = stubHttp(OK_TOKEN);
  await grokOAuth.refresh("test-token-9", deps(http), { agentId: "agent-1" });

  expect(http.token().body).toBe(
    "grant_type=refresh_token&client_id=b1a00492-073a-47ea-816f-4c329264a828&refresh_token=test-token-9",
  );
});

test("refresh keeps the previous refresh token when the response omits one", async () => {
  // xAI rotates conditionally. Reading the omission as a null would destroy a
  // working credential on its first refresh.
  const result = await grokOAuth.refresh(
    "test-token-9",
    deps(stubHttp({ status: 200, body: { access_token: "test-token-3", expires_in: 60 } })),
    { agentId: "agent-1" },
  );
  expect(result.secrets.refreshToken).toBe("test-token-9");
  expect(result.secrets.accessToken).toBe("test-token-3");
});

test("refresh takes a rotated refresh token when the response carries one", async () => {
  const result = await grokOAuth.refresh(
    "test-token-9",
    deps(stubHttp({ status: 200, body: { access_token: "t", refresh_token: "test-token-10" } })),
    { agentId: "agent-1" },
  );
  expect(result.secrets.refreshToken).toBe("test-token-10");
});

test("refresh carries the connect-time agent id forward", async () => {
  const result = await grokOAuth.refresh("test-token-9", deps(stubHttp(OK_TOKEN)), {
    agentId: "agent-1",
  });
  expect(result.providerData.agentId).toBe("agent-1");
});

test.each([
  ["http://auth.x.ai/oauth2/token", "plaintext"],
  ["https://auth.evil.example/oauth2/token", "another domain"],
  ["https://evilx.ai/oauth2/token", "a lookalike domain"],
  ["https://x.ai.attacker.example/token", "a prefixed domain"],
])("discovery refuses %s (%s)", async (tokenEndpoint) => {
  const http = stubHttp(OK_TOKEN, {
    status: 200,
    body: { authorization_endpoint: AUTHORIZE_URL, token_endpoint: tokenEndpoint },
  });

  await expect(grokOAuth.exchange({ code: "auth-code", pending }, deps(http))).rejects.toThrow(
    GatewayError,
  );
  // The authorization code must never have left the process.
  expect(http.calls().map((req) => req.url)).toEqual([DISCOVERY_URL]);
});

test("discovery accepts a subdomain of x.ai", async () => {
  const http = stubHttp(OK_TOKEN, {
    status: 200,
    body: {
      authorization_endpoint: "https://accounts.x.ai/oauth2/auth",
      token_endpoint: "https://accounts.x.ai/oauth2/token",
    },
  });
  await grokOAuth.exchange({ code: "auth-code", pending }, deps(http));
  expect(http.token().url).toBe("https://accounts.x.ai/oauth2/token");
});

test.each([
  [{ status: 200, body: { token_endpoint: TOKEN_URL } }, "no authorize endpoint"],
  [{ status: 200, body: "<html>not json</html>" }, "a non-JSON body"],
  [{ status: 500, body: { error: "internal_error" } }, "a failed request"],
])("discovery refuses %#: %s", async (discovery) => {
  await expect(
    grokOAuth.start({ redirectUri: pending.redirectUri }, deps(stubHttp(OK_TOKEN, discovery))),
  ).rejects.toThrow(GatewayError);
});

test("a rejected discovery document does not read as a repudiation", async () => {
  // createRefresher disables a credential on AUTH alone, and a discovery
  // document says nothing about whether the refresh token is still good.
  const http = stubHttp(OK_TOKEN, {
    status: 200,
    body: { authorization_endpoint: AUTHORIZE_URL, token_endpoint: "http://auth.x.ai/token" },
  });
  expect(await refreshCode(http)).toBe("UPSTREAM");
});

async function refreshCode(http: HttpClient): Promise<string> {
  try {
    await grokOAuth.refresh("test-token-9", deps(http), {});
  } catch (error) {
    return (error as GatewayError).code;
  }
  throw new Error("expected throw");
}

test("classifies a repudiated refresh token as AUTH", async () => {
  expect(await refreshCode(stubHttp({ status: 401, body: { error: "invalid_grant" } }))).toBe(
    "AUTH",
  );
});

test("classifies a token endpoint 5xx as transient, not as a repudiation", async () => {
  expect(await refreshCode(stubHttp({ status: 500, body: { error: "internal_error" } }))).toBe(
    "UPSTREAM",
  );
  expect(await refreshCode(stubHttp({ status: 503, body: {} }))).toBe("UPSTREAM");
});

test("classifies a token endpoint 429 as rate limited, not as a repudiation", async () => {
  expect(await refreshCode(stubHttp({ status: 429, body: { error: "rate_limited" } }))).toBe(
    "RATE_LIMIT",
  );
});

test("a token response with no access token fails the flow", async () => {
  await expect(
    grokOAuth.exchange(
      { code: "auth-code", pending },
      deps(stubHttp({ status: 200, body: { refresh_token: "test-token-2" } })),
    ),
  ).rejects.toThrow(GatewayError);
});

test("never puts the verifier or the code in an error message", async () => {
  const secret = { ...pending, verifier: "verifier-must-not-be-quoted" };
  try {
    await grokOAuth.exchange(
      { code: "code-must-not-be-quoted", pending: secret },
      deps(stubHttp({ status: 400, body: { error: "invalid_grant" } })),
    );
    throw new Error("expected throw");
  } catch (error) {
    const message = (error as GatewayError).message;
    expect(message).not.toContain(secret.verifier);
    expect(message).not.toContain("code-must-not-be-quoted");
    expect(message).toContain("invalid_grant");
  }
});
