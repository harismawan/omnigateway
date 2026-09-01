import {
  type AuthHelpers,
  type AuthStep,
  type FlowResult,
  type PkcePluginFlow,
  tokenErrorCode,
  tokenErrorMessage,
  type UsageReport,
} from "../oauthFlow.ts";
import { getJsonRequest, parsed as parseBody, postJsonRequest } from "../oauthRequests.ts";
import { nestedOf, recordOf, reportFrom, usageReadable, windowFrom } from "../oauthUsage.ts";
import { ANTHROPIC_CLI_VERSION, anthropicProfile } from "./profile.ts";

/**
 * The public OAuth client ID of the Claude CLI. Public clients cannot hold a
 * secret — this ships in a distributed binary and is protected by PKCE, not by
 * being unknown. See the note at the head of Task 20.
 */
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  account?: { email_address?: string };
};

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
  const res = yield postJsonRequest(TOKEN_URL, anthropicProfile, {
    contentType: "application/json",
    body: JSON.stringify({ ...body, client_id: CLIENT_ID }),
  });
  const parsed = parseBody(res.body);

  if (res.status < 200 || res.status >= 300) {
    throw fail(tokenErrorCode(res.status), tokenErrorMessage(res.status, parsed));
  }

  if (!isTokenResponse(parsed) || typeof parsed.access_token !== "string") {
    throw fail("AUTH", "token endpoint returned no access_token");
  }
  return parsed;
}

function isTokenResponse(value: unknown): value is TokenResponse {
  return typeof value === "object" && value !== null;
}

function toResult(
  token: TokenResponse,
  fallbackRefresh: string | null,
  now: () => number,
): FlowResult {
  return {
    secrets: {
      accessToken: token.access_token ?? null,
      // Anthropic rotates refresh tokens on some exchanges and not others.
      refreshToken: token.refresh_token ?? fallbackRefresh,
      apiKey: null,
      idToken: null,
    },
    expiresAt: typeof token.expires_in === "number" ? now() + token.expires_in * 1000 : null,
    accountEmail: token.account?.email_address ?? null,
    providerData: {},
  };
}

/**
 * Reads the subscription windows out of a usage payload.
 *
 * Anthropic reports a rolling five-hour window and a seven-day one, each with a
 * `utilization` that is the percentage *used* and a `resets_at`. Either window
 * may be absent — a plan without a weekly cap does not carry one — and the pair
 * has been seen both at the top level and under a wrapper.
 *
 * Per-model weekly windows (`seven_day_opus` and friends) are deliberately not
 * read: the router prices and picks a credential, not a credential-and-model
 * quota pair, so a window we cannot act on would only make the tightest-window
 * rule pessimistic.
 */
export function parseAnthropicUsage(value: unknown, now: number): UsageReport | null {
  const root = recordOf(value);
  if (root === null) return null;
  const source = nestedOf(root, ["usage", "rate_limits", "limits"]) ?? root;

  return reportFrom([
    windowFrom(source.five_hour ?? source.fiveHour ?? source.session, "fiveHour", now),
    windowFrom(source.seven_day ?? source.sevenDay ?? source.weekly, "weekly", now),
  ]);
}

export const anthropicOAuthFlow: PkcePluginFlow = {
  kind: "pkce",
  supportsManualPaste: true,

  // biome-ignore lint/correctness/useYield: nothing to ask an endpoint for
  async *start({ redirectUri: _ignored, pkce, randomState }) {
    // The host mints PKCE and the CSRF state now, so this flow holds no crypto
    // of its own. `redirectUri` is ignored deliberately: Anthropic's is a fixed
    // registered value, and echoing back one the caller supplied would let a
    // caller choose where the code lands.
    const { verifier, challenge } = pkce();
    const state = randomState();
    const redirectUri = REDIRECT_URI;

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);

    return { authorizeUrl: url.toString(), pending: { verifier, challenge, state, redirectUri } };
  },

  async *exchange({ code, pending, fail, now }) {
    // A manually pasted code arrives as `<code>#<state>`.
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
        state: pending.state,
      },
      fail,
    );

    return toResult(token, null, now);
  },

  async *refresh({ refreshToken, fail, now }) {
    const token = yield* postToken(
      { grant_type: "refresh_token", refresh_token: refreshToken },
      fail,
    );
    return toResult(token, refreshToken, now);
  },

  async *usage({ secrets, now }) {
    if (secrets.accessToken === null) return null;
    const res = yield getJsonRequest(USAGE_URL, anthropicProfile, {
      accessToken: secrets.accessToken,
      extraHeaders: [
        ["anthropic-beta", "oauth-2025-04-20"],
        // The CLI does not reach this endpoint through its Stainless client, so
        // it reports a different agent here than on /v1/messages. Sending the
        // inference identity to an axios-shaped endpoint is the kind of
        // mismatch that is louder than either header alone.
        ["User-Agent", `claude-code/${ANTHROPIC_CLI_VERSION}`],
      ],
    });
    if (!usageReadable(res.status, "anthropic")) return null;
    return parseAnthropicUsage(parseBody(res.body), now());
  },
};
