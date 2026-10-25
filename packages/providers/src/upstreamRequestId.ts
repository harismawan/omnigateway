/**
 * The response headers providers name their own request id in: Anthropic's
 * `request-id`, and `x-request-id` for OpenAI and every OpenAI-compatible
 * upstream (xAI, Kimi, Kilo, custom). First match wins.
 *
 * Here, beside the transport, because it is a fact about provider wire
 * headers; the gateway records it on the log row and on the `provider.http`
 * span from this one parse.
 */
const UPSTREAM_ID_HEADERS = ["request-id", "x-request-id"] as const;

const MAX_ID = 256;
const PRINTABLE = /^[\x21-\x7e]+$/;

/** The provider's request id on a response head, bounded to 256 printable characters, or null. */
export function upstreamRequestIdOf(headers: Headers): string | null {
  for (const name of UPSTREAM_ID_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value === undefined || value.length === 0) continue;
    return value.length <= MAX_ID && PRINTABLE.test(value) ? value : null;
  }
  return null;
}
