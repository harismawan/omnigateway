import { orderFields } from "../body.ts";
import type { CodecInput, CodecRequest, ProviderCodec } from "../codec.ts";
import { mergeHeaders, orderHeaders } from "../profile.ts";
import { parseSse } from "../sse.ts";
import type { HeaderPair } from "../types.ts";
import { decodeMuseResponses } from "./decode.ts";
import { museResponsesUrl } from "./endpoint.ts";
import { museBodyOrder, museProfile } from "./profile.ts";
import { toMuseWire } from "./wire.ts";

/**
 * Meta's Model API front door, which serves the Responses dialect.
 *
 * One URL for both credential types, which is the whole reason this codec is
 * shorter than OpenAI's. A Muse Code subscription is not spent as a bearer
 * token on the inference path: the OAuth grant buys a Model API key from
 * `muse-code/key`, and that key is what every request carries. So `apiKey` is
 * the field read here whichever way the credential was obtained, and
 * `accessToken` — which the flow also stores — belongs to the mint and the
 * usage probe alone.
 */
export const museCodec: ProviderCodec = {
  buildRequest(input: CodecInput): CodecRequest {
    const { body, degradations, cacheKey } = toMuseWire(input.request, input.model);

    if (input.credentials.apiKey === null) {
      // Deliberately not falling back to `accessToken`. An OAuth credential
      // whose `apiKey` is empty is one whose mint failed or was never run, and
      // sending the device-flow token to the inference host would answer 401
      // with nothing naming the real cause.
      throw input.fail("AUTH", "muse credential has no model api key");
    }

    const protocol: HeaderPair[] = [
      ["Content-Type", "application/json"],
      ["Authorization", `Bearer ${input.credentials.apiKey}`],
      // Muse's own client sends a session id on every request. Sent here on the
      // same terms as the body's `prompt_cache_key`: both name the same
      // conversation, and which one the front door reads is upstream's business.
      ["x-meta-ai-gateway-session-id", cacheKey],
    ];

    const headers = orderHeaders(mergeHeaders(museProfile.headers, protocol), museProfile.order);

    // What the client asked to get back, which decides whether reasoning items
    // are the client's to replay or a thinking block for it to read. Taken from
    // the built body because that is where the vendor bag has already landed.
    const include = body.include;
    const nativeReasoning =
      Array.isArray(include) && include.includes("reasoning.encrypted_content");

    return {
      decodeState: { nativeReasoning },
      request: {
        // Validated here, not trusted from storage: this is the read that
        // attaches a decrypted key, and `providerData` is parsed back out of
        // the database with no schema between.
        url: museResponsesUrl(input.credentials.providerData),
        method: "POST",
        headers,
        // Always SSE. A non-streaming client request is served by collecting the
        // stream in dispatch, exactly as the other Responses providers do.
        body: JSON.stringify(orderFields({ ...body, stream: true }, museBodyOrder)),
      },
      degradations,
    };
  },

  decode({ body, decodeState }) {
    const state = decodeState as { nativeReasoning?: boolean } | undefined;
    return decodeMuseResponses(parseSse(body), {
      nativeReasoning: state?.nativeReasoning === true,
    });
  },
};
