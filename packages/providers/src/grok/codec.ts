import { createHash } from "node:crypto";
import { GatewayError } from "@omni/ir";
import { orderFields } from "../body.ts";
import type { CodecInput, CodecRequest, ProviderCodec } from "../codec.ts";
import { mergeHeaders, orderHeaders } from "../profile.ts";
import { parseSse } from "../sse.ts";
import type { HeaderPair } from "../types.ts";
import { decodeGrokResponses } from "./decode.ts";
import { grokDeviceHeaders } from "./device.ts";
import { grokBodyOrder, grokProfile } from "./profile.ts";
import { toGrokWire } from "./wire.ts";

/**
 * xAI serves the two credential types from two hosts and never falls back
 * between them. Sending an OAuth bearer to the API host does not return a clean
 * 401: it bills against API credits and answers 402 even for an account whose
 * subscription is healthy, which is a confusing enough symptom that the codec
 * test asserts the pairing directly.
 */
const PROXY_URL = "https://cli-chat-proxy.grok.com/v1/responses"; // OAuth
const API_URL = "https://api.x.ai/v1/responses"; // apiKey

/** Domain separator, so this hash can never collide with another use of a request id. */
const CONV_NAMESPACE = "omni-grok-conv";

/**
 * Derives a stable UUID from a value, in the v5 shape xAI's own ids use.
 *
 * Derived rather than minted so codec behaviour stays deterministic without
 * threading a random source through every request — which the contract requires
 * outright: `buildRequest` must describe the same request given the same input,
 * because the host may build it once and send it on more than one attempt.
 */
function derivedUuid(value: string): string {
  const h = createHash("sha256").update(`${CONV_NAMESPACE}:${value}`).digest("hex");
  // Version nibble 5 and the RFC 4122 variant bits, so the id reads as the kind
  // of name-based UUID it actually is rather than as a random one.
  const variant = ((Number.parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    `${variant}${h.slice(17, 20)}`,
    h.slice(20, 32),
  ].join("-");
}

/**
 * The per-request identifiers xAI's client sends.
 *
 * `x-grok-req-id` reuses the gateway's own request id so stdout, `request_logs`
 * and the upstream all join on one value rather than three — which is the reason
 * `requestId` is on `CodecInput` at all. The conversation and session ids are
 * derived from it and equal to each other, which is what xAI's client does for a
 * main turn. When the caller has no request id — every path outside dispatch —
 * the three are omitted rather than invented.
 */
function requestIdentityHeaders(model: string, requestId: string | undefined): HeaderPair[] {
  const headers: HeaderPair[] = [["x-grok-model-override", model]];
  if (requestId === undefined || requestId.length === 0) return headers;
  const conversation = derivedUuid(requestId);
  return [
    ...headers,
    ["x-grok-req-id", requestId],
    ["x-grok-conv-id", conversation],
    ["x-grok-session-id", conversation],
  ];
}

/**
 * Grok as a codec.
 *
 * Nothing moved except the transport. This is the one provider whose request
 * reads `CodecInput.requestId`, so it is also the only evidence that the field
 * arrives — `codecAdapter` forwards it only when dispatch supplied one.
 */
export const grokCodec: ProviderCodec = {
  buildRequest(input: CodecInput): CodecRequest {
    const oauth = input.credentials.accessToken !== null;
    const { body, degradations } = toGrokWire(input.request, input.model);

    const protocol: HeaderPair[] = [["Content-Type", "application/json"]];

    if (oauth) {
      protocol.push(["Authorization", `Bearer ${input.credentials.accessToken}`]);
      // Both are proxy-only. The API host has no idea what they mean.
      protocol.push(["X-XAI-Token-Auth", "xai-grok-cli"]);
      protocol.push(["x-authenticateresponse", "authenticate-response"]);
    } else if (input.credentials.apiKey !== null) {
      protocol.push(["Authorization", `Bearer ${input.credentials.apiKey}`]);
    } else {
      throw new GatewayError("AUTH", "grok credential has no token", { provider: "grok" });
    }

    protocol.push(...requestIdentityHeaders(input.model, input.requestId));
    // Bound to the credential at connect time and must stay stable; a fresh id
    // per request is a visible behavioural difference from xAI's own client.
    protocol.push(...grokDeviceHeaders(input.credentials.providerData));

    // The client identity headers and `Accept` come from the profile.
    const headers = orderHeaders(mergeHeaders(grokProfile.headers, protocol), grokProfile.order);

    return {
      request: {
        url: oauth ? PROXY_URL : API_URL,
        method: "POST",
        headers,
        // Non-streaming client requests are served by collecting the stream in
        // dispatch, so always ask for SSE.
        body: JSON.stringify(orderFields({ ...body, stream: true }, grokBodyOrder)),
      },
      degradations,
    };
  },

  decode({ body }) {
    return decodeGrokResponses(parseSse(body));
  },
};
