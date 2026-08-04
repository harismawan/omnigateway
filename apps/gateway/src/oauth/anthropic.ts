import { GatewayError } from "@omni/ir";
import { PROFILES } from "@omni/providers";
import { createPkce, randomState } from "./pkce.ts";
import {
  type FlowResult,
  type OAuthDeps,
  type OAuthProvider,
  postJson,
  tokenErrorCode,
  tokenErrorMessage,
} from "./types.ts";

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

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  account?: { email_address?: string };
};

async function postToken(body: Record<string, string>, deps: OAuthDeps): Promise<TokenResponse> {
  const { status, parsed } = await postJson(deps, TOKEN_URL, PROFILES.anthropic, {
    contentType: "application/json",
    body: JSON.stringify({ ...body, client_id: CLIENT_ID }),
  });

  if (status < 200 || status >= 300) {
    throw new GatewayError(tokenErrorCode(status), tokenErrorMessage(status, parsed));
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
): FlowResult {
  return {
    secrets: {
      accessToken: token.access_token ?? null,
      // Anthropic rotates refresh tokens on some exchanges and not others.
      refreshToken: token.refresh_token ?? fallbackRefresh,
      apiKey: null,
      idToken: null,
    },
    expiresAt: typeof token.expires_in === "number" ? deps.now() + token.expires_in * 1000 : null,
    accountEmail: token.account?.email_address ?? null,
    providerData: {},
  };
}

export const anthropicOAuth: OAuthProvider = {
  id: "anthropic",
  kind: "pkce",
  supportsManualPaste: true,

  start() {
    const { verifier, challenge } = createPkce();
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

  async exchange({ code, pending }, deps) {
    // A manually pasted code arrives as `<code>#<state>`.
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
        state: pending.state,
      },
      deps,
    );

    return toResult(token, null, deps);
  },

  async refresh(refreshToken, deps) {
    const token = await postToken(
      { grant_type: "refresh_token", refresh_token: refreshToken },
      deps,
    );
    return toResult(token, refreshToken, deps);
  },
};
