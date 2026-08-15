import { expect, test } from "bun:test";
import { createConnectFlows, type FlowResult, type OAuthProvider } from "@omni/control";
import { GatewayError } from "@omni/ir";
import type { HttpClient } from "@omni/providers";
import { memoryStore } from "@omni/testkit";

const RESULT: FlowResult = {
  secrets: {
    accessToken: "test-token-1",
    refreshToken: "test-token-2",
    apiKey: null,
    idToken: null,
  },
  expiresAt: 3_600_000,
  accountEmail: "user@example.com",
  providerData: { accountId: "acct_1" },
};

const noHttp: HttpClient = () => {
  throw new Error("device flow reached transport");
};

test("a grok flow redirects to loopback and accepts the pasted callback url", async () => {
  const seen: { redirectUri: string | null; code: string | null } = {
    redirectUri: null,
    code: null,
  };
  const provider: OAuthProvider = {
    id: "grok",
    kind: "pkce",
    supportsManualPaste: true,
    start: ({ redirectUri }) => {
      seen.redirectUri = redirectUri;
      return {
        authorizeUrl: "https://auth.x.ai/oauth2/auth",
        pending: { verifier: "v", challenge: "c", state: "the-state", redirectUri },
      };
    },
    exchange: async ({ code }) => {
      seen.code = code;
      return RESULT;
    },
    refresh: async () => RESULT,
  };
  const flows = createConnectFlows({
    store: await memoryStore(),
    providers: { grok: provider },
    http: noHttp,
    now: () => 0,
  });

  const start = await flows.start("grok", "grok");
  expect(seen.redirectUri).toBe("http://127.0.0.1:56121/callback");

  // The loopback redirect fails to connect, so what the operator has is the
  // address bar. The whole URL is accepted and unpicked here.
  await flows.finish(
    start.flowId,
    "http://127.0.0.1:56121/callback?code=auth-code&state=the-state",
  );
  expect(seen.code).toBe("auth-code#the-state");
});

test("a forged state in a pasted grok callback is refused", async () => {
  const provider: OAuthProvider = {
    id: "grok",
    kind: "pkce",
    supportsManualPaste: true,
    start: ({ redirectUri }) => ({
      authorizeUrl: "https://auth.x.ai/oauth2/auth",
      pending: { verifier: "v", challenge: "c", state: "the-state", redirectUri },
    }),
    exchange: async () => {
      throw new Error("exchange must not run on a state mismatch");
    },
    refresh: async () => RESULT,
  };
  const flows = createConnectFlows({
    store: await memoryStore(),
    providers: { grok: provider },
    http: noHttp,
    now: () => 0,
  });

  const start = await flows.start("grok", "grok");
  expect(
    flows.finish(start.flowId, "http://127.0.0.1:56121/callback?code=auth-code&state=forged"),
  ).rejects.toThrow(GatewayError);
});

test("concurrent pending polls share one device exchange", async () => {
  let exchangeCalls = 0;
  const exchange = Promise.withResolvers<FlowResult>();
  const provider: OAuthProvider = {
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
      exchangeCalls += 1;
      return exchange.promise;
    },
    refresh: async () => RESULT,
  };
  const store = await memoryStore();
  const flows = createConnectFlows({
    store,
    providers: { anthropic: provider, openai: provider, kimi: provider },
    http: noHttp,
    now: () => 0,
  });
  const start = await flows.start("kimi", "kimi");

  const first = flows.poll(start.flowId);
  const second = flows.poll(start.flowId);
  const pendingError = new GatewayError(
    "AUTH",
    "authorization not yet complete",
  ) as GatewayError & { __omni_authorization_pending?: boolean };
  pendingError.__omni_authorization_pending = true;
  exchange.reject(pendingError);

  expect(await first).toEqual({ status: "pending" });
  expect(await second).toEqual({ status: "pending" });
  expect(exchangeCalls).toBe(1);
  expect(await flows.poll(start.flowId)).toEqual({ status: "pending" });
  expect(exchangeCalls).toBe(2);
});
