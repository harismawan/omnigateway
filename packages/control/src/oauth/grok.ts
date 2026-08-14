import { GatewayError } from "@omni/ir";
import { mergeHeaders, mintGrokDevice, orderHeaders, PROFILES } from "@omni/providers";
import { createPkce, randomState } from "./pkce.ts";
import {
  type AuthorizeStart,
  type FlowResult,
  type OAuthDeps,
  type OAuthProvider,
  postJson,
  tokenErrorCode,
  tokenErrorMessage,
} from "./types.ts";

/**
 * Public client ID of xAI's own desktop client. A public PKCE client holds no
 * secret — this ships in a distributed binary and is protected by the code
 * challenge, not by being unknown. See the note at the head of Task 20.
 */
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const ISSUER = "https://auth.x.ai";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;

/**
 * The scopes xAI's client asks for. `offline_access` is what makes a refresh
 * token appear at all; `grok-cli:access` is what the chat proxy checks.
 */
const SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "grok-cli:access",
  "api:access",
  "conversations:read",
  "conversations:write",
  "workspaces:read",
  "workspaces:write",
].join(" ");

/** Endpoints are only honoured under this registrable domain. */
const TRUSTED_HOST = "x.ai";

type Endpoints = { authorizeUrl: string; tokenUrl: string };

type TokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  idToken: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Accepts a discovered endpoint only if xAI could have published it.
 *
 * Discovery is a network read whose answer decides where an authorization code
 * and a client id are sent. An unvalidated document is therefore a redirect of
 * the token exchange to a host of the responder's choosing, so the two
 * properties that make that impossible — TLS, and a host under xAI's own
 * domain — are checked before the URL is used for anything.
 *
 * The failure is `UPSTREAM` rather than `AUTH` on purpose: `createRefresher`
 * disables a credential on `AUTH`, and a discovery document that fails this
 * check says nothing about whether the refresh token is still good.
 */
function trustedEndpoint(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GatewayError("UPSTREAM", `discovery document has no ${field}`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayError("UPSTREAM", `discovery document has an unusable ${field}`);
  }

  // `endsWith(".x.ai")` rather than `endsWith("x.ai")`, so that `evilx.ai` and
  // `x.ai.attacker.example` are both refused. `URL` has already lowercased and
  // punycoded the host by this point.
  const host = url.hostname;
  if (url.protocol !== "https:" || (host !== TRUSTED_HOST && !host.endsWith(`.${TRUSTED_HOST}`))) {
    // The offending URL is deliberately not echoed: it is attacker-supplied
    // text, and the field name is enough to diagnose from.
    throw new GatewayError(
      "UPSTREAM",
      `discovery document ${field} is not an ${TRUSTED_HOST} https url`,
    );
  }
  return url.toString();
}

/**
 * Reads xAI's OIDC metadata.
 *
 * Not cached. This runs once per connect and once per refresh, which is rare
 * enough that a cache would only add a way for a rotated endpoint to go
 * unnoticed, and module-level state that outlives a test.
 */
async function discover(deps: OAuthDeps): Promise<Endpoints> {
  const res = await deps.http({
    provider: "grok",
    url: DISCOVERY_URL,
    method: "GET",
    headers: orderHeaders(
      mergeHeaders(PROFILES.grok.headers, [["Accept", "application/json"]]),
      PROFILES.grok.order,
    ),
    body: "",
    // Short: a connect flow waits on this, and a slow answer is worth
    // abandoning rather than holding the operator on.
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new GatewayError("UPSTREAM", `discovery endpoint returned http_${res.status}`);
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // An HTML error page is a real answer; it is just not a discovery document.
  }
  if (!isRecord(parsed)) {
    throw new GatewayError("UPSTREAM", "discovery endpoint returned an unusable response");
  }

  return {
    authorizeUrl: trustedEndpoint(parsed.authorization_endpoint, "authorization_endpoint"),
    tokenUrl: trustedEndpoint(parsed.token_endpoint, "token_endpoint"),
  };
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
 * Reads the email claim out of an ID token.
 *
 * The signature is not verified, and does not need to be: this token came back
 * over TLS from the token endpoint in answer to a request this process made, so
 * there is no third party whose authorship needs proving. A malformed token
 * degrades to no email rather than failing the connection — the address is a
 * label in the console, not an authorization input.
 */
function emailFromIdToken(idToken: string | null): string | null {
  const parts = typeof idToken === "string" ? idToken.split(".") : [];
  const payload = parts[1];
  if (parts.length !== 3 || payload === undefined || payload.length === 0) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isRecord(json)) return null;
    return typeof json.email === "string" && json.email.trim().length > 0 ? json.email : null;
  } catch {
    return null;
  }
}

async function postToken(
  tokenUrl: string,
  body: Record<string, string>,
  deps: OAuthDeps,
): Promise<TokenResponse> {
  // Form-encoded, and with no client_secret: a public client has none to send.
  const { status, parsed } = await postJson(deps, "grok", tokenUrl, PROFILES.grok, {
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams(body).toString(),
  });

  if (status < 200 || status >= 300) {
    throw new GatewayError(tokenErrorCode(status), tokenErrorMessage(status, parsed));
  }

  const token = parseTokenResponse(parsed);
  if (token === null) {
    throw new GatewayError("AUTH", "token endpoint returned no access_token");
  }
  return token;
}

/**
 * Reads the stored device identity back, minting one if it is absent.
 *
 * The id is minted once at connect time and then frozen onto `providerData`,
 * because the adapter sends it as `x-grok-agent-id` on every request and
 * upstream expects one value per installation. Minting rather than reading the
 * host is `mintGrokDevice`'s decision, and the reasoning lives there.
 */
function agentIdFrom(providerData: Record<string, unknown>): string {
  const stored = providerData.agentId;
  return typeof stored === "string" && stored.trim().length > 0 ? stored : mintGrokDevice().agentId;
}

function toResult(
  token: TokenResponse,
  fallbackRefresh: string | null,
  agentId: string,
  deps: OAuthDeps,
): FlowResult {
  return {
    secrets: {
      accessToken: token.accessToken,
      // xAI rotates refresh tokens *conditionally*: a refresh response may omit
      // `refresh_token` entirely, meaning "keep using the one you have". Taking
      // that omission as a null would destroy a working credential on its first
      // refresh, and the operator would have to reconnect the account by hand.
      refreshToken: token.refreshToken ?? fallbackRefresh,
      apiKey: null,
      idToken: token.idToken,
    },
    expiresAt: token.expiresIn === null ? null : deps.now() + token.expiresIn * 1000,
    accountEmail: emailFromIdToken(token.idToken),
    // Read back by the grok adapter as the `x-grok-agent-id` device fingerprint.
    providerData: { agentId },
  };
}

export const grokOAuth: OAuthProvider = {
  id: "grok",
  kind: "pkce",
  supportsManualPaste: true,

  async start({ redirectUri }, deps): Promise<AuthorizeStart> {
    const { authorizeUrl } = await discover(deps);
    const { verifier, challenge } = createPkce();
    const state = randomState();

    const url = new URL(authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", randomState());
    // xAI's own client identifies itself here. There is deliberately no `plan`
    // parameter: the widely copied `plan=generic&referrer=hermes-agent` pair
    // belongs to a different third-party product, and sending it would identify
    // this gateway as that product.
    url.searchParams.set("referrer", "grok-build");

    return { authorizeUrl: url.toString(), pending: { verifier, challenge, state, redirectUri } };
  },

  async exchange({ code, pending }, deps) {
    // A pasted callback URL arrives unpicked as `<code>#<state>`.
    const [rawCode, pastedState] = code.split("#");
    if (pastedState !== undefined && pastedState !== pending.state) {
      throw new GatewayError("AUTH", "authorization state mismatch");
    }

    const { tokenUrl } = await discover(deps);
    const token = await postToken(
      tokenUrl,
      {
        grant_type: "authorization_code",
        code: (rawCode ?? "").trim(),
        redirect_uri: pending.redirectUri,
        client_id: CLIENT_ID,
        code_verifier: pending.verifier,
      },
      deps,
    );

    return toResult(token, null, mintGrokDevice().agentId, deps);
  },

  async refresh(refreshToken, deps, providerData) {
    const { tokenUrl } = await discover(deps);
    const token = await postToken(
      tokenUrl,
      { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken },
      deps,
    );
    return toResult(token, refreshToken, agentIdFrom(providerData), deps);
  },

  // No `usage`. xAI publishes no rate-limit headers and its own client reads
  // none, so a grok account reads as *unknown* rather than as unlimited —
  // which is the honest answer, and the one the tightest-window rule expects.
};
