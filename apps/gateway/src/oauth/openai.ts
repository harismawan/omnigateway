import { GatewayError } from "@omni/ir";
import { PROFILES } from "@omni/providers";
import { createPkce, randomState } from "./pkce.ts";
import {
  type FlowResult,
  type OAuthDeps,
  type OAuthProvider,
  postJson,
  tokenErrorMessage,
} from "./types.ts";

/** Public client ID of the Codex CLI. See the note at the head of Task 20. */
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const SCOPES = "openid profile email offline_access";

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
};

type IdClaims = {
  email: string | null;
  accountId: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function accountIdFromProviderData(providerData: Record<string, unknown>): string | null {
  return stringOrNull(providerData.accountId);
}

/**
 * Reads the claims out of an ID token.
 *
 * The signature is not verified. This token was returned over TLS by the token
 * endpoint, in response to a request this process made, so there is no third
 * party whose authorship needs proving. A malformed token degrades to no
 * claims rather than failing the connection.
 */
function decodeClaims(idToken: string | undefined): IdClaims {
  if (typeof idToken !== "string") return { email: null, accountId: null };
  const payload = idToken.split(".")[1];
  if (payload === undefined) return { email: null, accountId: null };
  try {
    const json: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isRecord(json)) return { email: null, accountId: null };
    const auth = json["https://api.openai.com/auth"];
    return {
      email: stringOrNull(json.email),
      accountId: isRecord(auth) ? stringOrNull(auth.chatgpt_account_id) : null,
    };
  } catch {
    return { email: null, accountId: null };
  }
}

async function postToken(body: Record<string, string>, deps: OAuthDeps): Promise<TokenResponse> {
  const { status, parsed } = await postJson(deps, TOKEN_URL, PROFILES.openai, {
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({ ...body, client_id: CLIENT_ID }).toString(),
  });

  if (status < 200 || status >= 300) {
    throw new GatewayError("AUTH", tokenErrorMessage(status, parsed));
  }

  if (!isTokenResponse(parsed) || typeof parsed.access_token !== "string") {
    throw new GatewayError("AUTH", "token endpoint returned no access_token");
  }
  return parsed;
}

function isTokenResponse(value: unknown): value is TokenResponse {
  return typeof value === "object" && value !== null;
}

function toResult(
  token: TokenResponse,
  fallbackRefresh: string | null,
  deps: OAuthDeps,
  fallbackAccountId: string | null = null,
): FlowResult {
  const claims = decodeClaims(token.id_token);
  return {
    secrets: {
      accessToken: token.access_token ?? null,
      refreshToken: token.refresh_token ?? fallbackRefresh,
      apiKey: null,
      // Kept because a later refresh may return no new id token, and the
      // account id claim is the only way to address the right workspace.
      idToken: token.id_token ?? null,
    },
    expiresAt: typeof token.expires_in === "number" ? deps.now() + token.expires_in * 1000 : null,
    accountEmail: claims.email,
    // Consumed by the OpenAI adapter as the chatgpt-account-id header (Task 10).
    providerData: { accountId: claims.accountId ?? fallbackAccountId },
  };
}

export const openaiOAuth: OAuthProvider = {
  id: "openai",
  kind: "pkce",
  supportsManualPaste: true,

  start({ redirectUri }) {
    const { verifier, challenge } = createPkce();
    const state = randomState();

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("prompt", "login");

    return { authorizeUrl: url.toString(), pending: { verifier, challenge, state, redirectUri } };
  },

  async exchange({ code, pending }, deps) {
    const [rawCode, pastedState] = code.split("#");
    if (pastedState !== undefined && pastedState !== pending.state) {
      throw new GatewayError("AUTH", "authorization state mismatch");
    }

    const token = await postToken(
      {
        grant_type: "authorization_code",
        code: (rawCode ?? "").trim(),
        redirect_uri: pending.redirectUri,
        code_verifier: pending.verifier,
      },
      deps,
    );

    return toResult(token, null, deps);
  },

  async refresh(refreshToken, deps, providerData) {
    const token = await postToken(
      { grant_type: "refresh_token", refresh_token: refreshToken, scope: SCOPES },
      deps,
    );
    return toResult(token, refreshToken, deps, accountIdFromProviderData(providerData));
  },
};
