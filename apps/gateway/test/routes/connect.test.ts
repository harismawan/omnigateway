import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import { nodeHttpClient } from "@omni/providers";
import { createAdminAuth } from "../../src/auth/admin.ts";
import type { FlowResult, OAuthProvider } from "../../src/oauth/types.ts";
import { connectRoutes } from "../../src/routes/connect.ts";
import { memoryStore } from "../helpers/fixtures.ts";

const NOW = 1_000_000;

const RESULT: FlowResult = {
  secrets: {
    accessToken: "test-token-1",
    refreshToken: "test-token-2",
    apiKey: null,
    idToken: null,
  },
  expiresAt: NOW + 3_600_000,
  accountEmail: "user@example.com",
  providerData: { accountId: "acct_1" },
};

function pkceProvider(exchange: () => Promise<FlowResult>): OAuthProvider {
  return {
    id: "anthropic",
    kind: "pkce",
    supportsManualPaste: true,
    start: ({ redirectUri }) => ({
      authorizeUrl: `https://example.com/authorize?state=the-state&redirect_uri=${redirectUri}`,
      pending: { verifier: "v", challenge: "c", state: "the-state", redirectUri },
    }),
    exchange,
    refresh: async () => RESULT,
  };
}

async function harness(provider: OAuthProvider = pkceProvider(async () => RESULT)) {
  const store = await memoryStore();
  const admin = createAdminAuth(store, { now: () => NOW, sessionTtlMs: 60_000 });
  await admin.setPassword("hunter2hunter2");
  const token = (await admin.login("hunter2hunter2")) as string;

  const app = connectRoutes({
    store,
    admin,
    providers: { anthropic: provider, openai: provider, kimi: provider },
    http: nodeHttpClient(),
    now: () => NOW,
    baseUrl: "http://localhost:8787",
  });

  const post = (path: string, body: unknown, auth = true) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { cookie: `omni_admin=${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );

  return { store, app, post, token };
}

test("start returns an authorize url and a flow id", async () => {
  const { post } = await harness();
  const res = await post("/api/connect/start", { provider: "anthropic", label: "work" });
  const body = (await res.json()) as Record<string, unknown>;
  expect(res.status).toBe(200);
  expect(body.authorizeUrl).toContain("https://example.com/authorize");
  expect(typeof body.flowId).toBe("string");
});

test("start requires an admin session", async () => {
  const { post } = await harness();
  const res = await post("/api/connect/start", { provider: "anthropic", label: "x" }, false);
  expect(res.status).toBe(401);
});

test("start rejects an unknown provider", async () => {
  const { post } = await harness();
  expect((await post("/api/connect/start", { provider: "nope", label: "x" })).status).toBe(400);
});

test("finish exchanges the code and stores an enabled credential", async () => {
  const { post, store } = await harness();
  const { flowId } = (await (
    await post("/api/connect/start", { provider: "anthropic", label: "work" })
  ).json()) as {
    flowId: string;
  };

  const res = await post("/api/connect/finish", { flowId, code: "auth-code" });
  expect(res.status).toBe(200);

  const credentials = await store.credentials.list();
  expect(credentials).toHaveLength(1);
  expect(credentials[0]?.label).toBe("work");
  expect(credentials[0]?.enabled).toBe(true);
  expect(credentials[0]?.accountEmail).toBe("user@example.com");
  expect(credentials[0]?.providerData).toEqual({ accountId: "acct_1" });
  expect(credentials[0]?.hasRefreshToken).toBe(true);
});

test("the finish response never contains the tokens", async () => {
  const { post } = await harness();
  const { flowId } = (await (
    await post("/api/connect/start", { provider: "anthropic", label: "w" })
  ).json()) as {
    flowId: string;
  };
  const text = await (await post("/api/connect/finish", { flowId, code: "auth-code" })).text();
  expect(text).not.toContain("test-token-1");
  expect(text).not.toContain("test-token-2");
});

test("a flow id cannot be reused", async () => {
  const { post } = await harness();
  const { flowId } = (await (
    await post("/api/connect/start", { provider: "anthropic", label: "w" })
  ).json()) as {
    flowId: string;
  };
  await post("/api/connect/finish", { flowId, code: "auth-code" });
  expect((await post("/api/connect/finish", { flowId, code: "auth-code" })).status).toBe(400);
});

test("a failed exchange surfaces as an error and stores nothing", async () => {
  const { post, store } = await harness(
    pkceProvider(async () => {
      throw new GatewayError("AUTH", "token endpoint rejected the request: invalid_grant");
    }),
  );
  const { flowId } = (await (
    await post("/api/connect/start", { provider: "anthropic", label: "w" })
  ).json()) as {
    flowId: string;
  };

  const res = await post("/api/connect/finish", { flowId, code: "bad" });
  expect(res.status).toBe(401);
  expect(await store.credentials.list()).toHaveLength(0);
});

test("the browser callback completes the flow by state", async () => {
  const { post, app, store } = await harness();
  await post("/api/connect/start", { provider: "anthropic", label: "work" });

  const res = await app.handle(
    new Request("http://localhost/oauth/callback?code=auth-code&state=the-state"),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await store.credentials.list()).toHaveLength(1);
});

test("the callback rejects an unknown state", async () => {
  const { app } = await harness();
  const res = await app.handle(new Request("http://localhost/oauth/callback?code=c&state=forged"));
  expect(res.status).toBe(400);
});

test("the callback surfaces a provider error without exchanging", async () => {
  const { app, store, post } = await harness();
  await post("/api/connect/start", { provider: "anthropic", label: "work" });
  const res = await app.handle(
    new Request("http://localhost/oauth/callback?error=access_denied&state=the-state"),
  );
  expect(res.status).toBe(400);
  expect(await store.credentials.list()).toHaveLength(0);
});

test("the callback consumes a matched state before the exchange", async () => {
  let resolveExchange: ((result: FlowResult) => void) | undefined;
  const exchange = new Promise<FlowResult>((resolve) => {
    resolveExchange = resolve;
  });
  const { app, post, store } = await harness(pkceProvider(async () => exchange));
  await post("/api/connect/start", { provider: "anthropic", label: "work" });

  const first = app.handle(
    new Request("http://localhost/oauth/callback?code=auth-code&state=the-state"),
  );
  await Promise.resolve();
  const second = await app.handle(
    new Request("http://localhost/oauth/callback?code=auth-code&state=the-state"),
  );

  expect(second.status).toBe(400);
  resolveExchange?.(RESULT);
  expect((await first).status).toBe(200);
  expect(await store.credentials.list()).toHaveLength(1);
});

test("poll reports pending for a device flow that is not yet approved", async () => {
  const deviceProvider: OAuthProvider = {
    id: "kimi",
    kind: "device",
    supportsManualPaste: false,
    start: () => ({
      authorizeUrl: "https://kimi.example/device",
      pending: {
        verifier: "",
        challenge: "",
        state: "",
        redirectUri: "",
        extra: { deviceId: "dev-1" },
      },
    }),
    begin: async () => ({
      authorizeUrl: "https://kimi.example/device",
      userCode: "WDJB-MJHT",
      pending: {
        verifier: "",
        challenge: "",
        state: "",
        redirectUri: "",
        deviceCode: "dc-1",
        interval: 5,
        extra: { deviceId: "dev-1" },
      },
    }),
    exchange: async () => {
      const error = new GatewayError("AUTH", "authorization not yet complete") as GatewayError & {
        __omni_authorization_pending?: boolean;
      };
      error.__omni_authorization_pending = true;
      throw error;
    },
    refresh: async () => RESULT,
  };

  const { post } = await harness(deviceProvider);
  const start = (await (
    await post("/api/connect/start", { provider: "kimi", label: "kimi" })
  ).json()) as {
    flowId: string;
    userCode: string;
  };
  expect(start.userCode).toBe("WDJB-MJHT");

  const res = await post("/api/connect/poll", { flowId: start.flowId });
  expect(res.status).toBe(202);
  expect(((await res.json()) as { status: string }).status).toBe("pending");
});
