import { GatewayError, PROVIDER_CAPABILITIES } from "@omni/ir";
import { BODY_ORDER, orderFields } from "../body.ts";
import { httpError } from "../http.ts";
import { kimiDeviceHeaders } from "../kimi-device.ts";
import { mergeHeaders, orderHeaders, PROFILES } from "../profile.ts";
import { parseSse } from "../sse.ts";
import type { AdapterRequest, AdapterResult, HeaderPair, ProviderAdapter } from "../types.ts";
import { decodeChat } from "./decode.ts";
import { toChatWire } from "./wire.ts";

const BASE_URL = "https://api.moonshot.ai/v1/chat/completions";

export const kimiAdapter: ProviderAdapter = {
  id: "kimi",
  capabilities: PROVIDER_CAPABILITIES.kimi,

  async send(req: AdapterRequest): Promise<AdapterResult> {
    const { body, degradations } = toChatWire(req.request, req.model);
    const token = req.credentials.accessToken ?? req.credentials.apiKey;
    if (token === null) {
      throw new GatewayError("AUTH", "kimi credential has no token", { provider: "kimi" });
    }

    const protocol: HeaderPair[] = [
      ["Content-Type", "application/json"],
      ["Accept", "text/event-stream"],
      ["Authorization", `Bearer ${token}`],
      // Device identity is bound to the credential at OAuth time and must stay
      // stable; a changing device id forces re-authentication upstream.
      ...kimiDeviceHeaders(req.credentials.providerData),
    ];

    const profile = PROFILES.kimi;
    const headers = orderHeaders(mergeHeaders(profile.headers, protocol), profile.order);

    const res = await req.http({
      url: BASE_URL,
      method: "POST",
      headers,
      body: JSON.stringify(orderFields({ ...body, stream: true }, BODY_ORDER.kimi)),
      signal: req.signal,
    });

    if (res.status < 200 || res.status >= 300) throw await httpError(res, "kimi");
    if (res.body === null)
      throw new GatewayError("UPSTREAM", "empty response body", { provider: "kimi" });

    return { events: decodeChat(parseSse(res.body)), degradations };
  },
};

export { decodeChat, toChatWire };
