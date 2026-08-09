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
