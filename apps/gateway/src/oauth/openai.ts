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

async function postToken(body: Record<string, string>, deps: OAuthDeps): Promise<TokenResponse> {
  const { status, parsed } = await postJson(deps, TOKEN_URL, PROFILES.openai, {
    contentType: "application/x-www-form-urlencoded",
    body: new URLSearchParams({ ...body, client_id: CLIENT_ID }).toString(),
  });

  if (status < 200 || status >= 300) {
    throw new GatewayError("AUTH", tokenErrorMessage(status, parsed));
  }

  const token = parseTokenResponse(parsed);
  if (token === null) {
    throw new GatewayError("AUTH", "token endpoint returned no access_token");
  }
  return token;
}

function toResult(
  token: TokenResponse,
  fallbackRefresh: string | null,
  deps: OAuthDeps,
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
    expiresAt: token.expiresIn === null ? null : deps.now() + token.expiresIn * 1000,
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
