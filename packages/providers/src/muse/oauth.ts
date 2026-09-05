import {
  type AuthHelpers,
  type AuthStep,
  type DevicePluginFlow,
  type FlowResult,
  tokenErrorCode,
  tokenErrorMessage,
  type UsageReport,
} from "../oauthFlow.ts";
import { parsed as parseBody, postJsonRequest } from "../oauthRequests.ts";
import { numberOf, recordOf, reportFrom, usageReadable, windowFrom } from "../oauthUsage.ts";
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

/**
 * Where the operator ends up if `begin()` never got to state a URL.
 *
 * Quoted from a live `device/authorization/` response rather than guessed: the
 * verification page is under `/oauth/`, and the `/device` this first said was a
 * plausible-looking 404. Only reachable when the response omits the field, so a
 * wrong value here fails on the one path nothing else covers.
 */
const FALLBACK_VERIFICATION_URL = "https://auth.meta.com/oauth/device/";
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

/**
 * What the mint answers with, of the fifteen fields a live response carries.
 *
 * Quoted from one: `api_key`, `base_url`, `has_payment_method`,
 * `require_payment`, `is_subs_active`, `can_subscribe`, `show_subs_upsell`,
 * `user_full_name`, `user_email`, `payment_method`, `action_url`,
 * `subs_tier_id`, `subs_tier_name`, `is_subs_upgrade_available` — plus
 * `subs_usage`, which the binary's serde metadata names and which an account
 * with no active subscription does **not** receive. That absence is the normal
 * case for a pay-as-you-go key, and it reads as unknown quota rather than zero.
 */
type MintedKey = {
  apiKey: string;
  email: string | null;
  tierName: string | null;
  subscriptionActive: boolean;
  /** Where this credential's inference goes, as the mint stated it. */
  baseUrl: string | null;
  /** The subscription usage snapshot, absent unless a subscription is active. */
  usage: unknown;
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

/** Endpoints are only honoured under this registrable domain. */
const TRUSTED_HOST = "meta.ai";

/**
 * Accepts the base URL the mint states, or falls back to the compiled default.
 *
 * The mint answers `base_url: "https://api.meta.ai/v1"`, and Muse's own client
 * reads it — "unrecognized Model API base URL from login; using the default" is
 * its wording for refusing one, which is the behaviour copied here. It matters
 * because this value decides where a decrypted credential is sent, so an
 * unvalidated string from a response is a redirect of every subsequent request
 * to a host of the responder's choosing.
 *
 * `endsWith(".meta.ai")` rather than `endsWith("meta.ai")`, so `evilmeta.ai`
 * and `meta.ai.attacker.example` are both refused. `URL` has already lowercased
 * and punycoded the host by this point. Null on anything unusable, and the
 * caller falls back — an unrecognized base URL is not a reason to fail a
 * connect the operator already approved.
 */
function trustedBaseUrl(value: string | null): string | null {
  if (value === null) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (url.protocol !== "https:") return null;
  if (host !== TRUSTED_HOST && !host.endsWith(`.${TRUSTED_HOST}`)) return null;
  // Trailing slash dropped so the codec can append a path without doubling it.
  return url.toString().replace(/\/$/, "");
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
    // `"{}"`, not `""`. An empty body is refused outright — measured against
    // the live endpoint, which answers 400 "Request body is required but was
    // empty or null" and mints nothing. The object's contents are ignored;
    // what it wants is a syntactically valid one.
    body: "{}",
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
    baseUrl: trustedBaseUrl(stringFrom(record, "base_url")),
    usage: record.subs_usage,
  };
}

/**
 * One token grant plus one mint, as the credential the store holds.
 *
 * **Meta issues neither a refresh token nor an expiry**, measured: a completed
 * device grant carries `access_token` and `token_type` and nothing else, though
 * the client's own `TokenGrant` type has a `refresh_token` field. So
 * `expiresAt` is null on every muse credential, and the refresher — which wakes
 * on a non-null expiry — never runs. `refresh` below is kept because the token
 * endpoint does accept the grant, and a scope or a plan that starts issuing one
 * would make it live; it is simply unreachable today, exactly as kilo's is.
 *
 * The practical consequence is worth stating where an operator will meet it: a
 * muse account is reconnected by hand when its token dies, not renewed.
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
      // Read back by the codec, which falls back to its own constant. Stored
      // rather than re-fetched because the codec holds no client.
      ...(key.baseUrl === null ? {} : { baseUrl: key.baseUrl }),
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

  /**
   * The 5-hour and weekly windows, read off a fresh mint.
   *
   * The mint is the only endpoint that carries `subs_usage`, so the probe is a
   * mint — which was the open question, because a rotating key would be swapped
   * out from under the stored credential every poll and `usage` cannot write
   * one back. **Measured, not reasoned about**: two mints seconds apart against
   * one account returned a byte-identical `api_key`. Minting is a read of the
   * account's existing key, not an issue of a new one.
   *
   * The returned key is deliberately dropped rather than compared. `usage` has
   * no channel to persist one, so noticing a change here could only produce a
   * log line about a credential this step is powerless to repair; `refresh` is
   * where a new key is stored, and it re-mints anyway.
   *
   * `subs_usage` is **absent** on an account with no active subscription — a
   * pay-as-you-go key gets fourteen fields and no usage — so a null report is
   * the ordinary answer for those, and the account reads as unknown.
   */
  async *usage({ secrets, now }) {
    if (secrets.accessToken === null) return null;
    const res = yield postJsonRequest(MINT_URL, museProfile, {
      contentType: "application/json",
      // Same empty-object body the mint requires; see the note in `mint`.
      body: "{}",
      extraHeaders: [
        ["Authorization", `Bearer ${secrets.accessToken}`],
        ["Accept", "application/json"],
      ],
    });
    if (!usageReadable(res.status, "muse")) return null;
    const record = recordOf(parseBody(res.body));
    return record === null ? null : parseMuseUsage(record.subs_usage, now());
  },
};

/**
 * Reads Muse's subscription usage payload.
 *
 * Two windows, and the field names are the client's own: `subs_usage` holds
 * `window` — the rolling one, which states its own length in
 * `window_duration_mins` — and `weekly`. Both carry `used_percent` and
 * `resets_at`, which `windowFrom` already understands, so nothing here parses
 * counters by hand.
 *
 * `window_duration_mins` is read rather than assumed to be 300. The plans
 * document "every 5 hours" today, and `windowMs` exists precisely so a provider
 * that states a duration is not rounded to the nearest of three names — a
 * window filed under `fiveHour` but actually running three would have its start
 * inferred two hours early.
 *
 * Exported for fixture tests, as kimi's is.
 */
export function parseMuseUsage(value: unknown, now: number): UsageReport | null {
  const root = recordOf(value);
  if (root === null) return null;

  const window = recordOf(root.window);
  const mins = window === null ? null : numberOf(window, ["window_duration_mins"]);

  return reportFrom([
    windowFrom(root.window, "fiveHour", now, mins === null ? null : mins * 60_000),
    // The weekly snapshot states no duration; `weekly` already means seven days
    // to `durationFor`, so saying nothing is correct rather than lazy.
    windowFrom(root.weekly, "weekly", now),
  ]);
}
