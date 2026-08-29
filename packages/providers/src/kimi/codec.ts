import { GatewayError } from "@omni/ir";
import { orderFields } from "../body.ts";
import type { CodecInput, CodecRequest, ProviderCodec } from "../codec.ts";
import { mergeHeaders, orderHeaders } from "../profile.ts";
import { parseSse } from "../sse.ts";
import type { HeaderPair } from "../types.ts";
import { decodeChat } from "./decode.ts";
import { kimiDeviceHeaders } from "./device.ts";
import { kimiBodyOrder, kimiProfile } from "./profile.ts";
import { toChatWire } from "./wire.ts";

const BASE_URL = "https://api.kimi.com/coding/v1/chat/completions";

/**
 * Kimi as a codec: the same request its adapter built, with the sending left to
 * the host.
 *
 * The second conversion, after kilo, and the one the design named as the pair
 * that had to prove the contract before it is published
 * (`docs/superpowers/specs/2026-08-28-plugin-provider-capability-design.md`).
 * Kilo answered whether a URL chosen by credential type fits; this answers
 * whether a credential-bound *identity* does — kimi's device headers are frozen
 * onto the credential at OAuth time, so they arrive through `providerData` and
 * nowhere else.
 *
 * Nothing moved except the transport: `toChatWire`, `kimiProfile`,
 * `kimiBodyOrder`, `kimiDeviceHeaders` and `decodeChat` are the adapter's,
 * unchanged. What the adapter did and this does not: call `http`, check the
 * status, throw `httpError`, refuse an empty body. Those are `codecAdapter`'s,
 * once, for every provider.
 */
export const kimiCodec: ProviderCodec = {
  buildRequest(input: CodecInput): CodecRequest {
    const { body, degradations } = toChatWire(input.request, input.model);
    const token = input.credentials.accessToken ?? input.credentials.apiKey;
    if (token === null) {
      // `AUTH` rather than a bare failure, and `codecAdapter` passes a
      // `GatewayError`'s own classification through untouched: dispatch gates
      // its credential-refresh retry on this code, so flattening it here would
      // silently turn a refreshable token into a failover.
      throw new GatewayError("AUTH", "kimi credential has no token", { provider: "kimi" });
    }

    const protocol: HeaderPair[] = [
      ["Content-Type", "application/json"],
      ["Accept", "text/event-stream"],
      ["Authorization", `Bearer ${token}`],
      // Device identity is bound to the credential at OAuth time and must stay
      // stable; a changing device id forces re-authentication upstream.
      ...kimiDeviceHeaders(input.credentials.providerData),
    ];

    const headers = orderHeaders(mergeHeaders(kimiProfile.headers, protocol), kimiProfile.order);

    return {
      request: {
        url: BASE_URL,
        method: "POST",
        headers,
        // Non-streaming client requests are served by collecting the stream in
        // dispatch, so always ask for SSE.
        body: JSON.stringify(orderFields({ ...body, stream: true }, kimiBodyOrder)),
      },
      degradations,
    };
  },

  decode({ body }) {
    return decodeChat(parseSse(body));
  },
};
