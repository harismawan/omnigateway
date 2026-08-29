/**
 * Whether a URL a plugin described is one its manifest admitted.
 *
 * **One function, because a plugin can cause a request two ways** — a codec
 * describing an inference call, and an OAuth step yielding a token call — and a
 * rule enforced on one of them is not enforced. It lived twice for one commit,
 * byte-identical in `codecAdapter.ts` and `oauth/pluginFlow.ts`, while a comment
 * in the first said "one rule, enforced in the two places a plugin can cause a
 * request". That sentence was true of the intent and false of the code.
 *
 * Compared as **parsed origins**, never as text: `https://api.kilo.ai.evil.test`
 * has `https://api.kilo.ai` as a prefix, so a `startsWith` allowlist is a
 * suggestion. `URL.origin` normalises scheme, host and port together.
 *
 * A malformed *declared* origin is treated as matching nothing rather than
 * throwing. `createPluginFetch` refuses one at construction instead, and the
 * difference is deliberate: that runs once at load with an operator watching,
 * while this runs per request where a throw would be an outage.
 */
export function withinOrigins(url: string, origins: readonly string[]): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  return origins.some((allowed) => {
    try {
      return new URL(allowed).origin === target.origin;
    } catch {
      return false;
    }
  });
}

/**
 * Whether a `url` is one `HttpClient` can actually be handed.
 *
 * Parsed rather than pattern-matched, because the thing that must not throw is
 * `new URL(…)` inside the transport, and the only honest way to know it will not
 * is to have called it. The scheme check is the second half: `file:`, `data:`
 * and the rest parse cleanly and then throw `Protocol "file:" not supported` a
 * layer deeper — and an outbound request the host believes is HTTP is worth
 * refusing on its own terms, not only because Node happens to.
 */
export function isSendableUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Whether a `method` is one the transport will accept.
 *
 * A closed set rather than the RFC's token grammar. The grammar would admit
 * `FROBNICATE`, which is a valid token and not a request any provider serves, so
 * the narrower rule costs nothing and refuses where a reader can see why.
 *
 * Load-bearing rather than tidy: `nodeHttpClient` throws `ERR_INVALID_HTTP_TOKEN`
 * *synchronously inside its Promise executor* on a bad verb, so `"GET junk"`
 * from a plugin becomes a raw rejection outside every guard — measured on the
 * inference path before this existed, and the reason the auth path now shares it
 * rather than repeating the lesson.
 */
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

export function isHttpMethod(value: unknown): value is string {
  return typeof value === "string" && HTTP_METHODS.has(value);
}
