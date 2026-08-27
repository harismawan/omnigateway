import { GatewayError } from "@omni/ir";
import { type KimiDevice, kimiDeviceHeaders, kimiProfile, mintKimiDevice } from "@omni/providers";
import type {
  AuthorizeStart,
  DeviceOAuthProvider,
  FlowResult,
  OAuthDeps,
  UsageReport,
} from "./types.ts";
import { getJson, pendingError, postJson, tokenErrorCode, tokenErrorMessage } from "./types.ts";
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

function tokenFrom(value: unknown): TokenResponse {
  const record = recordFrom(value);
  if (record === null) {
    throw new GatewayError("AUTH", "token endpoint returned no access_token");
  }
  const accessToken = stringFrom(record, "access_token");
  if (accessToken === null) {
    throw new GatewayError("AUTH", "token endpoint returned no access_token");
  }
  return {
    accessToken,
    refreshToken: stringFrom(record, "refresh_token"),
    expiresIn: positiveNumberFrom(record, "expires_in"),
    email: stringFrom(record, "email"),
  };
}

function deviceCodeFrom(value: unknown): DeviceCodeResponse {
  const record = recordFrom(value);
  if (record === null) {
    throw new GatewayError("AUTH", "device code endpoint returned an unusable response");
  }
  const deviceCode = stringFrom(record, "device_code");
  const userCode = stringFrom(record, "user_code");
  if (deviceCode === null || userCode === null) {
    throw new GatewayError("AUTH", "device code endpoint returned an unusable response");
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

async function post(
  url: string,
  body: Record<string, string>,
  device: KimiDevice,
  deps: OAuthDeps,
): Promise<unknown> {
  const { status, parsed } = await postJson(deps, "kimi", url, kimiProfile, {
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({ ...body, client_id: CLIENT_ID }).toString(),
    extraHeaders: kimiDeviceHeaders(device),
  });

  if (status >= 200 && status < 300) return parsed;

  const record = recordFrom(parsed);
  const code =
    record === null ? `http_${status}` : (stringFrom(record, "error") ?? `http_${status}`);
  if (PENDING_ERRORS.has(code)) throw pendingError(code);
  throw new GatewayError(tokenErrorCode(status), tokenErrorMessage(status, parsed));
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
  deps: OAuthDeps,
): FlowResult {
  return {
    secrets: {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? fallbackRefresh,
      apiKey: null,
      idToken: null,
    },
    expiresAt: token.expiresIn === null ? null : deps.now() + token.expiresIn * 1000,
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

export const kimiOAuth: DeviceOAuthProvider = {
  id: "kimi",
  kind: "device",
  // Kimi ties the session to the fingerprint `start` mints and sends it on
  // every later call; a blank one is refused upstream as a malformed device.
  needsDeviceId: true,
  supportsManualPaste: false,

  start() {
    const device = mintKimiDevice();
    return {
      authorizeUrl: "https://www.kimi.com/device",
      pending: { verifier: "", challenge: "", state: "", redirectUri: "", extra: { ...device } },
    };
  },

  async begin({ deviceId }, deps): Promise<AuthorizeStart> {
    // Kept as a backstop, not as the primary check: `needsDeviceId: true` is
    // what `connect.ts`'s `deviceIdFrom` reads, and no flow that goes through
    // it can arrive here blank. `begin` is exported on `OAUTH_PROVIDERS`
    // though, so it is reachable without that flow, and a fingerprint is
    // kimi's own requirement rather than something to look up elsewhere.
    //
    // `INTERNAL`, not a bare `Error`, and the same code the shared check
    // raises: an unclassified throw is rewritten to the flat "internal error"
    // by `apiErrorResponse`, so the operator reads a 500 with no hint of which
    // half of the flow broke.
    if (deviceId.trim().length === 0) {
      throw new GatewayError("INTERNAL", "kimi begin requires a non-blank deviceId");
    }
    const device = deviceForBegin(deviceId);
    const response = deviceCodeFrom(await post(DEVICE_CODE_URL, {}, device, deps));
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
  async exchange({ pending }, deps) {
    if (pending.deviceCode === undefined) {
      throw new Error("kimi exchange requires a pending flow produced by begin()");
    }
    const device = deviceFrom(pending.extra);
    const token = tokenFrom(
      await post(
        TOKEN_URL,
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: pending.deviceCode,
          device_id: device.deviceId,
        },
        device,
        deps,
      ),
    );
    return toResult(token, device, null, deps);
  },

  async refresh(refreshToken, deps, providerData) {
    const device = deviceFrom(providerData);
    const token = tokenFrom(
      await post(
        TOKEN_URL,
        { grant_type: "refresh_token", refresh_token: refreshToken, device_id: device.deviceId },
        device,
        deps,
      ),
    );
    return toResult(token, device, refreshToken, deps);
  },

  async usage(secrets, deps, providerData) {
    if (secrets.accessToken === null) return null;
    const device = deviceFrom(providerData);
    const { status, parsed } = await getJson(deps, "kimi", USAGE_URL, kimiProfile, {
      accessToken: secrets.accessToken,
      // The device identity the credential was minted with. Kimi ties a session
      // to it, and a probe from an unknown device is answered differently.
      extraHeaders: kimiDeviceHeaders(device),
    });
    if (!usageReadable(status, "kimi")) return null;
    return parseKimiUsage(parsed, deps.now());
  },
};
