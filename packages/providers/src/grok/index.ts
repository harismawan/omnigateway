import { createHash } from "node:crypto";
import { GatewayError } from "@omni/ir";
import { orderFields } from "../body.ts";
import { httpError } from "../http.ts";
import { mergeHeaders, orderHeaders } from "../profile.ts";
import { parseSse } from "../sse.ts";
import type { AdapterRequest, AdapterResult, HeaderPair, ProviderAdapter } from "../types.ts";
import { decodeGrokResponses } from "./decode.ts";
import { grokDescriptor } from "./descriptor.ts";
import { grokDeviceHeaders } from "./device.ts";
import { grokBodyOrder, grokProfile } from "./profile.ts";
import { toGrokWire } from "./wire.ts";

/**
 * xAI serves the two credential types from two hosts and never falls back
 * between them. Sending an OAuth bearer to the API host does not return a clean
 * 401: it bills against API credits and answers 402 even for an account whose
 * subscription is healthy, which is a confusing enough symptom that the adapter
 * test asserts the pairing directly.
 */
const PROXY_URL = "https://cli-chat-proxy.grok.com/v1/responses"; // OAuth
const API_URL = "https://api.x.ai/v1/responses"; // apiKey

/** Domain separator, so this hash can never collide with another use of a request id. */
const CONV_NAMESPACE = "omni-grok-conv";

/**
 * Derives a stable UUID from a value, in the v5 shape xAI's own ids use.
 *
 * Derived rather than minted so adapter behaviour stays deterministic without
 * threading a random source through every request.
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
 * and the upstream all join on one value rather than three. The conversation and
 * session ids are derived from it and equal to each other, which is what xAI's
 * client does for a main turn. When the caller has no request id — every path
 * outside dispatch — the three are omitted rather than invented.
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

export const grokAdapter: ProviderAdapter = {
  id: "grok",
  capabilities: grokDescriptor.capabilities,

  async send(req: AdapterRequest): Promise<AdapterResult> {
    const oauth = req.credentials.accessToken !== null;
    const { body, degradations } = toGrokWire(req.request, req.model);

    const protocol: HeaderPair[] = [["Content-Type", "application/json"]];

    if (oauth) {
      protocol.push(["Authorization", `Bearer ${req.credentials.accessToken}`]);
      // Both are proxy-only. The API host has no idea what they mean.
      protocol.push(["X-XAI-Token-Auth", "xai-grok-cli"]);
      protocol.push(["x-authenticateresponse", "authenticate-response"]);
    } else if (req.credentials.apiKey !== null) {
      protocol.push(["Authorization", `Bearer ${req.credentials.apiKey}`]);
    } else {
      throw new GatewayError("AUTH", "grok credential has no token", { provider: "grok" });
    }

    protocol.push(...requestIdentityHeaders(req.model, req.requestId));
    // Bound to the credential at connect time and must stay stable; a fresh id
    // per request is a visible behavioural difference from xAI's own client.
    protocol.push(...grokDeviceHeaders(req.credentials.providerData));

    // The client identity headers and `Accept` come from the profile.
    const profile = grokProfile;
    const headers = orderHeaders(mergeHeaders(profile.headers, protocol), profile.order);

    // Non-streaming client requests are served by collecting the stream in
    // dispatch, so always ask for SSE.
    const res = await req.http({
      provider: "grok",
      url: oauth ? PROXY_URL : API_URL,
      method: "POST",
      headers,
      body: JSON.stringify(orderFields({ ...body, stream: true }, grokBodyOrder)),
      signal: req.signal,
    });

    if (res.status < 200 || res.status >= 300) throw await httpError(res, "grok");
    if (res.body === null)
      throw new GatewayError("UPSTREAM", "empty response body", { provider: "grok" });

    return { events: decodeGrokResponses(parseSse(res.body)), degradations };
  },
};

export { decodeGrokResponses, toGrokWire };
