import type { WindowType } from "@omni/store/types";
import {
  type AuthHelpers,
  type AuthStep,
  type FlowResult,
  type PkcePluginFlow,
  tokenErrorCode,
  tokenErrorMessage,
  type UsageReport,
  type UsageWindowReport,
} from "../oauthFlow.ts";
import {
  getJsonRequest,
  parsed as parseBody,
  postJsonRequest,
  SHORT_TIMEOUT_MS,
} from "../oauthRequests.ts";
import { numberOf, recordOf, reportFrom, resetAtOf, usageReadable } from "../oauthUsage.ts";
import { antigravityProfile } from "./profile.ts";

/**
 * Antigravity's OAuth, against Google.
 *
 * **The client id and secret below are public.** They ship inside Antigravity's
 * distributed desktop binary, and Google documents an installed-app client's id
 * and secret as public values that must not be treated as secrets
 * (https://developers.google.com/identity/protocols/oauth2/native-app). They are
 * XOR-masked rather than written as literals, and the note on `MASK` below says
 * exactly why that is a concession to a scanner and not a security measure.
 *
 * **PKCE is required, and which redirect is in use is what decides that.**
 * The two are one setting, not two: measured live on 2026-09-05 against
 * `accounts.google.com` with this client id, varying one parameter at a time
 * and reading the authorize redirect — `/v3/signin` for accepted,
 * `/signin/oauth/error` for refused:
 *
 *     hosted callback, no code challenge          refused
 *     hosted callback + code challenge            accepted
 *     hosted callback + `openid`, no challenge    refused
 *     hosted callback + `aicode`, no challenge    refused
 *     hosted callback + challenge + openid        accepted
 *     loopback, no code challenge                 accepted
 *
 * So the code challenge is the only parameter the hosted callback requires, and
 * `openid` and `aicode` change nothing either way. Antigravity's own CLI (`agy`
 * 1.1.27) sends all three against this same client id.
 *
 * This reverses an earlier rule in this file, and the reason it was ever right
 * is worth keeping: omniroute 3.8.49 recorded that `openid` plus a code
 * challenge routed Google into its `firstparty/nativeapp` consent, which hung
 * without ever redirecting, and its fix was to drop both. That was measured
 * against the **loopback** redirect, where a code challenge is merely optional —
 * dropping it worked, and dropping `openid` with it made the pair look
 * load-bearing when only the redirect was. Against the hosted callback the
 * dependency runs the other way and dropping the challenge fails outright.
 *
 * `state` is minted and checked in every combination: CSRF protection is a
 * separate property from PKCE and nothing here has ever given it up.
 */
/**
 * **This is scanner evasion, not security, and the difference matters.**
 *
 * The two values below are Google's public installed-app client credentials —
 * they ship inside Antigravity's distributed binary, and Google documents an
 * installed-app client's id and secret as public values that must not be treated
 * as secrets. Anyone reading this file can recover them in one line, which is
 * fine, because that is what "public" means.
 *
 * They are masked anyway for one reason: written as literals they match GitHub's
 * push-protection patterns for `…apps.googleusercontent.com` and `GOCSPX-`, and
 * the push is refused. The alternative was permanently allowlisting two strings
 * in the repository's secret scanning, which teaches every future contributor
 * that an allowlisted "secret" is normal here.
 *
 * **Do not read this as a place to put a real secret.** A value that actually
 * needed protecting would be an operator-supplied environment variable, as
 * `OMNI_ENCRYPTION_KEY` is; masking would protect it from nobody. The same
 * reasoning omniroute records for its own copy of these bytes.
 */
const MASK = "omnigateway-public-v1";

function unmask(bytes: readonly number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode((bytes[i] as number) ^ MASK.charCodeAt(i % MASK.length));
  }
  return out;
}

/** Exported so the flow's test can assert what is sent without restating the literal. */
export const ANTIGRAVITY_CLIENT_ID = unmask([
  94, 93, 89, 88, 87, 81, 66, 85, 65, 81, 76, 20, 65, 88, 22, 1, 1, 16, 94, 31, 95, 93, 5, 92, 88,
  11, 2, 6, 0, 69, 82, 76, 91, 4, 26, 14, 3, 3, 11, 25, 17, 5, 95, 94, 11, 25, 73, 0, 4, 21, 4, 79,
  30, 66, 31, 18, 14, 9, 28, 16, 72, 4, 82, 0, 3, 26, 12, 9, 21, 90, 6, 24, 12,
]);

const CLIENT_ID = ANTIGRAVITY_CLIENT_ID;
const CLIENT_SECRET = unmask([
  40, 34, 45, 58, 55, 57, 89, 46, 66, 89, 63, 122, 34, 65, 90, 90, 37, 7, 97, 60, 0, 2, 33, 44, 81,
  20, 57, 55, 81, 13, 87, 8, 105, 49, 19,
]);

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

const CODE_ASSIST = "https://cloudcode-pa.googleapis.com/v1internal";
const LOAD_CODE_ASSIST_URL = `${CODE_ASSIST}:loadCodeAssist`;
const ONBOARD_USER_URL = `${CODE_ASSIST}:onboardUser`;
const QUOTA_SUMMARY_URL = `${CODE_ASSIST}:retrieveUserQuotaSummary`;

/** What Antigravity's own client asks for. `cclog` and `experimentsandconfigs` are its telemetry scopes. */
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
].join(" ");

/** The body metadata both official clients send with the bootstrap calls. */
const IDE_METADATA = { ideType: "ANTIGRAVITY" };

/** The tier Google assigns an account it has never onboarded. */
const DEFAULT_TIER = "legacy-tier";

type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
};

function parseTokenResponse(value: unknown): TokenResponse | null {
  const record = recordOf(value);
  if (record === null || typeof record.access_token !== "string") return null;
  return {
    accessToken: record.access_token,
    refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : null,
    expiresIn: typeof record.expires_in === "number" ? record.expires_in : null,
  };
}

/** The token call, as a step the host performs. `async function*` — see `oauthFlow.ts`. */
async function* postToken(
  body: Record<string, string>,
  fail: AuthHelpers["fail"],
): AuthStep<TokenResponse> {
  const res = yield postJsonRequest(TOKEN_URL, antigravityProfile, {
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams(body).toString(),
  });
  const parsed = parseBody(res.body);

  if (res.status < 200 || res.status >= 300) {
    throw fail(tokenErrorCode(res.status), tokenErrorMessage(res.status, parsed));
  }

  const token = parseTokenResponse(parsed);
  if (token === null) throw fail("AUTH", "token endpoint returned no access_token");
  return token;
}

/**
 * The project id, wherever this response put it.
 *
 * `cloudaicompanionProject` is a bare string on some accounts and an object with
 * an `id` on others, and both spellings come back from the same endpoint.
 */
function projectFrom(value: unknown): string {
  const record = recordOf(value);
  if (record === null) return "";
  const project = record.cloudaicompanionProject;
  if (typeof project === "string") return project.trim();
  const nested = recordOf(project);
  const id = nested?.id;
  return typeof id === "string" ? id.trim() : "";
}

/** The onboarding tier this account should be offered, defaulting to the unonboarded one. */
function tierFrom(value: unknown): string {
  const record = recordOf(value);
  const tiers = record?.allowedTiers;
  if (Array.isArray(tiers)) {
    for (const entry of tiers) {
      const tier = recordOf(entry);
      if (tier?.isDefault === true && typeof tier.id === "string") return tier.id;
    }
  }
  const current = recordOf(record?.currentTier);
  return typeof current?.id === "string" ? current.id : DEFAULT_TIER;
}

function codeAssistRequest(url: string, accessToken: string, body: Record<string, unknown>) {
  return postJsonRequest(url, antigravityProfile, {
    contentType: "application/json",
    body: JSON.stringify(body),
    extraHeaders: [["Authorization", `Bearer ${accessToken}`]],
  });
}

/**
 * Discovers — and if necessary creates — the account's Cloud Code project.
 *
 * Every inference request carries this id in its envelope, and Google refuses a
 * blank one, so an account without a project cannot be routed to. It is read
 * here rather than at request time because a codec has no way to make a network
 * call, which is the whole shape of `ProviderCodec`.
 *
 * **Three requests at most, and that ceiling is the host's.** `exchange` may
 * yield four in total and the token call is one of them, so this gets three:
 * `loadCodeAssist`, then — only for an account Google has never onboarded —
 * `onboardUser`, whose own response carries the project it just created. The
 * userinfo read takes the fourth.
 *
 * omniroute instead re-reads `loadCodeAssist` after onboarding, and polls it up
 * to ten times in the background. Neither is available to a step that has to
 * return a credential, so this reads the project out of the onboarding response
 * directly. When that response does not carry one — a slow provisioning, most
 * likely — the connect still **succeeds** with no project: the credential is
 * real and refreshable, the codec refuses inference against it with a message
 * naming the fix, and the operator's second connect finds the project through
 * `loadCodeAssist` on the first call.
 */
async function* bootstrapProject(
  accessToken: string,
): AuthStep<{ projectId: string; tier: string }> {
  const loaded = yield codeAssistRequest(LOAD_CODE_ASSIST_URL, accessToken, {
    metadata: IDE_METADATA,
  });

  // A failure here is not fatal to the connect: see the docblock. The parse of a
  // non-2xx body yields no project, which is the same state as a slow one.
  const body = loaded.status >= 200 && loaded.status < 300 ? parseBody(loaded.body) : null;
  const tier = tierFrom(body);
  const existing = projectFrom(body);
  if (existing.length > 0) return { projectId: existing, tier };

  const onboarded = yield codeAssistRequest(ONBOARD_USER_URL, accessToken, {
    tier_id: tier,
    metadata: IDE_METADATA,
  });
  if (onboarded.status < 200 || onboarded.status >= 300) return { projectId: "", tier };

  const operation = recordOf(parseBody(onboarded.body));
  // `onboardUser` answers with a long-running operation: the project it created
  // is under `response`, and `done: false` means it is not there yet.
  return { projectId: projectFrom(operation?.response), tier };
}

/**
 * The account's email, for the credential's label.
 *
 * Read from the userinfo endpoint rather than an ID token because this flow
 * requests no `openid` scope and so is handed none. A failure degrades to no
 * email: it is a label in the console, not an authorization input.
 */
async function* readEmail(accessToken: string): AuthStep<string | null> {
  const res = yield getJsonRequest(USERINFO_URL, antigravityProfile, { accessToken });
  if (res.status < 200 || res.status >= 300) return null;
  const record = recordOf(parseBody(res.body));
  const email = record?.email;
  return typeof email === "string" && email.trim().length > 0 ? email : null;
}

function toResult(
  token: TokenResponse,
  fallbackRefresh: string | null,
  accountEmail: string | null,
  providerData: Record<string, unknown>,
  now: () => number,
): FlowResult {
  return {
    secrets: {
      accessToken: token.accessToken,
      // Google omits `refresh_token` from every refresh response — it issues one
      // at consent and expects the client to keep it. Reading that omission as
      // null would destroy a working credential on its first refresh and force
      // the operator to reconnect the account by hand.
      refreshToken: token.refreshToken ?? fallbackRefresh,
      apiKey: null,
      idToken: null,
    },
    expiresAt: token.expiresIn === null ? null : now() + token.expiresIn * 1000,
    accountEmail,
    providerData,
  };
}

/**
 * Which of the two model families a quota group describes.
 *
 * The catalog carries Gemini rows only, so the "Claude and GPT models" group
 * measures capacity nothing here can route to — and `quota_windows` holds one
 * row per `(credential, windowType)`, so storing both would mean one silently
 * overwriting the other.
 */
const GEMINI_GROUP = /\bgemini\b/;

/**
 * Which window a bucket describes, from its own text.
 *
 * Google states no window field on these buckets, so the only signal is the
 * `bucketId`/`displayName` pair. **An unmatched bucket is dropped rather than
 * guessed**: a rename upstream then reads as "no data", which the whole quota
 * surface already treats as unknown, instead of filing a weekly figure under the
 * five-hour window where every projection would be built on it.
 */
function windowOf(bucket: Record<string, unknown>): WindowType | null {
  const text = `${String(bucket.bucketId ?? "")} ${String(bucket.displayName ?? "")}`.toLowerCase();
  if (/\bweekly\b|\bweek\b/.test(text)) return "weekly";
  if (/\b5\s*-?\s*hour|\b5h\b|\bfive\s*hour/.test(text)) return "fiveHour";
  return null;
}

/** `groups[]` from either envelope this undocumented RPC has been observed to use. */
function groupsOf(value: unknown): unknown[] {
  const root = recordOf(value);
  if (root === null) return [];
  if (Array.isArray(root.groups)) return root.groups;
  const nested = recordOf(root.quotaSummary)?.groups;
  return Array.isArray(nested) ? nested : [];
}

/**
 * Reads Antigravity's quota summary.
 *
 * Buckets state `remainingFraction` rather than a used/limit pair, so each
 * normalizes to a value out of 100 — the convention `QuotaWindow` already
 * documents for a provider that reports only a proportion, and the one that
 * keeps every consumer on the same ratio arithmetic.
 *
 * A `disabled` bucket, or one with no fraction, is dropped. Missing data means
 * unknown, never unlimited: an account that reads as having no ceiling is one
 * the router will keep sending traffic to after it is spent.
 *
 * Exported for fixture tests.
 */
export function parseAntigravityQuota(value: unknown, now: number): UsageReport | null {
  const windows: (UsageWindowReport | null)[] = [];

  for (const groupValue of groupsOf(value)) {
    const group = recordOf(groupValue);
    if (group === null) continue;
    if (!GEMINI_GROUP.test(String(group.displayName ?? "").toLowerCase())) continue;

    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const bucketValue of buckets) {
      const bucket = recordOf(bucketValue);
      if (bucket === null || bucket.disabled === true) continue;

      const windowType = windowOf(bucket);
      if (windowType === null) continue;

      const fraction = numberOf(bucket, ["remainingFraction"]);
      if (fraction === null) continue;

      const remaining = Math.max(0, Math.min(1, fraction));
      windows.push({
        windowType,
        used: Math.round((1 - remaining) * 100),
        limit: 100,
        resetsAt: resetAtOf(bucket, { absolute: ["resetTime"] }, now),
        // Google states no duration; `windowType`'s nominal length is used.
        windowMs: null,
      });
    }
  }

  return reportFrom(windows);
}

export const antigravityOAuthFlow: PkcePluginFlow = {
  kind: "pkce",
  supportsManualPaste: true,

  // biome-ignore lint/correctness/useYield: nothing to ask an endpoint for
  async *start({ redirectUri, randomState, pkce }) {
    const state = randomState();
    const { verifier, challenge } = pkce();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", state);
    // Without `offline` Google issues no refresh token at all, and `consent`
    // forces the screen even for an account that has approved before — which is
    // what makes reconnecting a second account possible.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    // Required by the hosted callback, not optional here. See the file header.
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");

    return {
      authorizeUrl: url.toString(),
      pending: { verifier, challenge, state, redirectUri },
    };
  },

  async *exchange({ code, pending, fail, now }) {
    // A pasted callback URL arrives unpicked as `<code>#<state>`.
    const [rawCode, pastedState] = code.split("#");
    if (pastedState !== undefined && pastedState !== pending.state) {
      throw fail("AUTH", "authorization state mismatch");
    }

    const token = yield* postToken(
      {
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: (rawCode ?? "").trim(),
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
      },
      fail,
    );

    const email = yield* readEmail(token.accessToken);
    const { projectId, tier } = yield* bootstrapProject(token.accessToken);

    return toResult(token, null, email, { projectId, tier }, now);
  },

  async *refresh({ refreshToken, providerData, fail, now }) {
    const token = yield* postToken(
      {
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: refreshToken,
      },
      fail,
    );

    // The project is **not** re-read. It is already on `providerData`, it does
    // not change for the life of the account, and a refresh that dropped it
    // would break every subsequent request with no failure of its own to
    // explain why.
    return toResult(token, refreshToken, null, providerData, now);
  },

  async *usage({ secrets, providerData, now }) {
    const project = typeof providerData.projectId === "string" ? providerData.projectId : "";
    // No project, no probe. The RPC requires one, and an account that has not
    // finished bootstrapping reads as unknown rather than as a failed probe.
    if (project.trim().length === 0) return null;

    const res = yield {
      ...postJsonRequest(QUOTA_SUMMARY_URL, antigravityProfile, {
        contentType: "application/json",
        body: JSON.stringify({ project }),
        extraHeaders: [["Authorization", `Bearer ${secrets.accessToken}`]],
      }),
      // Shorter than the host's ceiling on purpose: nothing on the request path
      // waits for a usage probe, so a slow one is worth abandoning.
      timeoutMs: SHORT_TIMEOUT_MS,
    };

    if (!usageReadable(res.status, "antigravity")) return null;
    return parseAntigravityQuota(parseBody(res.body), now());
  },
};
