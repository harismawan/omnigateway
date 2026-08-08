/** 32 CSPRNG bytes rendered as unpadded base64url — 43 characters. */
function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export type Pkce = { verifier: string; challenge: string };

/**
 * RFC 7636 S256. The verifier is the secret held by the gateway; the challenge
 * is its hash, which is all the authorization server ever sees before the
 * exchange. This is what makes a public client ID safe to embed.
 */
export function createPkce(): Pkce {
  const verifier = randomToken();
  return { verifier, challenge: Bun.SHA256.hash(verifier, "base64url") };
}

/** CSRF token binding an authorize redirect to the flow that started it. */
export function randomState(): string {
  return randomToken();
}
