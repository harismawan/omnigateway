import { GatewayError } from "@omni/ir";
import { orderFields } from "../body.ts";
import type { CodecInput, CodecRequest, ProviderCodec } from "../codec.ts";
import { mergeHeaders, orderHeaders } from "../profile.ts";
import { parseSse } from "../sse.ts";
import type { HeaderPair } from "../types.ts";
import { decodeKiloChat } from "./decode.ts";
import { kiloBodyOrder, kiloProfile } from "./profile.ts";
import { toKiloWire } from "./wire.ts";

/**
 * One host, two paths, chosen by credential type.
 *
 * Crossing them does not fail loudly: an OAuth token sent to the gateway path,
 * or an API key sent to the OpenRouter path, comes back as a billing or
 * entitlement error, which reads as anything but a routing bug.
 */
const OAUTH_URL = "https://api.kilo.ai/api/openrouter/chat/completions";
const API_URL = "https://api.kilo.ai/api/gateway/chat/completions";

/**
 * The organization this credential bills to, frozen onto the credential when it
 * was connected. An account with no organization is normal, and the header is
 * omitted rather than sent empty.
 */
function organizationHeaders(providerData: Record<string, unknown>): HeaderPair[] {
  const orgId = providerData.orgId;
  if (typeof orgId !== "string" || orgId.length === 0) return [];
  return [["X-Kilocode-OrganizationID", orgId]];
}

/**
 * Kilo as a codec: the same request its adapter builds, with the sending left
 * to the host.
 *
 * The first conversion of a real provider, written to answer whether the codec
 * contract can express one rather than whether it looks like it could. Nothing
 * moved except the transport: `toKiloWire`, `kiloProfile`, `kiloBodyOrder`,
 * `decodeKiloChat` and the two URLs are the adapter's, unchanged.
 *
 * What the adapter did and this does not: call `http`, check the status, throw
 * `httpError`, refuse an empty body. Those are `codecAdapter`'s, once, for every
 * provider. `packages/providers/test/kiloCodec.test.ts` asserts the two put the
 * same bytes on the wire.
 */
export const kiloCodec: ProviderCodec = {
  buildRequest(input: CodecInput): CodecRequest {
    const oauth = input.credentials.accessToken !== null;
    const token = input.credentials.accessToken ?? input.credentials.apiKey;
    if (token === null) {
      throw new GatewayError("AUTH", "kilo credential has no token", { provider: "kilo" });
    }

    const { body, degradations } = toKiloWire(input.request, input.model);

    const protocol: HeaderPair[] = [
      ["Content-Type", "application/json"],
      // Same bearer either way: the credential types differ only in the URL.
      ["Authorization", `Bearer ${token}`],
      ...organizationHeaders(input.credentials.providerData),
    ];

    // The editor identity and `Accept` come from the profile.
    const headers = orderHeaders(mergeHeaders(kiloProfile.headers, protocol), kiloProfile.order);

    return {
      request: {
        url: oauth ? OAUTH_URL : API_URL,
        method: "POST",
        headers,
        // Non-streaming client requests are served by collecting the stream in
        // dispatch, so always ask for SSE.
        body: JSON.stringify(orderFields({ ...body, stream: true }, kiloBodyOrder)),
      },
      degradations,
    };
  },

  decode({ body }) {
    return decodeKiloChat(parseSse(body));
  },
};
