import { GatewayError } from "@omni/ir";
import { PROFILES } from "@omni/providers";
import type { AuthorizeStart, FlowResult, OAuthDeps, OAuthProvider } from "./types.ts";
import { getJson, pendingError, postJson, tokenErrorCode } from "./types.ts";

/**
 * Kilo's device-code flow, which is not RFC 8628.
 *
 * There is no `client_id`, no form encoding, and no token endpoint: a POST
 * mints a code, a GET on that code answers with an HTTP status until the
 * operator approves, and approval hands back a bare token. Every constant here
 * is quoted from two independent third-party clients that talk to the live
 * service — Kilo publishes no reference for it. See the design's *Sources*.
 */
const CODES_URL = "https://api.kilo.ai/api/device-auth/codes";
const PROFILE_URL = "https://api.kilo.ai/api/profile";
/** Where the operator ends up if `begin()` never got to state a URL. */
const FALLBACK_VERIFICATION_URL = "https://kilo.ai";
const DEFAULT_EXPIRES_SECONDS = 300;
const POLL_INTERVAL_SECONDS = 3;

type DeviceCodeResponse = {
  /** Kilo's one code is both the poll handle and what the operator reads. */
  code: string;
  verificationUrl: string;
  expiresIn: number;
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

function deviceCodeFrom(value: unknown): DeviceCodeResponse {
  const record = recordFrom(value);
  const code = record === null ? null : stringFrom(record, "code");
  if (record === null || code === null) {
    throw new GatewayError("AUTH", "device code endpoint returned an unusable response");
  }
  return {
    code,
    verificationUrl: stringFrom(record, "verificationUrl") ?? FALLBACK_VERIFICATION_URL,
    expiresIn: positiveNumberFrom(record, "expiresIn") ?? DEFAULT_EXPIRES_SECONDS,
  };
}

/**
 * The organization the credential bills to, or nothing.
 *
 * Best-effort by construction: an account with no organization is normal, and
 * a failed read here must not fail a connect the operator already approved in
 * their browser. It must never be reported as `AUTH` either — that code
 * disables credentials — so nothing escapes this function.
 */
async function orgIdFor(accessToken: string, deps: OAuthDeps): Promise<string | null> {
  try {
    const { status, parsed } = await getJson(deps, "kilo", PROFILE_URL, PROFILES.kilo, {
      accessToken,
    });
    if (status < 200 || status >= 300) return null;

    const record = recordFrom(parsed);
    const organizations = record?.organizations;
    if (!Array.isArray(organizations)) return null;
    const first = recordFrom(organizations[0]);
    return first === null ? null : stringFrom(first, "id");
  } catch {
    // A timeout or a connection reset is not a verdict on the token.
    return null;
  }
}

export const kiloOAuth: OAuthProvider = {
  id: "kilo",
  kind: "device",
  supportsManualPaste: false,

  /**
   * Nothing to prepare.
   *
   * Kilo mints no client identity and needs no PKCE pair, so the whole start of
   * the flow is `begin()`'s single POST. What this returns is replaced by that
   * call and never reaches the operator.
   */
  start() {
    return {
      authorizeUrl: FALLBACK_VERIFICATION_URL,
      pending: { verifier: "", challenge: "", state: "", redirectUri: "" },
    };
  },

  /** Mints the code. Takes no device id: Kilo has no device identity. */
  async begin(_opts, deps): Promise<AuthorizeStart> {
    const { status, parsed } = await postJson(deps, "kilo", CODES_URL, PROFILES.kilo, {
      contentType: "application/json",
      body: "",
    });

    // Distinct from a generic failure because the operator can act on it: an
    // earlier authorization of theirs is still open and has to age out.
    if (status === 429) {
      throw new GatewayError(
        "RATE_LIMIT",
        "kilo has too many pending device authorizations; wait for one to expire and retry",
      );
    }
    if (status < 200 || status >= 300) {
      throw new GatewayError(tokenErrorCode(status), `kilo refused a device code: http_${status}`);
    }

    const response = deviceCodeFrom(parsed);
    return {
      authorizeUrl: response.verificationUrl,
      userCode: response.code,
      pending: {
        verifier: "",
        challenge: "",
        state: "",
        redirectUri: "",
        deviceCode: response.code,
        interval: POLL_INTERVAL_SECONDS,
        // Kilo answers 410 once the code lapses, but the caller's poll loop
        // should not need a round trip to learn what it already knows.
        extra: { expiresAt: deps.now() + response.expiresIn * 1000 },
      },
    };
  },

  /** One poll. The caller owns the loop and the deadline. */
  async exchange({ pending }, deps): Promise<FlowResult> {
    const code = pending.deviceCode;
    if (code === undefined) {
      throw new Error("kilo exchange requires a pending flow produced by begin()");
    }

    const expiresAt =
      pending.extra === undefined ? null : positiveNumberFrom(pending.extra, "expiresAt");
    if (expiresAt !== null && deps.now() >= expiresAt) {
      throw new GatewayError("AUTH", "kilo device code expired; start the authorization again");
    }

    const { status, parsed } = await getJson(
      deps,
      "kilo",
      `${CODES_URL}/${encodeURIComponent(code)}`,
      PROFILES.kilo,
      // The poll is what earns the token; there is nothing to send yet.
      { accessToken: null },
    );

    if (status === 202) throw pendingError("http_202");
    if (status === 403) {
      throw new GatewayError("AUTH", "kilo authorization was denied");
    }
    if (status === 410) {
      throw new GatewayError("AUTH", "kilo device code expired; start the authorization again");
    }
    if (status < 200 || status >= 300) {
      throw new GatewayError(
        tokenErrorCode(status),
        `kilo refused the device code poll: http_${status}`,
      );
    }

    const record = recordFrom(parsed);
    if (record === null) throw pendingError("http_200");
    // Any status but "approved" is a state on the way there, not a failure.
    if (stringFrom(record, "status") !== "approved") throw pendingError("http_200");

    const token = stringFrom(record, "token");
    if (token === null) {
      throw new GatewayError("AUTH", "kilo approved the authorization without a token");
    }

    const orgId = await orgIdFor(token, deps);
    return {
      secrets: {
        accessToken: token,
        // Kilo issues neither a refresh token nor an expiry. Recording anything
        // else here would have the scheduler chase a refresh that cannot work.
        refreshToken: null,
        apiKey: null,
        idToken: null,
      },
      expiresAt: null,
      accountEmail: stringFrom(record, "userEmail"),
      providerData: orgId === null ? {} : { orgId },
    };
  },

  /**
   * Required by the interface, unreachable in practice.
   *
   * Every path that refreshes first checks for a non-null `expiresAt`, and a
   * kilo credential never has one. `AUTH` is deliberate: if some future path
   * does reach here, the credential really is unusable until the operator
   * reconnects, and `AUTH` is what records that rather than retrying forever.
   */
  async refresh(): Promise<FlowResult> {
    throw new GatewayError(
      "AUTH",
      "kilo tokens cannot be refreshed; reconnect the kilo account to get a new one",
    );
  },

  // No `usage`. Kilo sells prepaid credit, which is not a rolling window:
  // filing a balance under a window name would have the quota poller treat
  // credit exhaustion as a cooldown that never resets. An omitted probe makes
  // the account read as unknown, which is the truth.
};
