import {
  type AuthHelpers,
  type AuthStep,
  type DevicePluginFlow,
  type FlowResult,
  tokenErrorCode,
  tokenErrorMessage,
} from "../oauthFlow.ts";
import { parsed as parseBody, postJsonRequest } from "../oauthRequests.ts";
import { museProfile } from "./profile.ts";

/**
 * Muse Code's device flow, and the key mint that follows it.
 *
 * Two stages, which is what makes this flow unlike the other four. RFC 8628
 * against `auth.meta.com` earns an access token, and that token is then spent
 * at `muse-code/key` for a **Model API key** — which is what the inference host
 * actually accepts. So `exchange` and `refresh` both end in a mint, and the
 * credential carries all three secrets: the OAuth pair for renewing, and the
 * minted key for every request.
 *
 * Every constant here is read out of Muse's own shipped client: the endpoints,
 * client id and grant type from the launcher shell script served at
 * `api.meta.ai/muse-launcher.sh`, and the mint path and its response shape from
 * the release binary whose sha256 matches the published manifest. Meta
 * publishes no reference for any of it.
 */
const AUTH_BASE = "https://auth.meta.com";
const DEVICE_CODE_URL = `${AUTH_BASE}/oidc/device/authorization/`;
const TOKEN_URL = `${AUTH_BASE}/oidc/device/token/`;
const MINT_URL = "https://api.meta.ai/muse-code/key";

/**
 * Public client id of Muse Code itself. A public client holds no secret — this
 * ships in a shell script anyone can curl, and the device flow is protected by
 * the user's approval at the verification page, not by the id being unknown.
 */
const CLIENT_ID = "1031625952748946";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** Where the operator ends up if `begin()` never got to state a URL. */
const FALLBACK_VERIFICATION_URL = "https://auth.meta.com/device";
const DEFAULT_INTERVAL_SECONDS = 5;

/** Errors that mean "keep polling" rather than "this flow failed". */
const PENDING_ERRORS = new Set(["authorization_pending", "slow_down"]);

type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
};

type DeviceCodeResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
};

/** What the mint answers with, of the fourteen fields it sends. */
type MintedKey = {
  apiKey: string;
  email: string | null;
  tierName: string | null;
  subscriptionActive: boolean;
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
  const accessToken = record === null ? null : stringFrom(record, "access_token");
  if (record === null || accessToken === null) {
    throw fail("AUTH", "token endpoint returned no access_token");
  }
  return {
    accessToken,
    refreshToken: stringFrom(record, "refresh_token"),
    expiresIn: positiveNumberFrom(record, "expires_in"),
  };
}

function deviceCodeFrom(value: unknown, fail: AuthHelpers["fail"]): DeviceCodeResponse {
  const record = recordFrom(value);
  const deviceCode = record === null ? null : stringFrom(record, "device_code");
  const userCode = record === null ? null : stringFrom(record, "user_code");
  if (record === null || deviceCode === null || userCode === null) {
    // The client's own wording for this case, which names the two fields.
    throw fail("AUTH", "device authorization response missing user_code or verification_uri");
  }
  return {
    deviceCode,
    userCode,
    // `verification_uri_complete` embeds the code, so the operator approves in
    // one click. The bare uri is the fallback, and a constant behind that.
    verificationUri:
      stringFrom(record, "verification_uri_complete") ??
      stringFrom(record, "verification_uri") ??
      FALLBACK_VERIFICATION_URL,
    interval: positiveNumberFrom(record, "interval") ?? DEFAULT_INTERVAL_SECONDS,
  };
}

/**
 * The form POST both auth endpoints take, as a step the host performs.
 *
 * `async function*`, not `function*`. A sync generator delegated with `yield*`
 * from an async one runs, but its `TNext` widens to `AuthResponse | undefined`
 * — so every field read off the response becomes possibly-undefined and the
 * step stops matching `AuthStep`.
 */
async function* postForm(
  url: string,
  body: Record<string, string>,
  fail: AuthHelpers["fail"],
  keepPolling: AuthHelpers["keepPolling"],
): AuthStep<unknown> {
  // Form-encoded with no client_secret, exactly as the launcher sends it: a
  // public client has none. The profile carries `x-api-version`, which the
  // client sends on these calls and which is why it is a profile header rather
  // than something added here.
  const res = yield postJsonRequest(url, museProfile, {
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({ ...body, client_id: CLIENT_ID }).toString(),
    // These endpoints answer JSON; the profile asks for SSE because every
    // inference request does, and asking for it here would be a lie upstream is
    // entitled to act on.
    extraHeaders: [["Accept", "application/json"]],
  });
  const parsed = parseBody(res.body);

  if (res.status >= 200 && res.status < 300) return parsed;

  const record = recordFrom(parsed);
  const code =
    record === null ? `http_${res.status}` : (stringFrom(record, "error") ?? `http_${res.status}`);
  // `keepPolling` rather than a marker of our own: the "not approved yet"
  // signal carries a private marker only the host can set. `slow_down` is in
  // the set for the same reason `authorization_pending` is — the host owns the
  // loop, and widening its interval is its decision to make.
  if (PENDING_ERRORS.has(code)) throw keepPolling(code);
  if (code === "expired_token") {
    throw fail("AUTH", "muse device code expired; start the authorization again");
  }
  throw fail(tokenErrorCode(res.status), tokenErrorMessage(res.status, parsed));
}

/**
 * Spends the OAuth token on a Model API key.
 *
 * This is the half that makes a subscription usable: `api.meta.ai/v1/responses`
 * does not accept the device-flow token, and the client mints a key at startup
 * for exactly that reason.
 *
 * The three refusals below are `AUTH` deliberately, and `AUTH` disables the
 * credential — which is right for all three. An account with no payment method
 * or no Model API onboarding cannot serve a request no matter how often the
 * gateway retries, and leaving it enabled means every routed request fails
 * upstream instead of the account being visibly parked. Each carries the
 * client's own sentence, because the operator's next step is on Meta's site and
 * a generic "auth failed" does not say so.
 */
async function* mint(accessToken: string, fail: AuthHelpers["fail"]): AuthStep<MintedKey> {
  const res = yield postJsonRequest(MINT_URL, museProfile, {
    contentType: "application/json",
    body: "",
    extraHeaders: [
      ["Authorization", `Bearer ${accessToken}`],
      ["Accept", "application/json"],
    ],
  });
  const parsed = parseBody(res.body);

  if (res.status < 200 || res.status >= 300) {
    if (res.status === 401 || res.status === 403) {
      throw fail(
        "AUTH",
        "muse rejected the saved login; reconnect the account or use a different one",
      );
    }
    throw fail(tokenErrorCode(res.status), tokenErrorMessage(res.status, parsed));
  }

  const record = recordFrom(parsed);
  if (record === null) {
    throw fail("UPSTREAM", "muse key mint returned an unusable response");
  }

  if (record.require_payment === true) {
    throw fail(
      "AUTH",
      "muse requires a payment method on the Meta account; add one at https://dev.meta.ai and reconnect",
    );
  }

  const apiKey = stringFrom(record, "api_key");
  if (apiKey === null) {
    // The client's own wording. Distinct from a malformed body: a 200 with no
    // key is what an account that has not finished Model API onboarding gets.
    throw fail(
      "AUTH",
      "muse key mint returned an empty api key; finish onboarding at https://dev.meta.ai and reconnect",
    );
  }

  return {
    apiKey,
    email: stringFrom(record, "user_email"),
    tierName: stringFrom(record, "subs_tier_name"),
    subscriptionActive: record.is_subs_active === true,
  };
}

/**
 * One token grant plus one mint, as the credential the store holds.
 *
 * `expiresAt` is the **OAuth** token's, not the minted key's, whose lifetime
 * Meta states nowhere. That is the conservative pairing rather than a
 * compromise: the refresher wakes on this expiry, and every refresh re-mints,
 * so the key is replaced at least as often as the token that bought it.
 */
function toResult(
  token: TokenResponse,
  key: MintedKey,
  fallbackRefresh: string | null,
  now: () => number,
): FlowResult {
  return {
    secrets: {
      accessToken: token.accessToken,
      // A refresh response may omit `refresh_token`, meaning "keep using the
      // one you have". Reading that omission as null would destroy a working
      // credential on its first refresh and force a reconnect by hand.
      refreshToken: token.refreshToken ?? fallbackRefresh,
      apiKey: key.apiKey,
      idToken: null,
    },
    expiresAt: token.expiresIn === null ? null : now() + token.expiresIn * 1000,
    accountEmail: key.email,
    // Recorded for the console, never read back on the request path — the
    // codec authenticates with the key alone. `subscriptionActive` false is a
    // real state: a lapsed subscription still mints a key that bills per token.
    providerData: {
      ...(key.tierName === null ? {} : { subscriptionTier: key.tierName }),
      subscriptionActive: key.subscriptionActive,
    },
  };
}

export const museOAuthFlow: DevicePluginFlow = {
  kind: "device",
  supportsManualPaste: false,
  // Muse mints no client identity: the launcher sends `client_id` and nothing
  // else, and no request on any leg carries a per-installation fingerprint.
  needsDeviceId: false,

  /**
   * Nothing to prepare.
   *
   * No PKCE pair and no client identity, so the whole start of the flow is
   * `begin()`'s single POST. What this returns is replaced by that call and
   * never reaches the operator.
   */
  // biome-ignore lint/correctness/useYield: there is nothing to ask an endpoint for
  async *start() {
    return {
      authorizeUrl: FALLBACK_VERIFICATION_URL,
      pending: { verifier: "", challenge: "", state: "", redirectUri: "" },
    };
  },

  /** Mints the device code. Takes no device id: Muse has no device identity. */
  async *begin({ fail, keepPolling }) {
    const response = deviceCodeFrom(yield* postForm(DEVICE_CODE_URL, {}, fail, keepPolling), fail);
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
      },
    };
  },

  /** One poll, then the mint. The caller owns the loop and the deadline. */
  async *exchange({ pending, fail, keepPolling, now }) {
    if (pending.deviceCode === undefined) {
      // `INTERNAL` through `fail`, never a bare `Error`: an arbitrary throw
      // reaches the operator as the host's "muse oauth exchange threw", which
      // names neither the missing device code nor that this is a gateway bug.
      throw fail("INTERNAL", "muse exchange requires a pending flow produced by begin()");
    }

    const token = tokenFrom(
      yield* postForm(
        TOKEN_URL,
        { grant_type: DEVICE_CODE_GRANT, device_code: pending.deviceCode },
        fail,
        keepPolling,
      ),
      fail,
    );
    // Only reached once the operator has approved, so a mint failure here is a
    // fact about the account rather than a step still in progress.
    return toResult(token, yield* mint(token.accessToken, fail), null, now);
  },

  async *refresh({ refreshToken, fail, keepPolling, now }) {
    const token = tokenFrom(
      yield* postForm(
        TOKEN_URL,
        { grant_type: "refresh_token", refresh_token: refreshToken },
        fail,
        keepPolling,
      ),
      fail,
    );
    return toResult(token, yield* mint(token.accessToken, fail), refreshToken, now);
  },

  // No `usage`, and this is a gap rather than a decision about Muse.
  //
  // The mint response carries `subs_usage`, so the data exists and arrives on a
  // call this flow already makes. What is missing is its shape: the field is
  // deserialized into a generic value in the shipped binary, so no field names
  // survive as readable strings, and `WindowType` has no `monthly` member for
  // what is sold as a monthly subscription. Filing a month under `weekly` would
  // have `spanStartOf` infer a window start three weeks late and draw a chart
  // of readings that never happened.
  //
  // An omitted probe makes the account read as *unknown*, which is the truth.
  // One real mint response is all this needs — map it through `windowFrom` and
  // state the duration in `windowMs`.
};
