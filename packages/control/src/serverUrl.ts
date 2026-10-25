/**
 * The one rule for a URL an operator gives the gateway to send to: a custom
 * provider's endpoint, an export destination's receiver.
 *
 * `http:` or `https:` with a host, and no credentials, query or fragment —
 * credentials belong in the encrypted secret, never in a URL that is shown back
 * and logged, and a query or fragment on a *base* URL has no sound meaning once
 * a path is appended. Private and loopback hosts are allowed on purpose: the
 * operator configured this, and an in-cluster server is the common case.
 *
 * Returns why it was refused rather than throwing, so each caller keeps its own
 * field name and wording.
 */
export type ServerUrlCheck = { url: URL } | { problem: "unparseable" | "not-a-server" };

export function checkServerUrl(input: string): ServerUrlCheck {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { problem: "unparseable" };
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    return { problem: "not-a-server" };
  }
  return { url };
}

/**
 * The base path of an accepted URL, trailing slashes collapsed away — a bare
 * `/` is no path at all. The WHATWG parser has already resolved dot segments
 * and kept percent-escapes intact, so nothing else needs guarding.
 */
export function basePathOf(url: URL): string {
  return url.pathname.replace(/\/+$/, "");
}
