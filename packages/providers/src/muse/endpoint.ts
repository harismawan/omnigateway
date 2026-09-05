/**
 * Where a muse credential's inference goes, and the one check that decides it.
 *
 * Its own module because **both ends need it**. The mint validates the
 * `base_url` it is told before storing it, and the codec validates what it
 * reads back before attaching a decrypted key to it. An earlier version checked
 * only at the mint and left the codec a `startsWith("https://")` shape test,
 * on the reasoning that a validated value had already been stored — which is
 * exactly the assumption `providerData` does not support. `sqlite/config.ts`
 * parses stored JSON with a bare `JSON.parse`, a restored database bypasses
 * every schema, and this repository already writes that rule down for provider
 * ids. So the credential-bearing read validates for itself, and the two ends
 * cannot disagree because there is one function.
 */

/** Endpoints are only honoured under this registrable domain. */
const TRUSTED_HOST = "meta.ai";

/** The compiled default, used when a credential names nothing usable. */
export const MUSE_DEFAULT_BASE_URL = "https://api.meta.ai/v1";

/**
 * The base URL if it is one Meta could have published, else null.
 *
 * This value decides where a decrypted Model API key is sent, so every part of
 * it is checked rather than just the scheme:
 *
 * - **https**, because a bearer token must not cross plaintext.
 * - **host under `meta.ai`**, matched as `=== "meta.ai"` or `.endsWith(".meta.ai")`
 *   — with the dot, so `evilmeta.ai` and `meta.ai.attacker.example` are both
 *   refused. `URL` has lowercased and punycoded the host by this point, and a
 *   trailing-dot host (`api.meta.ai.`) fails the suffix test as it should.
 * Userinfo, query and fragment need no check of their own: the value returned
 * is **rebuilt** from `origin` and `pathname`, so none of the three can survive
 * into it. `https://evil.example@api.meta.ai/v1?x=1#f` comes back as
 * `https://api.meta.ai/v1`. Explicit guards for them were written first and
 * then deleted — mutation testing could not kill either one, because the
 * reconstruction had already made them unreachable, and a guard whose removal
 * changes nothing is one nobody can prove works. The reconstruction is the
 * mechanism; there is one of it.
 *
 * A trailing slash is dropped so the caller can append without doubling it.
 */
export function trustedBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;

  const host = url.hostname;
  if (host !== TRUSTED_HOST && !host.endsWith(`.${TRUSTED_HOST}`)) return null;

  return `${url.origin}${url.pathname}`.replace(/\/$/, "");
}

/**
 * The Responses endpoint for a credential, falling back to the default.
 *
 * Built through the validated origin and path rather than by pasting onto
 * whatever was stored, so a value that somehow carried `..` cannot walk out of
 * the path `URL` already normalized.
 */
export function museResponsesUrl(providerData: Record<string, unknown>): string {
  return `${trustedBaseUrl(providerData.baseUrl) ?? MUSE_DEFAULT_BASE_URL}/responses`;
}
