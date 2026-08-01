import { GatewayError, PROVIDER_CAPABILITIES } from "@omni/ir";
import { BODY_ORDER, orderFields } from "../body.ts";
import { httpError } from "../http.ts";
import { mergeHeaders, orderHeaders, PROFILES } from "../profile.ts";
import { parseSse } from "../sse.ts";
import type { AdapterRequest, AdapterResult, HeaderPair, ProviderAdapter } from "../types.ts";
import { decodeResponses } from "./decode.ts";
import { toResponsesWire } from "./wire.ts";

const OAUTH_URL = "https://chatgpt.com/backend-api/codex/responses";
const API_URL = "https://api.openai.com/v1/responses";

export const openaiAdapter: ProviderAdapter = {
  id: "openai",
  capabilities: PROVIDER_CAPABILITIES.openai,

  async send(req: AdapterRequest): Promise<AdapterResult> {
    const oauth = req.credentials.accessToken !== null;
    const { body, degradations } = toResponsesWire(req.request, req.model);

    const protocol: HeaderPair[] = [["Content-Type", "application/json"]];

    if (oauth) {
      protocol.push(["Authorization", `Bearer ${req.credentials.accessToken}`]);
      // Required by the Codex backend to select the billing account. Stored on
      // the credential at OAuth time (Task 21).
      const accountId = req.credentials.providerData.accountId;
      if (typeof accountId === "string") protocol.push(["chatgpt-account-id", accountId]);
    } else if (req.credentials.apiKey !== null) {
      protocol.push(["Authorization", `Bearer ${req.credentials.apiKey}`]);
    } else {
      throw new GatewayError("AUTH", "openai credential has no token", { provider: "openai" });
    }

    // `originator` and `Accept: text/event-stream` come from the profile.
    const profile = PROFILES.openai;
    const headers = orderHeaders(mergeHeaders(profile.headers, protocol), profile.order);

    // The Codex endpoint only streams. Non-streaming client requests are served
    // by collecting the stream in dispatch, so always ask for SSE.
    const res = await req.http({
      url: oauth ? OAUTH_URL : API_URL,
      method: "POST",
      headers,
      body: JSON.stringify(orderFields({ ...body, stream: true }, BODY_ORDER.openai)),
      signal: req.signal,
    });

    if (res.status < 200 || res.status >= 300) throw await httpError(res, "openai");
    if (res.body === null)
      throw new GatewayError("UPSTREAM", "empty response body", { provider: "openai" });

    return { events: decodeResponses(parseSse(res.body)), degradations };
  },
};

export { decodeResponses, toResponsesWire };
