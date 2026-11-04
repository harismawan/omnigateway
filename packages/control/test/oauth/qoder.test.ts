import { expect, test } from "bun:test";
import type { HttpClient, HttpRequest } from "@omni/providers";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
import { memoryStore } from "@omni/testkit";
import { parseCredential } from "../../../providers/src/qoder/credential.ts";
import { qoderOAuthFlow } from "../../../providers/src/qoder/oauth.ts";
import { createConnectFlows } from "../../src/connect.ts";
import { oauthAdapter } from "../../src/oauth/pluginFlow.ts";
import { createRefresher } from "../../src/oauth/refresh.ts";
import { isAuthorizationPending } from "../../src/oauth/types.ts";

const oauth = oauthAdapter("qoder", qoderOAuthFlow, { trusted: true, maxRequestsPerStep: 5 });

test("Qoder secondary HTTP timeout keeps refreshed account enabled with last-good metadata", async () => {
  for (const timedOut of ["catalog", "discovery"]) {
    const login = sequence(token, user, endpoints, models);
    const begun = await oauth.begin({ deviceId: "" }, login);
    const previous = await oauth.exchange({ code: "", pending: begun.pending }, login);
    const store = await memoryStore();
    await store.credentials.create({
      id: "timeout-account",
      provider: "qoder",
      label: "synthetic",
      authType: "oauth",
      enabled: true,
      tier: 0,
      weight: 1,
      expiresAt: NOW - 1,
      accountEmail: null,
      providerData: previous.providerData,
      disabledReason: null,
      disabledAt: null,
      ...previous.secrets,
    });
    const view = await store.credentials.get("timeout-account");
    if (!view) throw new Error("missing account");
    const timeout = { status: 408, body: {} };
    const deps = sequence(
      {
        status: 200,
        body: { device_token: "rotated", refresh_token: "rotated-refresh", expires_in: 3600 },
      },
      user,
      timedOut === "discovery" ? timeout : endpoints,
      timedOut === "catalog" ? timeout : models,
    );
    const refresh = createRefresher({
      store,
      providers: { qoder: oauth },
      http: deps.http,
      now: deps.now,
    });
    const result = await refresh(view);
    expect(parseCredential(result.accessToken ?? "").deviceToken).toBe("rotated");
    const saved = await store.credentials.get("timeout-account");
    expect(saved?.enabled).toBe(true);
    expect(saved?.disabledReason).toBeNull();
    expect(saved?.providerData.modelCatalog).toEqual(previous.providerData.modelCatalog);
  }
});
const NOW = 1700000000000;
function sequence(...replies: { status: number; body: unknown }[]) {
  const seen: HttpRequest[] = [];
  const http: HttpClient = async (req) => {
    seen.push(req);
    const reply = replies.shift();
    if (!reply) throw new Error(`Unexpected request ${req.url}`);
    return {
      status: reply.status,
      headers: new Headers(),
      body: null,
      text: async () => JSON.stringify(reply.body),
    };
  };
  return { http, now: () => NOW, seen };
}
const token = {
  status: 200,
  body: {
    token: "dummy-token",
    user_id: "u1",
    user_name: "Synthetic",
    refresh_token: "dummy-refresh",
    expires_in: 3600,
  },
};
const user = {
  status: 200,
  body: { id: "u1", name: "Synthetic", email: "synthetic@example.test" },
};
const endpoints = {
  status: 200,
  body: {
    inferNodes: [{ url: "https://evil.test" }, { url: "https://api2.qoder.sh", type: "public" }],
  },
};
const models = {
  status: 200,
  body: {
    assistant: [
      { key: "synthetic", display_name: "Synthetic", is_vl: true, max_input_tokens: 1234 },
    ],
  },
};

test("Qoder device URL binds PKCE and retained synthetic identity without machine_token", async () => {
  const deps = sequence();
  const begun = await oauth.begin(
    { deviceId: "", providerData: { machineId: "synthetic-stable" } },
    deps,
  );
  const url = new URL(begun.authorizeUrl);
  expect(url.origin + url.pathname).toBe("https://qoder.com/device/selectAccounts");
  expect(url.searchParams.get("challenge")).toBe(begun.pending.challenge);
  expect(url.searchParams.get("challenge_method")).toBe("S256");
  expect(url.searchParams.get("client_id")).toBe("e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb");
  expect(url.searchParams.get("nonce")).toMatch(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  expect(url.searchParams.get("machine_id")).toBe("synthetic-stable");
  expect(url.searchParams.has("machine_token")).toBe(false);
  expect(begun.pending.interval).toBe(1);
  expect(deps.seen).toHaveLength(0);
});

test("Qoder polls 404 as pending and refuses expired authorization before HTTP", async () => {
  const deps = sequence({ status: 404, body: {} });
  const begun = await oauth.begin({ deviceId: "" }, deps);
  try {
    await oauth.exchange({ code: "", pending: begun.pending }, deps);
    throw new Error("not pending");
  } catch (e) {
    expect(isAuthorizationPending(e)).toBe(true);
  }
  await expect(
    oauth.exchange({ code: "", pending: begun.pending }, { ...deps, now: () => NOW + 300001 }),
  ).rejects.toMatchObject({ code: "AUTH" });
  expect(deps.seen).toHaveLength(1);
  const url = new URL(deps.seen[0]?.url ?? "");
  expect(url.searchParams.get("verifier")).toBe(begun.pending.verifier);
});

test("Qoder exchange encrypts secrets separately from normalized public catalog", async () => {
  const deps = sequence(token, user, endpoints, models);
  const begun = await oauth.begin(
    { deviceId: "", providerData: { machineId: "synthetic-stable" } },
    deps,
  );
  const result = await oauth.exchange({ code: "", pending: begun.pending }, deps);
  const bundle = parseCredential(result.secrets.accessToken ?? "");
  expect(bundle).toMatchObject({
    uid: "u1",
    deviceToken: "dummy-token",
    machineId: "synthetic-stable",
    origin: "https://api2.qoder.sh",
  });
  expect(result.secrets.apiKey).toBeNull();
  expect(result.secrets.idToken).toBeNull();
  expect(result.secrets.refreshToken).toBe("dummy-refresh");
  expect(result.expiresAt).toBe(NOW + 3600000);
  expect(result.accountEmail).toBe("synthetic@example.test");
  expect(result.providerData).toMatchObject({
    machineId: "synthetic-stable",
    modelCatalog: {
      version: 1,
      models: [
        { id: "synthetic", name: "Synthetic", pricing: null, limits: { contextWindow: 1234 } },
      ],
    },
  });
  const publicJson = JSON.stringify(result.providerData);
  for (const secret of ["dummy-token", "dummy-refresh", bundle.key, bundle.encryptUserInfo])
    expect(publicJson).not.toContain(secret);
  expect(deps.seen.map((r) => new URL(r.url).pathname)).toEqual([
    "/api/v1/deviceToken/poll",
    "/api/v1/userinfo",
    "/algo/api/v5/service/region/endpoints",
    "/algo/api/v2/model/list",
  ]);
});

test("Qoder refresh retains missing rotation and replaces secret-bundle origin without mutating metadata", async () => {
  const login = sequence(token, user, endpoints, models);
  const begun = await oauth.begin({ deviceId: "" }, login);
  const previous = await oauth.exchange({ code: "", pending: begun.pending }, login);
  const snapshot = JSON.stringify(previous.providerData);
  const deps = sequence(
    { status: 200, body: { device_token: "new-dummy-token", expires_at: 1700007200 } },
    user,
    { status: 200, body: { inferNodes: [{ url: "https://api3.qoder.sh" }] } },
    models,
  );
  const refreshed = await oauth.refresh("dummy-refresh", deps, previous.providerData);
  expect(refreshed.secrets.refreshToken).toBe("dummy-refresh");
  expect(parseCredential(refreshed.secrets.accessToken ?? "").origin).toBe("https://api3.qoder.sh");
  expect(refreshed.expiresAt).toBe(NOW + 7200000);
  expect(JSON.stringify(previous.providerData)).toBe(snapshot);
  expect(JSON.parse(deps.seen[0]?.body as string)).toEqual({
    refresh_token: "dummy-refresh",
    machine_id: parseCredential(previous.secrets.accessToken ?? "").machineId,
  });
});

test("Qoder token rejection differs from transient rate/server failures", async () => {
  for (const [status, code] of [
    [401, "AUTH"],
    [403, "AUTH"],
    [429, "RATE_LIMIT"],
    [500, "UPSTREAM"],
  ] as const) {
    const deps = sequence({ status, body: {} });
    const begun = await oauth.begin({ deviceId: "" }, deps);
    await expect(oauth.exchange({ code: "", pending: begun.pending }, deps)).rejects.toMatchObject({
      code,
    });
  }
});

test("Qoder rejects malformed token/account replies rather than producing an unusable credential", async () => {
  for (const replies of [
    [{ status: 200, body: {} }],
    [token, { status: 200, body: { id: "another-user" } }],
    [token, { status: 200, body: {} }],
    [
      { status: 200, body: { token: "dummy-token" } },
      { status: 200, body: {} },
    ],
  ]) {
    const deps = sequence(...replies);
    const begun = await oauth.begin({ deviceId: "" }, deps);
    await expect(oauth.exchange({ code: "", pending: begun.pending }, deps)).rejects.toMatchObject({
      code: "UPSTREAM",
    });
    expect(deps.seen.length).toBeLessThanOrEqual(2);
  }
});

test("Qoder authenticated endpoint denial falls back to signed V3 and validates candidate origins", async () => {
  const deps = sequence(
    token,
    user,
    { status: 403, body: {} },
    { status: 200, body: { inferNodes: ["https://evil.test", "https://api1.qoder.sh"] } },
    models,
  );
  const begun = await oauth.begin({ deviceId: "" }, deps);
  const result = await oauth.exchange({ code: "", pending: begun.pending }, deps);
  expect(parseCredential(result.secrets.accessToken ?? "").origin).toBe("https://api1.qoder.sh");
  const req = deps.seen[3];
  expect(new URL(req?.url ?? "").pathname).toBe("/algo/api/v3/service/region/endpoints");
  expect(req?.headers).toContainEqual(["Appcode", "cosy"]);
  expect(req?.headers.some(([key]) => key.toLowerCase() === "authorization")).toBe(false);
});

test("Qoder initial transient model listing failure allows manual model entry with unknown catalog", async () => {
  const deps = sequence(token, user, endpoints, { status: 503, body: {} });
  const begun = await oauth.begin({ deviceId: "" }, deps);
  const result = await oauth.exchange({ code: "", pending: begun.pending }, deps);
  expect(parseCredential(result.secrets.accessToken ?? "").models).toEqual([]);
  expect(result.providerData.modelCatalog).toBeUndefined();
  expect(result.providerData.catalogStatus).toBe("unavailable");
});

test("Qoder refresh preserves last-good public models on transient listing failure only", async () => {
  const login = sequence(token, user, endpoints, models);
  const begun = await oauth.begin({ deviceId: "" }, login);
  const previous = await oauth.exchange({ code: "", pending: begun.pending }, login);
  const deps = sequence(
    { status: 200, body: { device_token: "new-dummy-token", refresh_token: "rotated" } },
    user,
    endpoints,
    { status: 503, body: {} },
  );
  const refreshed = await oauth.refresh("dummy-refresh", deps, previous.providerData);
  expect(refreshed.secrets.refreshToken).toBe("rotated");
  expect(refreshed.providerData.modelCatalog).toEqual(previous.providerData.modelCatalog);
  expect(parseCredential(refreshed.secrets.accessToken ?? "").models).toEqual(
    parseCredential(previous.secrets.accessToken ?? "").models,
  );
  const denied = sequence(
    { status: 200, body: { device_token: "new-dummy-token" } },
    user,
    endpoints,
    { status: 401, body: {} },
  );
  await expect(oauth.refresh("dummy-refresh", denied, previous.providerData)).rejects.toMatchObject(
    { code: "AUTH" },
  );
});

test("Qoder transient model transport failure does not discard the newly issued token", async () => {
  const base = sequence(token, user, endpoints);
  const http: HttpClient = async (req) => {
    if (new URL(req.url).pathname === "/algo/api/v2/model/list")
      throw new Error("network unavailable");
    return base.http(req);
  };
  const deps = { ...base, http };
  const begun = await oauth.begin({ deviceId: "" }, deps);
  const result = await oauth.exchange({ code: "", pending: begun.pending }, deps);
  expect(parseCredential(result.secrets.accessToken ?? "").deviceToken).toBe("dummy-token");
  expect(result.providerData.catalogStatus).toBe("unavailable");
});

test("Qoder refresh retains a trusted last-good origin during discovery outage", async () => {
  const login = sequence(token, user, endpoints, models);
  const begun = await oauth.begin({ deviceId: "" }, login);
  const previous = await oauth.exchange({ code: "", pending: begun.pending }, login);
  const deps = sequence(
    {
      status: 200,
      body: {
        device_token: "rotated-token",
        refresh_token: "rotated-refresh",
        expires_at: "2026-11-04T12:00:00Z",
      },
    },
    user,
    { status: 503, body: {} },
    models,
  );
  const result = await oauth.refresh("dummy-refresh", deps, previous.providerData);
  expect(parseCredential(result.secrets.accessToken ?? "").origin).toBe("https://api2.qoder.sh");
  expect(result.secrets.refreshToken).toBe("rotated-refresh");
  expect(result.expiresAt).toBe(Date.parse("2026-11-04T12:00:00Z"));
});

test("Qoder refresh bundle survives encrypted store inference loading and host CAS", async () => {
  const login = sequence(token, user, endpoints, models);
  const begun = await oauth.begin({ deviceId: "" }, login);
  const previous = await oauth.exchange({ code: "", pending: begun.pending }, login);
  const store = await memoryStore();
  await store.credentials.create({
    id: "qoder-local",
    provider: "qoder",
    label: "synthetic",
    authType: "oauth",
    enabled: true,
    tier: 0,
    weight: 1,
    expiresAt: NOW - 1,
    accountEmail: null,
    providerData: previous.providerData,
    disabledReason: null,
    disabledAt: null,
    ...previous.secrets,
  });
  const view = await store.credentials.get("qoder-local");
  if (!view) throw new Error("credential missing");
  const opened = await view.openForInference();
  expect(opened.apiKey).toBeNull();
  expect(parseCredential(opened.accessToken ?? "").deviceToken).toBe("dummy-token");
  const deps = sequence(
    { status: 200, body: { device_token: "refreshed-token", expires_in: 3600 } },
    user,
    { status: 200, body: { inferNodes: [{ url: "https://api3.qoder.sh" }] } },
    models,
  );
  const refresh = createRefresher({
    store,
    providers: { qoder: oauth },
    http: deps.http,
    now: deps.now,
  });
  const fresh = await refresh(view);
  expect(parseCredential(fresh.accessToken ?? "").origin).toBe("https://api3.qoder.sh");
  expect(view.providerData).toEqual(previous.providerData);
  const stored = await store.credentials.get("qoder-local");
  expect(parseCredential((await stored?.openForInference())?.accessToken ?? "").deviceToken).toBe(
    "refreshed-token",
  );
});

test("Qoder reconnect uses the original device in browser URL and saved inference bundle", async () => {
  const store = await memoryStore();
  await store.credentials.create({
    id: "qoder-reconnect",
    provider: "qoder",
    label: "synthetic",
    authType: "oauth",
    enabled: true,
    tier: 0,
    weight: 1,
    expiresAt: null,
    accountEmail: null,
    providerData: { machineId: "synthetic-original" },
    disabledReason: null,
    disabledAt: null,
    accessToken: "old-bundle",
    refreshToken: "old-refresh",
    apiKey: null,
    idToken: null,
  });
  const deps = sequence(token, user, endpoints, models);
  const descriptor = PROVIDER_DESCRIPTORS.kimi;
  if (!descriptor) throw new Error("missing test descriptor");
  const flows = createConnectFlows({
    store,
    providers: { qoder: oauth },
    descriptors: { ...PROVIDER_DESCRIPTORS, qoder: { ...descriptor, id: "qoder" } },
    http: deps.http,
    now: deps.now,
  });
  const start = await flows.start("qoder", "reconnected", "qoder-reconnect");
  expect(new URL(start.authorizeUrl).searchParams.get("machine_id")).toBe("synthetic-original");
  expect(await flows.poll(start.flowId)).toEqual({ status: "complete", id: "qoder-reconnect" });
  const saved = await store.credentials.get("qoder-reconnect");
  expect(parseCredential((await saved?.openForInference())?.accessToken ?? "").machineId).toBe(
    "synthetic-original",
  );
});
