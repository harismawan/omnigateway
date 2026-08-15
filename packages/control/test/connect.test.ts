import { expect, test } from "bun:test";
import { createConnectFlows, type FlowResult, type OAuthProvider } from "@omni/control";
import { GatewayError } from "@omni/ir";
import type { HttpClient, HttpRequest } from "@omni/providers";
import { memoryStore } from "@omni/testkit";
import { kiloOAuth } from "../src/oauth/kilo.ts";

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
  await expect(
    flows.finish(start.flowId, "http://127.0.0.1:56121/callback?code=auth-code&state=forged"),
  ).rejects.toThrow(GatewayError);
});

test("concurrent pending polls share one device exchange", async () => {
  let exchangeCalls = 0;
  const exchange = Promise.withResolvers<FlowResult>();
  const provider: OAuthProvider = {
    id: "kimi",
    kind: "device",
    // Modelling kimi, which cannot ask for a code without one.
    needsDeviceId: true,
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

/** Answers by URL so one client can serve a whole device flow. */
function kiloHttp(replies: readonly { status: number; body: unknown }[]): HttpClient {
  let call = 0;
  return async (req: HttpRequest) => {
    const reply = replies[call++];
    if (reply === undefined) throw new Error(`unexpected request to ${req.url}`);
    return {
      status: reply.status,
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
      text: async () => JSON.stringify(reply.body),
    };
  };
}

test("a kilo device flow starts with no device identity to mint", async () => {
  // Kimi's `begin` needs a device id that `start` minted first. Kilo has no
  // device identity at all, and the flow must not demand one on its behalf.
  const store = await memoryStore();
  const flows = createConnectFlows({
    store,
    providers: { kilo: kiloOAuth },
    http: kiloHttp([
      {
        status: 200,
        body: { code: "KILO-1", verificationUrl: "https://kilo.ai/d", expiresIn: 300 },
      },
      { status: 202, body: {} },
      { status: 200, body: { status: "approved", token: "kilo-token-1", userEmail: "u@e.com" } },
      { status: 200, body: { organizations: [{ id: "org-42" }] } },
    ]),
    now: () => 1_000_000,
  });

  const start = await flows.start("kilo", "kilo");
  expect(start.kind).toBe("device");
  expect(start.userCode).toBe("KILO-1");
  expect(start.authorizeUrl).toBe("https://kilo.ai/d");
  expect(start.pollIntervalMs).toBe(3000);

  expect(await flows.poll(start.flowId)).toEqual({ status: "pending" });
  const done = await flows.poll(start.flowId);
  expect(done.status).toBe("complete");

  const rows = await store.credentials.list();
  const stored = rows[0];
  expect(stored?.provider).toBe("kilo");
  expect(stored?.accountEmail).toBe("u@e.com");
  expect(stored?.providerData.orgId).toBe("org-42");
  // The two facts the scheduler and the refresher both read.
  expect(stored?.expiresAt).toBeNull();
  expect(stored?.hasRefreshToken).toBe(false);
});

/** What `begin` was handed, and whether it was reached at all. */
type BeginSeen = { deviceId: string | null; beginCalls: number };

const unseen = (): BeginSeen => ({ deviceId: null, beginCalls: 0 });

/**
 * A device provider that records what `begin` received, so a test can choose
 * what `start` minted and read back what the shared check made of it.
 */
function deviceProvider(opts: {
  needsDeviceId: boolean;
  minted?: unknown;
  seen: BeginSeen;
}): OAuthProvider {
  return {
    id: "kimi",
    kind: "device",
    needsDeviceId: opts.needsDeviceId,
    supportsManualPaste: false,
    start: () => ({
      authorizeUrl: "https://example.test/device",
      pending: {
        verifier: "",
        challenge: "",
        state: "",
        redirectUri: "",
        ...(opts.minted === undefined ? {} : { extra: { deviceId: opts.minted } }),
      },
    }),
    begin: async ({ deviceId }) => {
      opts.seen.beginCalls += 1;
      opts.seen.deviceId = deviceId;
      return {
        authorizeUrl: "https://example.test/device",
        userCode: "USER-CODE",
        pending: {
          verifier: "",
          challenge: "",
          state: "",
          redirectUri: "",
          deviceCode: "dc-1",
          interval: 5,
        },
      };
    },
    exchange: async () => RESULT,
    refresh: async () => RESULT,
  };
}

async function flowsFor(provider: OAuthProvider) {
  return createConnectFlows({
    store: await memoryStore(),
    providers: { kimi: provider },
    http: noHttp,
    now: () => 0,
  });
}

test("a device provider that needs an identity is not started without one", async () => {
  // The guard `deviceIdFrom` used to carry unconditionally, back where shared
  // code can enforce it: a provider that needs a fingerprint and silently gets
  // `""` sends it upstream, where it returns as an opaque provider-side auth
  // failure rather than as the gateway bug it is. `INTERNAL`, not a bare
  // `Error`: an unclassified throw reaches the console as a flat "internal
  // error" with the message thrown away.
  const seen = unseen();
  const flows = await flowsFor(deviceProvider({ needsDeviceId: true, seen }));

  await expect(flows.start("kimi", "kimi")).rejects.toMatchObject({
    code: "INTERNAL",
    message: "device authorization did not provide a device id",
  });
  expect(seen.beginCalls).toBe(0);
});

test("a blank device identity counts as none for a provider that needs one", async () => {
  // Whitespace reaches the provider looking like a value; upstream refuses it
  // as a malformed device rather than as a missing one.
  const seen = unseen();
  const flows = await flowsFor(deviceProvider({ needsDeviceId: true, minted: "  ", seen }));

  await expect(flows.start("kimi", "kimi")).rejects.toMatchObject({ code: "INTERNAL" });
  expect(seen.beginCalls).toBe(0);
});

test("a device provider that needs no identity is begun with a blank one", async () => {
  // Kilo's case: it identifies an editor, not a machine, so there is nothing to
  // mint and nothing to enforce. The flow must not demand one on its behalf.
  const seen = unseen();
  const flows = await flowsFor(deviceProvider({ needsDeviceId: false, seen }));

  const start = await flows.start("kimi", "kimi");

  expect(start.userCode).toBe("USER-CODE");
  expect(seen.beginCalls).toBe(1);
  expect(seen.deviceId).toBe("");
});

test("a minted device identity reaches begin unchanged", async () => {
  const seen = unseen();
  const flows = await flowsFor(deviceProvider({ needsDeviceId: true, minted: "dev-1", seen }));

  await flows.start("kimi", "kimi");

  expect(seen.deviceId).toBe("dev-1");
});

test("the provider list an operator is shown names kilo", async () => {
  const flows = createConnectFlows({
    store: await memoryStore(),
    providers: { kilo: kiloOAuth },
    http: noHttp,
    now: () => 0,
  });

  const error = await flows.start("kilocode").catch((e: unknown) => e);

  expect((error as GatewayError).message).toContain("kilo,");
});
