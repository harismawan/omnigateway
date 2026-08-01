import { GatewayError } from "@omni/ir";
import { type KimiDevice, kimiDeviceHeaders, mintKimiDevice, PROFILES } from "@omni/providers";
import type { AuthorizeStart, FlowResult, OAuthDeps, OAuthProvider } from "./types.ts";
import { postJson, tokenErrorMessage } from "./types.ts";

/** Public client ID of the Kimi CLI. See the note at the head of Task 20. */
const CLIENT_ID = "kimi-cli";
const DEVICE_CODE_URL = "https://www.kimi.com/api/device/code";
const TOKEN_URL = "https://www.kimi.com/api/device/token";
const DEFAULT_INTERVAL_SECONDS = 5;

/** Errors that mean "keep polling" rather than "this flow failed". */
const PENDING_ERRORS = new Set(["authorization_pending", "slow_down"]);
const PENDING_MARKER = "__omni_authorization_pending";

type MarkedPendingError = GatewayError & { [PENDING_MARKER]?: boolean };
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

export function isAuthorizationPending(error: unknown): boolean {
  return error instanceof GatewayError && (error as MarkedPendingError)[PENDING_MARKER] === true;
}

function pendingError(code: string): GatewayError {
  const error = new GatewayError(
    "AUTH",
    `authorization not yet complete: ${code}`,
  ) as MarkedPendingError;
  error[PENDING_MARKER] = true;
  return error;
}

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
    verificationUri: stringFrom(record, "verification_uri") ?? "https://www.kimi.com/device",
    interval: positiveNumberFrom(record, "interval") ?? DEFAULT_INTERVAL_SECONDS,
  };
}

async function post(
  url: string,
  body: Record<string, string>,
  device: KimiDevice,
  deps: OAuthDeps,
): Promise<unknown> {
  const { status, parsed } = await postJson(deps, url, PROFILES.kimi, {
    contentType: "application/json",
    body: JSON.stringify({ ...body, client_id: CLIENT_ID }),
    extraHeaders: kimiDeviceHeaders(device),
  });

  if (status >= 200 && status < 300) return parsed;

  const record = recordFrom(parsed);
  const code =
    record === null ? `http_${status}` : (stringFrom(record, "error") ?? `http_${status}`);
  if (PENDING_ERRORS.has(code)) throw pendingError(code);
  throw new GatewayError("AUTH", tokenErrorMessage(status, parsed));
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

export const kimiOAuth: OAuthProvider = {
  id: "kimi",
  kind: "device",
  supportsManualPaste: false,

  start() {
    const device = mintKimiDevice();
    return {
      authorizeUrl: "https://www.kimi.com/device",
      pending: { verifier: "", challenge: "", state: "", redirectUri: "", extra: { ...device } },
    };
  },

  async begin({ deviceId }, deps): Promise<AuthorizeStart> {
    if (deviceId.trim().length === 0) {
      throw new Error("kimi begin requires a non-blank deviceId");
    }
    const device = deviceForBegin(deviceId);
    const response = deviceCodeFrom(
      await post(DEVICE_CODE_URL, { device_id: device.deviceId }, device, deps),
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
};
