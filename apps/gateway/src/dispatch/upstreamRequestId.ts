import type { HttpClient } from "@omni/providers";

/**
 * The response headers providers name their own request id in: Anthropic's
 * `request-id`, and `x-request-id` for OpenAI and every OpenAI-compatible
 * upstream (xAI, Kimi, Kilo, custom). First match wins.
 */
const UPSTREAM_ID_HEADERS = ["request-id", "x-request-id"] as const;

const MAX_ID = 256;
const PRINTABLE = /^[\x21-\x7e]+$/;

/** The provider's request id on a response head, bounded, or null. */
export function upstreamRequestIdOf(headers: Headers): string | null {
  for (const name of UPSTREAM_ID_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value === undefined || value.length === 0) continue;
    return value.length <= MAX_ID && PRINTABLE.test(value) ? value : null;
  }
  return null;
}

/**
 * Wraps one attempt's transport so the provider's request id is seen whatever
 * the adapter does with the response. `HttpClient` is a single function type,
 * so this is a decorator in the same way body capture is: the adapter calls the
 * transport it was handed and never learns this exists. An attempt that makes
 * several calls (a refresh retry) reports the last response it received.
 */
export function watchUpstreamRequestId(
  http: HttpClient,
  onId: (id: string | null) => void,
): HttpClient {
  const watched: HttpClient = async (request) => {
    const response = await http(request);
    onId(upstreamRequestIdOf(response.headers));
    return response;
  };
  return Object.assign(watched, { [WATCHED]: http });
}

/**
 * The transport a watched client wraps. Lets a test ask "which transport did
 * this attempt really get" — the bare one, or the body-capturing decorator —
 * now that every attempt's transport is wrapped once more by this watcher.
 */
export const WATCHED: unique symbol = Symbol("omni.upstreamRequestId.watched");

export function unwatched(http: HttpClient): HttpClient {
  return (http as HttpClient & { [WATCHED]?: HttpClient })[WATCHED] ?? http;
}
