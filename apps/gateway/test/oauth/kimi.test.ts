import { expect, test } from "bun:test";
import { GatewayError } from "@omni/ir";
import type { HttpClient, HttpRequest } from "@omni/providers";
import { OAUTH_PROVIDERS } from "../../src/oauth/index.ts";
import { isAuthorizationPending, kimiOAuth } from "../../src/oauth/kimi.ts";

const NOW = 1_000_000;
const KIMI_HEADERS = [
  ["Content-Type", "application/json"],
  ["X-Msh-Platform", "kimi_code_cli"],
  ["X-Msh-Version", "0.26.0"],
  ["X-Msh-Device-Id", "11111111-2222-3333-4444-555555555555"],
  ["X-Msh-Device-Name", "MacBook-Pro"],
  ["X-Msh-Device-Model", "MacBookPro18,3"],
  ["X-Msh-Os-Version", "15.3.1"],
  ["User-Agent", "kimi-code-cli/0.26.0"],
  ["Accept", "application/json"],
] as const;

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

test("is registered as a device flow that cannot be pasted", () => {
  expect(kimiOAuth.kind).toBe("device");
  expect(kimiOAuth.supportsManualPaste).toBe(false);
});

test("start returns a verification url and a stable device id", () => {
  const start = kimiOAuth.start({ redirectUri: "" });
  expect(start.authorizeUrl).toContain("https://");
  expect(typeof start.pending.extra?.deviceId).toBe("string");
});

test("begin rejects a blank device id before making an HTTP request", async () => {
  let calls = 0;
  const http = (async () => {
    calls += 1;
    throw new Error("begin should reject before calling HttpClient");
  }) as HttpClient;

  await expect(kimiOAuth.begin?.({ deviceId: "  " }, { http, now: () => NOW })).rejects.toThrow(
    "kimi begin requires a non-blank deviceId",
  );
  expect(calls).toBe(0);
});

test("begin requests a device code and surfaces the user code", async () => {
  const http = stubHttp(200, {
    device_code: "dc-1",
    user_code: "WDJB-MJHT",
    verification_uri: "https://kimi.example/device",
    interval: 5,
  });
  const started = await kimiOAuth.begin?.(
    { deviceId: "11111111-2222-3333-4444-555555555555" },
    { http, now: () => NOW },
  );

  expect(started?.userCode).toBe("WDJB-MJHT");
  expect(started?.authorizeUrl).toBe("https://kimi.example/device");
  expect(started?.pending.deviceCode).toBe("dc-1");
  expect(started?.pending.interval).toBe(5);
  expect(http.last().headers).toEqual(KIMI_HEADERS);
  expect(http.last().body).toBe(
    '{"device_id":"11111111-2222-3333-4444-555555555555","client_id":"kimi-cli"}',
  );
});

test("a single poll returns tokens once the user approves", async () => {
  const result = await kimiOAuth.exchange(
    {
      code: "",
      pending: {
        verifier: "",
        challenge: "",
        state: "",
        redirectUri: "",
        deviceCode: "dc-1",
        extra: {
          deviceId: "11111111-2222-3333-4444-555555555555",
          deviceName: "MacBook-Pro",
          deviceModel: "MacBookPro18,3",
          osVersion: "15.3.1",
        },
      },
    },
    {
      http: stubHttp(200, {
        access_token: "test-token-1",
        refresh_token: "test-token-2",
        expires_in: 3600,
      }),
      now: () => NOW,
    },
  );
  expect(result.secrets.accessToken).toBe("test-token-1");
  expect(result.providerData.deviceId).toBe("11111111-2222-3333-4444-555555555555");
  expect(result.expiresAt).toBe(NOW + 3_600_000);
});

test("rejects a successful token response with a blank access token", async () => {
  await expect(
    kimiOAuth.exchange(
      {
        code: "",
        pending: {
          verifier: "",
          challenge: "",
          state: "",
          redirectUri: "",
          deviceCode: "dc-1",
        },
      },
      { http: stubHttp(200, { access_token: "" }), now: () => NOW },
    ),
  ).rejects.toThrow("token endpoint returned no access_token");
});

test("rejects a device-code response with a blank required field", async () => {
  await expect(
    kimiOAuth.begin?.(
      { deviceId: "11111111-2222-3333-4444-555555555555" },
      {
        http: stubHttp(200, { device_code: "", user_code: "WDJB-MJHT" }),
        now: () => NOW,
      },
    ),
  ).rejects.toThrow("device code endpoint returned an unusable response");
});

test("a pending authorization is a distinguishable error, not a failure", async () => {
  try {
    await kimiOAuth.exchange(
      {
        code: "",
        pending: { verifier: "", challenge: "", state: "", redirectUri: "", deviceCode: "dc-1" },
      },
      { http: stubHttp(400, { error: "authorization_pending" }), now: () => NOW },
    );
    throw new Error("expected throw");
  } catch (error) {
    expect(isAuthorizationPending(error)).toBe(true);
  }
});

test("slow_down is also treated as pending", async () => {
  try {
    await kimiOAuth.exchange(
      {
        code: "",
        pending: { verifier: "", challenge: "", state: "", redirectUri: "", deviceCode: "dc-1" },
      },
      { http: stubHttp(400, { error: "slow_down" }), now: () => NOW },
    );
    throw new Error("expected throw");
  } catch (error) {
    expect(isAuthorizationPending(error)).toBe(true);
  }
});

test("a denied authorization is a terminal AUTH error", async () => {
  try {
    await kimiOAuth.exchange(
      {
        code: "",
        pending: { verifier: "", challenge: "", state: "", redirectUri: "", deviceCode: "dc-1" },
      },
      { http: stubHttp(400, { error: "access_denied" }), now: () => NOW },
    );
    throw new Error("expected throw");
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    expect(isAuthorizationPending(error)).toBe(false);
  }
});

test("exchange without a device code is a programming error", async () => {
  expect(
    kimiOAuth.exchange(
      { code: "", pending: { verifier: "", challenge: "", state: "", redirectUri: "" } },
      { http: stubHttp(200, {}), now: () => NOW },
    ),
  ).rejects.toThrow();
});

test("refresh returns a new access token and reuses the stored device", async () => {
  const stored = {
    deviceId: "11111111-2222-3333-4444-555555555555",
    deviceName: "MacBook-Pro",
    deviceModel: "MacBookPro18,3",
    osVersion: "15.3.1",
  };
  const http = stubHttp(200, { access_token: "test-token-3", expires_in: 60 });
  const result = await kimiOAuth.refresh("test-token-2", { http, now: () => NOW }, stored);
  expect(result.secrets.accessToken).toBe("test-token-3");
  expect(result.secrets.refreshToken).toBe("test-token-2");
  expect(result.providerData).toEqual(stored);
  expect(http.last().headers).toEqual(KIMI_HEADERS);
  expect(http.last().body).toBe(
    '{"grant_type":"refresh_token","refresh_token":"test-token-2","device_id":"11111111-2222-3333-4444-555555555555","client_id":"kimi-cli"}',
  );
});

test("refresh preserves the stored token when the new refresh token is blank", async () => {
  const result = await kimiOAuth.refresh(
    "test-token-2",
    { http: stubHttp(200, { access_token: "test-token-3", refresh_token: "" }), now: () => NOW },
    {
      deviceId: "11111111-2222-3333-4444-555555555555",
      deviceName: "MacBook-Pro",
      deviceModel: "MacBookPro18,3",
      osVersion: "15.3.1",
    },
  );
  expect(result.secrets.refreshToken).toBe("test-token-2");
});

test("the registry exposes one flow per provider", () => {
  expect(Object.keys(OAUTH_PROVIDERS).sort()).toEqual(["anthropic", "kimi", "openai"]);
  expect(OAUTH_PROVIDERS.kimi.id).toBe("kimi");
});
