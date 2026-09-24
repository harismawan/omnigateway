import type { ErrorCode } from "@omni/ir";
import {
  type AuthHelpers,
  type AuthStep,
  type FlowResult,
  type PkcePluginFlow,
  type ResetCredit,
  type ResetCredits,
  type ResetRedeemed,
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

  async *resetCredits({ secrets }) {
    if (secrets.accessToken === null) return null;
    const res = yield getJsonRequest(RESET_STATUS_URL, anthropicProfile, {
      accessToken: secrets.accessToken,
      extraHeaders: SIDE_HEADERS,
    });
    if (!usageReadable(res.status, "anthropic")) return null;
    const root = recordOf(parseBody(res.body));
    // No block at all is "not enrolled", which is an empty list, not unreadable.
    return root === null ? null : parseResetGrants(root.cedar_ember ?? null);
  },

  async *redeemReset({ secrets, creditId, requestId, fail }) {
    if (secrets.accessToken === null) throw fail("AUTH", "credential holds no access token");
    const grantId = grantOf(creditId);
    if (grantId === null) throw fail("CONFLICT", "that reset credit is not available");
    // The claim is addressed to the organisation, which the token does not
    // carry; the CLI reads it from the profile the same way.
    const profile = yield getJsonRequest(PROFILE_URL, anthropicProfile, {
      accessToken: secrets.accessToken,
      extraHeaders: SIDE_HEADERS,
    });
    if (profile.status < 200 || profile.status >= 300) {
      throw fail(redeemErrorCode(profile.status), `profile read refused: http_${profile.status}`, {
        status: profile.status,
      });
    }
    const orgId = orgIdOf(parseBody(profile.body));
    if (orgId === null) throw fail("UPSTREAM", "profile names no organization");

    const res = yield postJsonRequest(
      `https://api.anthropic.com/api/organizations/${orgId}/reset_rate_limits`,
      anthropicProfile,
      {
        contentType: "application/json",
        body: JSON.stringify({ program: RESET_PROGRAM, grant_id: grantId, request_id: requestId }),
        extraHeaders: [["Authorization", `Bearer ${secrets.accessToken}`], ...SIDE_HEADERS],
      },
    );
    if (res.status < 200 || res.status >= 300) {
      // Status only, never the body: this text reaches the operator's log.
      throw fail(redeemErrorCode(res.status), `reset claim refused: http_${res.status}`, {
        status: res.status,
      });
    }
    return claimOutcome(parseBody(res.body), fail);
  },
};

/**
 * Anthropic's banked-reset program, as the Claude CLI names it. Status rides a
 * flagged read of the usage endpoint; the claim is per organisation.
 * Undocumented; shapes below are the CLI's own validation schema.
 */
const RESET_PROGRAM = "cedar_ember";
const RESET_STATUS_URL = `${USAGE_URL}?cedar_ember=1&skip_spend=1`;
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
/** The CLI checks both before sending; so does this, so a bad id never reaches the wire. */
const ORG_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The reset calls wear the profile's own inference identity: the server
 * derives the program's `surface` from the User-Agent, and answers
 * `ineligible_reason: "surface"` to the usage probe's `claude-code/<v>`
 * (measured live). Only the OAuth beta is added.
 */
const SIDE_HEADERS: [string, string][] = [["anthropic-beta", "oauth-2025-04-20"]];

/**
 * A grant keeps its id across uses, so the credit id also names which use:
 * `<grant>-u<uses left>`. After a spend the list shows the next use under a new
 * id, so a repeated submission of the old one is refused as not available
 * instead of spending again.
 */
const USE_SUFFIX = /-u(\d+)$/;

function creditIdOf(grantId: string, left: number): string {
  return `${grantId}-u${left}`;
}

function grantOf(creditId: string): string | null {
  const grant = creditId.replace(USE_SUFFIX, "");
  return grant === creditId || grant === "" ? null : grant;
}

function orgIdOf(value: unknown): string | null {
  const org = recordOf(recordOf(value)?.organization);
  const uuid = org?.uuid;
  return typeof uuid === "string" && ORG_ID.test(uuid) ? uuid : null;
}

/**
 * Maps the `cedar_ember` status block to credits.
 *
 * A grant holds `resets_left` uses. It is `available` only when the server
 * would take it now: usable, unpaused, with uses left, and — when the server
 * names one — the `next_grant_id`, since claiming any other is refused as
 * `not_next_grant`, and, for a grant that `use_requires_limit`, only while the
 * account is `at_limit` (else `not_limited`). `null` block means not enrolled:
 * an empty list; a block without a `grants` array is unreadable, not empty.
 */
export function parseResetGrants(value: unknown): ResetCredits | null {
  if (value === null) return { available: 0, credits: [] };
  const block = recordOf(value);
  if (block === null || !Array.isArray(block.grants)) return null;
  const next = typeof block.next_grant_id === "string" ? block.next_grant_id : null;
  const atLimit = block.at_limit === true;
  let available = 0;
  const credits: ResetCredit[] = block.grants.flatMap((raw: unknown) => {
    const g = recordOf(raw);
    if (g === null || typeof g.id !== "string") return [];
    const left = typeof g.resets_left === "number" ? g.resets_left : 0;
    const claimable =
      left > 0 &&
      g.usable_now === true &&
      g.paused !== true &&
      (g.use_requires_limit !== true || atLimit) &&
      (next === null || next === g.id);
    if (claimable) available += left;
    return [
      {
        id: creditIdOf(g.id, left),
        status: claimable ? "available" : left > 0 ? "unavailable" : "used",
        title: typeof g.label === "string" && g.label !== "" ? g.label : null,
        grantedAt: isoOrNull(g.starts_at),
        expiresAt: isoOrNull(g.ends_at),
      },
    ];
  });
  return { available, credits };
}

/**
 * A 200 is not a reset here: the body says what happened. Only `reset` is
 * success; every other result is a refusal the operator can read.
 */
function claimOutcome(value: unknown, fail: AuthHelpers["fail"]): ResetRedeemed {
  const body = recordOf(value);
  const result = typeof body?.result === "string" ? body.result : null;
  if (result === "reset") {
    return { windowsReset: Array.isArray(body?.cleared) ? body.cleared.length : null };
  }
  if (result === "cooldown") throw fail("RATE_LIMIT", "reset claim refused: cooldown");
  if (result === "already_used" || result === "not_limited" || result === "ineligible") {
    throw fail("CONFLICT", `reset claim refused: ${result}`);
  }
  // "unavailable", or a shape this gateway does not know: the spend is unknown.
  throw fail("UPSTREAM", "reset claim answered without a reset");
}

function redeemErrorCode(status: number): ErrorCode {
  if (status === 429) return "RATE_LIMIT";
  if (status === 401 || status === 403) return "AUTH";
  if (status >= 400 && status < 500) return "CONFLICT";
  return "UPSTREAM";
}

function isoOrNull(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}
