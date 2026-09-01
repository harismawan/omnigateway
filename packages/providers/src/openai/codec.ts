import { orderFields } from "../body.ts";
import type { CodecInput, CodecRequest, ProviderCodec } from "../codec.ts";
import { mergeHeaders, orderHeaders } from "../profile.ts";
import { parseSse } from "../sse.ts";
import type { HeaderPair } from "../types.ts";
import { decodeResponses } from "./decode.ts";
import { openaiBodyOrder, openaiProfile } from "./profile.ts";
import { toResponsesWire } from "./wire.ts";

const OAUTH_URL = "https://chatgpt.com/backend-api/codex/responses";
const API_URL = "https://api.openai.com/v1/responses";

/**
 * OpenAI as a codec.
 *
 * Nothing moved except the transport: `toResponsesWire`, `openaiProfile`,
 * `openaiBodyOrder` and `decodeResponses` are the adapter's, unchanged. The
 * request shape differs by credential type in two ways at once — the host and
 * the account header — and both are pinned in
 * `packages/providers/test/openaiCodec.test.ts` against bytes captured from the
 * adapter this replaced.
 */
export const openaiCodec: ProviderCodec = {
  buildRequest(input: CodecInput): CodecRequest {
    const oauth = input.credentials.accessToken !== null;
    const { body, degradations, cacheKey } = toResponsesWire(input.request, input.model, { oauth });

    const protocol: HeaderPair[] = [["Content-Type", "application/json"]];

    if (oauth) {
      protocol.push(["Authorization", `Bearer ${input.credentials.accessToken}`]);
      // Required by the Codex backend to select the billing account. Stored on
      // the credential at OAuth time.
      const accountId = input.credentials.providerData.accountId;
      if (typeof accountId === "string") protocol.push(["chatgpt-account-id", accountId]);
      // The Codex backend partitions its prompt cache by session, and reads
      // this header rather than `prompt_cache_key` to do it — measured, and the
      // body field alone hit 2 of 5 where the header hit 14 of 15. Sent on this
      // path only: `api.openai.com` has no such mechanism and takes the body
      // field, which both hosts already carry.
      protocol.push(["session_id", cacheKey]);
    } else if (input.credentials.apiKey !== null) {
      protocol.push(["Authorization", `Bearer ${input.credentials.apiKey}`]);
    } else {
      throw input.fail("AUTH", "openai credential has no token");
    }

    // `originator` and `Accept: text/event-stream` come from the profile.
    const headers = orderHeaders(
      mergeHeaders(openaiProfile.headers, protocol),
      openaiProfile.order,
    );

    return {
      request: {
        // The Codex endpoint only streams. Non-streaming client requests are
        // served by collecting the stream in dispatch, so always ask for SSE.
        url: oauth ? OAUTH_URL : API_URL,
        method: "POST",
        headers,
        body: JSON.stringify(orderFields({ ...body, stream: true }, openaiBodyOrder)),
      },
      degradations,
    };
  },

  decode({ body }) {
    return decodeResponses(parseSse(body));
  },
};
