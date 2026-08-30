import { kiloProfile } from "@omni/providers";
import {
  type AuthHelpers,
  type AuthStep,
  oauthAdapter,
  type PluginOAuthFlow,
} from "./pluginFlow.ts";
import {
  getJsonRequest,
  getJsonUnauthenticatedRequest,
  parsed as parseBody,
  postJsonRequest,
} from "./requests.ts";
import { type DeviceOAuthProvider, tokenErrorCode } from "./types.ts";

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

function deviceCodeFrom(value: unknown, fail: AuthHelpers["fail"]): DeviceCodeResponse {
  const record = recordFrom(value);
  const code = record === null ? null : stringFrom(record, "code");
  if (record === null || code === null) {
    throw fail("AUTH", "device code endpoint returned an unusable response");
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
 * disables credentials — so nothing escapes this step.
 *
 * A step rather than a plain function because it reads the profile *with* the
 * token the poll just returned: the request cannot be described until the
 * response before it has been read, which is the case the generator contract
 * exists for. Delegated to with `yield*` from `exchange`, and `async function*`
 * for the reason `postToken` in `anthropic.ts` is — a sync generator widens
 * `TNext` and every field read off the response becomes possibly-undefined.
 */
async function* orgIdFor(accessToken: string): AuthStep<string | null> {
  try {
    const res = yield getJsonRequest(PROFILE_URL, kiloProfile, { accessToken });
    if (res.status < 200 || res.status >= 300) return null;

    const record = recordFrom(parseBody(res.body));
    const organizations = record?.organizations;
    if (!Array.isArray(organizations)) return null;
    const first = recordFrom(organizations[0]);
    return first === null ? null : stringFrom(first, "id");
  } catch {
    // A timeout or a connection reset is not a verdict on the token. The host
    // raises it at the `yield`, so this stays the plain `try` it was before the
    // port rather than becoming something the flow cannot see.
    return null;
  }
}

const kiloFlow: PluginOAuthFlow = {
  kind: "device",
  supportsManualPaste: false,
  // Kilo identifies an editor, not a machine: there is no per-installation
  // identity to mint, and `begin` sends none.
  needsDeviceId: false,

  /**
   * Nothing to prepare.
   *
   * Kilo mints no client identity and needs no PKCE pair, so the whole start of
   * the flow is `begin()`'s single POST. What this returns is replaced by that
   * call and never reaches the operator.
   */
  // biome-ignore lint/correctness/useYield: there is nothing to ask an endpoint for
  async *start() {
    return {
      authorizeUrl: FALLBACK_VERIFICATION_URL,
      pending: { verifier: "", challenge: "", state: "", redirectUri: "" },
    };
  },

  /** Mints the code. Takes no device id: Kilo has no device identity. */
  async *begin({ fail, now }) {
    const res = yield postJsonRequest(CODES_URL, kiloProfile, {
      contentType: "application/json",
      body: "",
    });
    const parsed = parseBody(res.body);

    // Distinct from a generic failure because the operator can act on it: an
    // earlier authorization of theirs is still open and has to age out.
    if (res.status === 429) {
      throw fail(
        "RATE_LIMIT",
        "kilo has too many pending device authorizations; wait for one to expire and retry",
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw fail(tokenErrorCode(res.status), `kilo refused a device code: http_${res.status}`);
    }

    const response = deviceCodeFrom(parsed, fail);
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
        extra: { expiresAt: now() + response.expiresIn * 1000 },
      },
    };
  },

  /** One poll. The caller owns the loop and the deadline. */
  async *exchange({ pending, fail, keepPolling, now }) {
    const code = pending.deviceCode;
    if (code === undefined) {
      // `INTERNAL` because reaching here is a gateway bug rather than anything
      // the operator or Kilo did: only `begin()` produces a usable pending
      // flow. It goes through `fail` like every other throw, since a plain
      // `Error` out of a step reaches the host as "the flow threw" and loses
      // this sentence.
      throw fail("INTERNAL", "kilo exchange requires a pending flow produced by begin()");
    }

    const expiresAt =
      pending.extra === undefined ? null : positiveNumberFrom(pending.extra, "expiresAt");
    if (expiresAt !== null && now() >= expiresAt) {
      throw fail("AUTH", "kilo device code expired; start the authorization again");
    }

    // The poll is what earns the token; there is nothing to send yet.
    const res = yield getJsonUnauthenticatedRequest(
      `${CODES_URL}/${encodeURIComponent(code)}`,
      kiloProfile,
    );

    if (res.status === 202) throw keepPolling("http_202");
    if (res.status === 403) {
      throw fail("AUTH", "kilo authorization was denied");
    }
    if (res.status === 410) {
      throw fail("AUTH", "kilo device code expired; start the authorization again");
    }
    if (res.status < 200 || res.status >= 300) {
      throw fail(
        tokenErrorCode(res.status),
        `kilo refused the device code poll: http_${res.status}`,
      );
    }

    const record = recordFrom(parseBody(res.body));
    if (record === null) throw keepPolling("http_200");
    // Any status but "approved" is a state on the way there, not a failure.
    if (stringFrom(record, "status") !== "approved") throw keepPolling("http_200");

    const token = stringFrom(record, "token");
    if (token === null) {
      throw fail("AUTH", "kilo approved the authorization without a token");
    }

    const orgId = yield* orgIdFor(token);
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
   * Required by the contract, unreachable in practice.
   *
   * Every path that refreshes first checks for a non-null `expiresAt`, and a
   * kilo credential never has one. `AUTH` is deliberate: if some future path
   * does reach here, the credential really is unusable until the operator
   * reconnects, and `AUTH` is what records that rather than retrying forever.
   */
  // biome-ignore lint/correctness/useYield: refusing outright asks for no request
  async *refresh({ fail }) {
    throw fail(
      "AUTH",
      "kilo tokens cannot be refreshed; reconnect the kilo account to get a new one",
    );
  },

  // No `usage`. Kilo sells prepaid credit, which is not a rolling window:
  // filing a balance under a window name would have the quota poller treat
  // credit exhaustion as a cooldown that never resets. An omitted probe makes
  // the account read as unknown, which is the truth.
};

// `DeviceOAuthProvider`, not the union, for the reason kimi's export gives:
// consumers read `begin` and `needsDeviceId`, and the overload preserves them.
export const kiloOAuth: DeviceOAuthProvider = oauthAdapter("kilo", kiloFlow, { trusted: true });
