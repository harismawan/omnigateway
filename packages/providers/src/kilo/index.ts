import { GatewayError } from "@omni/ir";
import { orderFields } from "../body.ts";
import { httpError } from "../http.ts";
import { mergeHeaders, orderHeaders } from "../profile.ts";
import { parseSse } from "../sse.ts";
import type { AdapterRequest, AdapterResult, HeaderPair, ProviderAdapter } from "../types.ts";
import { decodeKiloChat } from "./decode.ts";
import { kiloDescriptor } from "./descriptor.ts";
import { kiloBodyOrder, kiloProfile } from "./profile.ts";
import { toKiloWire } from "./wire.ts";

/**
 * One host, two paths, chosen by credential type.
 *
 * Crossing them does not fail loudly: an OAuth token sent to the gateway path,
 * or an API key sent to the OpenRouter path, comes back as a billing or
 * entitlement error, which reads as anything but a routing bug. Both directions
 * are asserted in the adapter test for that reason.
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

export const kiloAdapter: ProviderAdapter = {
  id: "kilo",
  capabilities: kiloDescriptor.capabilities,

  async send(req: AdapterRequest): Promise<AdapterResult> {
    const oauth = req.credentials.accessToken !== null;
    const token = req.credentials.accessToken ?? req.credentials.apiKey;
    if (token === null) {
      throw new GatewayError("AUTH", "kilo credential has no token", { provider: "kilo" });
    }

    const { body, degradations } = toKiloWire(req.request, req.model);

    const protocol: HeaderPair[] = [
      ["Content-Type", "application/json"],
      // Same bearer either way: the credential types differ only in the URL.
      ["Authorization", `Bearer ${token}`],
      ...organizationHeaders(req.credentials.providerData),
    ];

    // The editor identity and `Accept` come from the profile.
    const profile = kiloProfile;
    const headers = orderHeaders(mergeHeaders(profile.headers, protocol), profile.order);

    // Non-streaming client requests are served by collecting the stream in
    // dispatch, so always ask for SSE.
    const res = await req.http({
      provider: "kilo",
      url: oauth ? OAUTH_URL : API_URL,
      method: "POST",
      headers,
      body: JSON.stringify(orderFields({ ...body, stream: true }, kiloBodyOrder)),
      signal: req.signal,
    });

    if (res.status < 200 || res.status >= 300) throw await httpError(res, "kilo");
    if (res.body === null)
      throw new GatewayError("UPSTREAM", "empty response body", { provider: "kilo" });

    return { events: decodeKiloChat(parseSse(res.body)), degradations };
  },
};

export { decodeKiloChat, toKiloWire };
