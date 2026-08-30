import { openaiProfile } from "@omni/providers";
import type { WindowType } from "@omni/store";
import {
  type AuthHelpers,
  type AuthStep,
  oauthAdapter,
  type PluginOAuthFlow,
} from "./pluginFlow.ts";
import { getJsonRequest, parsed as parseBody, postJsonRequest } from "./requests.ts";
import {
  type FlowResult,
  type OAuthProvider,
  tokenErrorCode,
  tokenErrorMessage,
  type UsageReport,
} from "./types.ts";
import { nestedOf, numberOf, recordOf, reportFrom, usageReadable, windowFrom } from "./usage.ts";

/** Public client ID of the Codex CLI. See the note at the head of Task 20. */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const SCOPES = "openid profile email offline_access";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  idToken: string | null;
};

type IdClaims = {
  email: string | null;
  accountId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonBlankStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function accountIdFromProviderData(providerData: Record<string, unknown>): string | null {
  return nonBlankStringOrNull(providerData.accountId);
}

/**
 * Reads the claims out of an ID token.
 *
 * The signature is not verified. This token was returned over TLS by the token
 * endpoint, in response to a request this process made, so there is no third
 * party whose authorship needs proving. A malformed token degrades to no
 * claims rather than failing the connection.
 */
function decodeClaims(idToken: string | null): IdClaims {
  const parts = typeof idToken === "string" ? idToken.split(".") : [];
  const [header, payload, signature] = parts;
  if (
    parts.length !== 3 ||
    header === undefined ||
    payload === undefined ||
    signature === undefined ||
    header.length === 0 ||
    payload.length === 0 ||
    signature.length === 0
  ) {
    return { email: null, accountId: null };
  }
  try {
    const json: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isRecord(json)) return { email: null, accountId: null };
    const auth = json["https://api.openai.com/auth"];
    return {
      email: typeof json.email === "string" ? json.email : null,
      accountId: isRecord(auth) ? nonBlankStringOrNull(auth.chatgpt_account_id) : null,
    };
  } catch {
    return { email: null, accountId: null };
  }
}

function parseTokenResponse(value: unknown): TokenResponse | null {
  if (!isRecord(value) || typeof value.access_token !== "string") return null;
  return {
    accessToken: value.access_token,
    refreshToken: typeof value.refresh_token === "string" ? value.refresh_token : null,
    expiresIn: typeof value.expires_in === "number" ? value.expires_in : null,
    idToken: typeof value.id_token === "string" ? value.id_token : null,
  };
}

/**
 * The token call, as a step the host performs.
 *
 * A generator rather than a function because it yields: the flow describes the
 * request and the host sends it, so this is delegated to with `yield*` from
 * `exchange` and `refresh` exactly as it was awaited from both before.
 */
// `async function*`, not `function*`. A sync generator delegated with `yield*`
// from an async one runs, but its `TNext` widens to `AuthResponse | undefined`
// — so every field read off the response becomes possibly-undefined and the
// step stops matching `AuthStep`. Caught by the compiler, not by the tests,
// which passed either way.
async function* postToken(
  body: Record<string, string>,
  fail: AuthHelpers["fail"],
): AuthStep<TokenResponse> {
  const res = yield postJsonRequest(TOKEN_URL, openaiProfile, {
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({ ...body, client_id: CLIENT_ID }).toString(),
  });
  const parsed = parseBody(res.body);

  if (res.status < 200 || res.status >= 300) {
    throw fail(tokenErrorCode(res.status), tokenErrorMessage(res.status, parsed));
  }

  const token = parseTokenResponse(parsed);
  if (token === null) {
    throw fail("AUTH", "token endpoint returned no access_token");
  }
  return token;
}

function toResult(
  token: TokenResponse,
  fallbackRefresh: string | null,
  now: () => number,
  fallbackAccountId: string | null = null,
): FlowResult {
  const claims = decodeClaims(token.idToken);
  return {
    secrets: {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? fallbackRefresh,
      apiKey: null,
      // Kept because a later refresh may return no new id token, and the
      // account id claim is the only way to address the right workspace.
      idToken: token.idToken,
    },
    expiresAt: token.expiresIn === null ? null : now() + token.expiresIn * 1000,
    accountEmail: claims.email,
    // Consumed by the OpenAI adapter as the chatgpt-account-id header (Task 10).
    providerData: { accountId: claims.accountId ?? fallbackAccountId },
  };
}

/**
 * Reads the Codex rate-limit snapshot.
 *
 * Codex names its windows by role rather than by duration: `primary_window` is
 * the short one and `secondary_window` the long one, which on current plans are
 * the five-hour and weekly caps. Each carries `used_percent` and either a
 * `reset_at` in epoch seconds or a `reset_after_seconds` offset.
 *
 * The pair sits under a `rate_limit` object. The additional blocks the payload
 * can carry — `code_review_rate_limit`, `additional_rate_limits` — are feature
 * caps rather than the plan window the router is choosing between, so they are
 * left alone. Exported for fixture tests.
 */
/**
 * Names a window by the duration it declares, falling back to its position.
 *
 * Codex names windows by role, and the roles are not fixed to durations: a
 * `prolite` account in August 2026 reports a *weekly* allowance as
 * `primary_window` with `secondary_window` null, because that plan has no
 * five-hour cap at all. Reading position alone stamps that seven-day window
 * `fiveHour`, and the router then prices it as though it reset thirty-four
 * times sooner than it does.
 *
 * `limit_window_seconds` is the provider stating the duration outright, so it
 * wins whenever it is present. The boundaries are generous because the point is
 * to pick the closest of three names, not to validate the provider.
 */
function windowSecondsOf(value: unknown): number | null {
  const record = recordOf(value);
  if (record === null) return null;

  const seconds = numberOf(record, [
    "limit_window_seconds",
    "limitWindowSeconds",
    "window_seconds",
    "windowSeconds",
  ]);
  return seconds === null || seconds <= 0 ? null : seconds;
}

function windowTypeOf(value: unknown, fallback: WindowType): WindowType {
  const seconds = windowSecondsOf(value);
  if (seconds === null) return fallback;

  if (seconds <= 6 * 60 * 60) return "fiveHour";
  if (seconds <= 36 * 60 * 60) return "daily";
  return "weekly";
}

/**
 * The declared duration, kept rather than discarded once it has been bucketed.
 *
 * Three names cannot express the durations Codex actually reports: a three-hour
 * window becomes `fiveHour`, and anything inferring a window start from the
 * nominal five hours lands about two hours early. The bucketing is unchanged —
 * the store, router, and console are built around the three names — but the
 * number that produced it travels alongside.
 */
function windowMsOf(value: unknown): number | null {
  const seconds = windowSecondsOf(value);
  return seconds === null ? null : seconds * 1000;
}

export function parseOpenAIUsage(value: unknown, now: number): UsageReport | null {
  const root = recordOf(value);
  if (root === null) return null;
  const rateLimit = nestedOf(root, ["rate_limit", "rateLimit"]) ?? root;

  const primary = rateLimit.primary_window ?? rateLimit.primaryWindow;
  const secondary = rateLimit.secondary_window ?? rateLimit.secondaryWindow;

  return reportFrom([
    windowFrom(primary, windowTypeOf(primary, "fiveHour"), now, windowMsOf(primary)),
    windowFrom(secondary, windowTypeOf(secondary, "weekly"), now, windowMsOf(secondary)),
  ]);
}

const openaiFlow: PluginOAuthFlow = {
  kind: "pkce",
  supportsManualPaste: true,

  // biome-ignore lint/correctness/useYield: nothing to ask an endpoint for
  async *start({ redirectUri, pkce, randomState }) {
    // The host mints PKCE and the CSRF state now, so this flow holds no crypto
    // of its own. `redirectUri` is used rather than ignored, unlike Anthropic's:
    // this flow has no fixed registered value of its own, so the code lands on
    // whichever callback the caller says it is listening on.
    const { verifier, challenge } = pkce();
    const state = randomState();

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("id_token_add_organizations", "true");
    url.searchParams.set("codex_cli_simplified_flow", "true");
    url.searchParams.set("state", state);
    url.searchParams.set("originator", "codex_cli_rs");
    url.searchParams.set("prompt", "login");

    return { authorizeUrl: url.toString(), pending: { verifier, challenge, state, redirectUri } };
  },

  async *exchange({ code, pending, fail, now }) {
    const [rawCode, pastedState] = code.split("#");
    if (pastedState !== undefined && pastedState !== pending.state) {
      throw fail("AUTH", "authorization state mismatch");
    }

    const token = yield* postToken(
      {
        grant_type: "authorization_code",
        code: (rawCode ?? "").trim(),
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
      },
      fail,
    );

    return toResult(token, null, now);
  },

  async *refresh({ refreshToken, providerData, fail, now }) {
    const token = yield* postToken(
      { grant_type: "refresh_token", refresh_token: refreshToken, scope: SCOPES },
      fail,
    );
    return toResult(token, refreshToken, now, accountIdFromProviderData(providerData));
  },

  async *usage({ secrets, providerData, now }) {
    if (secrets.accessToken === null) return null;
    const accountId = accountIdFromProviderData(providerData);
    const res = yield getJsonRequest(USAGE_URL, openaiProfile, {
      accessToken: secrets.accessToken,
      // Same account selector inference sends. Without it a token that can see
      // several workspaces reads the wrong one's usage.
      ...(accountId === null ? {} : { extraHeaders: [["chatgpt-account-id", accountId]] }),
    });
    if (!usageReadable(res.status, "openai")) return null;
    return parseOpenAIUsage(parseBody(res.body), now());
  },
};

export const openaiOAuth: OAuthProvider = oauthAdapter("openai", openaiFlow, { trusted: true });
