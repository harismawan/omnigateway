import type { CodecFail, CodecInput, CodecRequest, ProviderCodec } from "../codec.ts";
import { parseSse } from "../sse.ts";
import type { HeaderPair } from "../types.ts";
import { decodeCustomChat, decodeCustomResponses } from "./decode.ts";
import { toCustomChatWire, toCustomResponsesWire } from "./wire.ts";

type Protocol = "chat_completions" | "responses";

function metadata(
  data: Record<string, unknown>,
  fail: CodecFail,
): {
  origin: string;
  basePath: string;
  protocol: Protocol;
} {
  const { origin, protocol } = data;
  if (typeof origin !== "string" || (protocol !== "chat_completions" && protocol !== "responses")) {
    throw fail("BAD_REQUEST", "custom credential has invalid endpoint metadata");
  }
  // Rows written before custom endpoints carried a base path have none.
  const basePath = typeof data.basePath === "string" ? data.basePath : "";
  return { origin, basePath, protocol };
}

/**
 * Joins stored endpoint metadata into the inference URL.
 *
 * The stored value may carry a base path (`https://host/api`), and operators
 * habitually enter OpenAI-SDK-style bases that already end in `/v1`, which a
 * blind `/v1` append would double. A bare-origin row therefore targets
 * `${origin}/v1/<suffix>` exactly as it always did, while a path-bearing row
 * targets `${origin}${basePath}/v1/<suffix>` unless its path already ends in
 * a version segment such as `/v1` or `/v4`.
 */
function endpointUrl(origin: string, basePath: string, protocol: Protocol): string {
  const suffix = protocol === "chat_completions" ? "chat/completions" : "responses";
  const base = `${origin}${basePath}`.replace(/\/+$/, "");
  return /\/v\d+$/i.test(base) ? `${base}/${suffix}` : `${base}/v1/${suffix}`;
}

/**
 * Which decoder reads the reply, carried from the request that chose it.
 *
 * The **second** use of `decodeState` in this repository, after Anthropic's tool
 * cloak, and a different shape of the same need: this provider's wire format is
 * a property of the *credential*, not of the provider, so `decode` cannot work
 * it out from the response. Before the conversion the adapter simply closed over
 * the value; a codec has no closure spanning the two halves, which is exactly
 * what `decodeState` replaces.
 *
 * Narrowed rather than cast, for the reason Anthropic's is: nothing enforces at
 * a type level that the host hands back what `buildRequest` returned, and a bad
 * cast would surface as a `TypeError` inside `decode`, where `guardStream`
 * relabels it as an upstream failure and fails the request over.
 */
function protocolOf(state: unknown, fail: CodecFail): Protocol {
  if (state !== null && typeof state === "object") {
    const protocol = (state as { protocol?: unknown }).protocol;
    if (protocol === "responses" || protocol === "chat_completions") return protocol;
  }
  // **Refused, not defaulted.** Defaulting to `chat_completions` was the first
  // version, and it fails in the worst available direction: a `responses`
  // endpoint decoded by the chat reader yields *nothing* — the two dialects
  // share no event names — so the client gets an empty 200 for a request the
  // upstream answered in full. Reaching here means the host handed back
  // something other than what `buildRequest` returned, which is a gateway bug,
  // and a gateway bug should read as one.
  throw fail("INTERNAL", "custom codec lost its endpoint protocol");
}

/**
 * A custom OpenAI-compatible endpoint as a codec.
 *
 * Rule 2's worked example stays the worked example: this directory forks its own
 * chat and responses codecs rather than importing kimi's, kilo's or openai's, so
 * converting it moved the transport and nothing else.
 */
export const customCodec: ProviderCodec = {
  buildRequest(input: CodecInput): CodecRequest {
    const apiKey = input.credentials.apiKey;
    if (apiKey === null) {
      throw input.fail("AUTH", "custom credential has no API key");
    }
    const { origin, basePath, protocol } = metadata(input.credentials.providerData, input.fail);
    const encoded =
      protocol === "chat_completions"
        ? toCustomChatWire(input.request, input.model)
        : toCustomResponsesWire(input.request, input.model);

    const headers: HeaderPair[] = [
      ["Content-Type", "application/json"],
      ["Authorization", `Bearer ${apiKey}`],
    ];

    return {
      request: {
        url: endpointUrl(origin, basePath, protocol),
        method: "POST",
        headers,
        // No `orderFields` here, and there never was: an operator's own endpoint
        // has no client to be mistaken for, so there is no header or field order
        // to reproduce.
        body: JSON.stringify({ ...encoded.body, stream: true }),
      },
      decodeState: { protocol },
      degradations: encoded.degradations,
    };
  },

  decode({ body, decodeState, fail }) {
    return protocolOf(decodeState, fail) === "chat_completions"
      ? decodeCustomChat(parseSse(body))
      : decodeCustomResponses(parseSse(body));
  },
};
