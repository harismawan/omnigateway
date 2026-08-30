import { type KimiDevice, kimiDeviceHeaders, kimiProfile, mintKimiDevice } from "@omni/providers";
import {
  type AuthHelpers,
  type AuthStep,
  oauthAdapter,
  type PluginOAuthFlow,
} from "./pluginFlow.ts";
import { getJsonRequest, parsed as parseBody, postJsonRequest } from "./requests.ts";
import type { DeviceOAuthProvider, FlowResult, UsageReport } from "./types.ts";
import { tokenErrorCode, tokenErrorMessage } from "./types.ts";
import { recordOf, reportFrom, usageReadable, windowFrom } from "./usage.ts";

// Re-exported because the pending marker moved to `types.ts` when kilo became
// the second device flow, and this module's existing callers ask kimi for it.
export { isAuthorizationPending } from "./types.ts";

/** Public client ID of the Kimi CLI. See the note at the head of Task 20. */
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEVICE_CODE_URL = "https://auth.kimi.com/api/oauth/device_authorization";
const TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const DEFAULT_INTERVAL_SECONDS = 5;

/** Errors that mean "keep polling" rather than "this flow failed". */
const PENDING_ERRORS = new Set(["authorization_pending", "slow_down"]);

type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  email: string | null;
};

type DeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function recordFrom(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringFrom(value: Record<string, unknown>, field: string): string | null {
  const candidate = value[field];
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
}

function positiveNumberFrom(value: Record<string, unknown>, field: string): number | null {
  const candidate = value[field];
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0
    ? candidate
    : null;
}

function tokenFrom(value: unknown, fail: AuthHelpers["fail"]): TokenResponse {
  const record = recordFrom(value);
  if (record === null) {
    throw fail("AUTH", "token endpoint returned no access_token");
  }
  const accessToken = stringFrom(record, "access_token");
  if (accessToken === null) {
    throw fail("AUTH", "token endpoint returned no access_token");
  }
  return {
    accessToken,
    refreshToken: stringFrom(record, "refresh_token"),
    expiresIn: positiveNumberFrom(record, "expires_in"),
    email: stringFrom(record, "email"),
  };
}

function deviceCodeFrom(value: unknown, fail: AuthHelpers["fail"]): DeviceCodeResponse {
  const record = recordFrom(value);
  if (record === null) {
    throw fail("AUTH", "device code endpoint returned an unusable response");
  }
  const deviceCode = stringFrom(record, "device_code");
  const userCode = stringFrom(record, "user_code");
  if (deviceCode === null || userCode === null) {
    throw fail("AUTH", "device code endpoint returned an unusable response");
  }
  return {
    deviceCode,
    userCode,
    verificationUri:
      stringFrom(record, "verification_uri_complete") ??
      stringFrom(record, "verification_uri") ??
      "https://www.kimi.com/device",
    interval: positiveNumberFrom(record, "interval") ?? DEFAULT_INTERVAL_SECONDS,
  };
}

/**
 * The form post every kimi endpoint takes, as a step the host performs.
 *
 * A generator rather than a function because it yields: the flow describes the
 * request and the host sends it, so `begin`, `exchange` and `refresh` delegate
 * to this with `yield*` exactly as they awaited it before. The device
 * fingerprint rides on every one of them — kimi ties the session to it — which
 * is why it is a parameter here rather than something each caller remembers to
 * add to `extraHeaders`.
 */
// `async function*`, not `function*`. A sync generator delegated with `yield*`
// from an async one runs, but its `TNext` widens to `AuthResponse | undefined`
// — so every field read off the response becomes possibly-undefined and the
// step stops matching `AuthStep`. Caught by the compiler, not by the tests,
// which passed either way.
async function* post(
  url: string,
  body: Record<string, string>,
  device: KimiDevice,
  fail: AuthHelpers["fail"],
  keepPolling: AuthHelpers["keepPolling"],
): AuthStep<unknown> {
  const res = yield postJsonRequest(url, kimiProfile, {
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({ ...body, client_id: CLIENT_ID }).toString(),
    extraHeaders: kimiDeviceHeaders(device),
  });
  const parsed = parseBody(res.body);

  if (res.status >= 200 && res.status < 300) return parsed;

  const record = recordFrom(parsed);
  const code =
    record === null ? `http_${res.status}` : (stringFrom(record, "error") ?? `http_${res.status}`);
  // `keepPolling` rather than a thrown marker of our own: the "not approved
  // yet" signal carries a private marker only the host can set.
  if (PENDING_ERRORS.has(code)) throw keepPolling(code);
  throw fail(tokenErrorCode(res.status), tokenErrorMessage(res.status, parsed));
}

/** Reads a persisted identity back, minting a fresh one if it is absent. */
function deviceFrom(source: Record<string, unknown> | undefined): KimiDevice {
  if (typeof source?.deviceId === "string" && source.deviceId.length > 0) {
    const fresh = mintKimiDevice();
    const field = (key: keyof Omit<KimiDevice, "deviceId">, fallback: string): string => {
      const value = source[key];
      return typeof value === "string" && value.length > 0 ? value : fallback;
    };
    return {
      deviceId: source.deviceId,
      deviceName: field("deviceName", fresh.deviceName),
      deviceModel: field("deviceModel", fresh.deviceModel),
      osVersion: field("osVersion", fresh.osVersion),
    };
  }
  return mintKimiDevice();
}

function deviceForBegin(deviceId: string): KimiDevice {
  return { ...mintKimiDevice(), deviceId };
}

function toResult(
  token: TokenResponse,
  device: KimiDevice,
  fallbackRefresh: string | null,
  now: () => number,
): FlowResult {
  return {
    secrets: {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? fallbackRefresh,
      apiKey: null,
      idToken: null,
    },
    expiresAt: token.expiresIn === null ? null : now() + token.expiresIn * 1000,
    accountEmail: token.email,
    providerData: { ...device },
  };
}

/**
 * Reads a Kimi usage payload.
 *
 * Kimi answers with one plan window under `usage`, whose counters are strings:
 * `{"limit": "100", "used": "92", "remaining": "8", "resetTime": ...}`. It is
 * the weekly allowance, which is what a Kimi Coding plan is sold in.
 *
 * The sibling `limits` array describes per-minute request ceilings rather than
 * the plan window. Those are burst limits the breaker already reacts to, and
 * mixing them into the tightest-window rule would park an account for a minute
 * of throttling as if its subscription were spent.
 *
 * Exported for fixture tests.
 */
export function parseKimiUsage(value: unknown, now: number): UsageReport | null {
  const root = recordOf(value);
  if (root === null) return null;

  return reportFrom([windowFrom(root.usage ?? root.Usage, "weekly", now)]);
}

const kimiFlow: PluginOAuthFlow = {
  kind: "device",
  // Kimi ties the session to the fingerprint `start` mints and sends it on
  // every later call; a blank one is refused upstream as a malformed device.
  needsDeviceId: true,
  supportsManualPaste: false,

  // biome-ignore lint/correctness/useYield: the url is a constant and the fingerprint is minted locally
  async *start() {
    const device = mintKimiDevice();
    return {
      authorizeUrl: "https://www.kimi.com/device",
      pending: { verifier: "", challenge: "", state: "", redirectUri: "", extra: { ...device } },
    };
  },

  async *begin({ deviceId, fail, keepPolling }) {
    // Kept as a backstop, not as the primary check: `needsDeviceId: true` is
    // what `connect.ts`'s `deviceIdFrom` reads, and no flow that goes through
    // it can arrive here blank. `begin` is exported on `OAUTH_PROVIDERS`
    // though, so it is reachable without that flow, and a fingerprint is
    // kimi's own requirement rather than something to look up elsewhere.
    //
    // `INTERNAL` through `fail`, never a bare `Error`, and the same code the
    // shared check raises: the host relabels an arbitrary throw as "kimi oauth
    // begin threw" and drops the message with it, so the operator reads a 500
    // with no hint of which half of the flow broke.
    if (deviceId.trim().length === 0) {
      throw fail("INTERNAL", "kimi begin requires a non-blank deviceId");
    }
    const device = deviceForBegin(deviceId);
    const response = deviceCodeFrom(
      yield* post(DEVICE_CODE_URL, {}, device, fail, keepPolling),
      fail,
    );
    return {
      authorizeUrl: response.verificationUri,
      userCode: response.userCode,
      pending: {
        verifier: "",
        challenge: "",
        state: "",
        redirectUri: "",
        deviceCode: response.deviceCode,
        interval: response.interval,
        extra: { ...device },
      },
    };
  },

  /** One poll. The caller owns the loop and the deadline. */
  async *exchange({ pending, fail, keepPolling, now }) {
    // `fail` for the same reason `begin` uses it: a bare `Error` out of a step
    // reaches the operator as the host's "kimi oauth exchange threw", which
    // names neither the missing device code nor that this is a gateway bug.
    if (pending.deviceCode === undefined) {
      throw fail("INTERNAL", "kimi exchange requires a pending flow produced by begin()");
    }
    const device = deviceFrom(pending.extra);
    const token = tokenFrom(
      yield* post(
        TOKEN_URL,
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: pending.deviceCode,
          device_id: device.deviceId,
        },
        device,
        fail,
        keepPolling,
      ),
      fail,
    );
    return toResult(token, device, null, now);
  },

  async *refresh({ refreshToken, providerData, fail, keepPolling, now }) {
    const device = deviceFrom(providerData);
    const token = tokenFrom(
      yield* post(
        TOKEN_URL,
        { grant_type: "refresh_token", refresh_token: refreshToken, device_id: device.deviceId },
        device,
        fail,
        keepPolling,
      ),
      fail,
    );
    return toResult(token, device, refreshToken, now);
  },

  async *usage({ secrets, providerData, now }) {
    if (secrets.accessToken === null) return null;
    const device = deviceFrom(providerData);
    const res = yield getJsonRequest(USAGE_URL, kimiProfile, {
      accessToken: secrets.accessToken,
      // The device identity the credential was minted with. Kimi ties a session
      // to it, and a probe from an unknown device is answered differently.
      extraHeaders: kimiDeviceHeaders(device),
    });
    if (!usageReadable(res.status, "kimi")) return null;
    return parseKimiUsage(parseBody(res.body), now());
  },
};

// `DeviceOAuthProvider`, not the union: consumers read `begin` and
// `needsDeviceId`, neither of which exists on the pkce arm. `oauthAdapter` is
// overloaded on the flow's `kind`, so the narrow type survives the adapter and
// this needs neither a guard nor an assertion.
export const kimiOAuth: DeviceOAuthProvider = oauthAdapter("kimi", kimiFlow, { trusted: true });
