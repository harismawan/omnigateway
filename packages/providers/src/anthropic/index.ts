import { GatewayError, PROVIDER_CAPABILITIES } from "@omni/ir";
import { applyAnthropicSystem, BODY_ORDER, orderFields, signAnthropicBody } from "../body.ts";
import { httpError } from "../http.ts";
import { mergeHeaders, orderHeaders, PROFILES } from "../profile.ts";
import { parseSse } from "../sse.ts";
import type { AdapterRequest, AdapterResult, HeaderPair, ProviderAdapter } from "../types.ts";
import { decodeAnthropic } from "./decode.ts";
import { toWire } from "./wire.ts";

const BASE_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const OAUTH_BETA = "oauth-2025-04-20";

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  capabilities: PROVIDER_CAPABILITIES.anthropic,

  async send(req: AdapterRequest): Promise<AdapterResult> {
    const oauth = req.credentials.accessToken !== null;
    const { body, degradations } = toWire(req.request, req.model, { oauth });

    // The billing block and the agent preamble go in as system blocks, and
    // the cch token is computed over the finished bytes, so this has to run
    // before serialization.
    const withSystem: Record<string, unknown> = {
      ...body,
      system: applyAnthropicSystem(body.system ?? []),
    };

    const protocol: HeaderPair[] = [
      ["Content-Type", "application/json"],
      ["anthropic-version", API_VERSION],
      ["Accept", req.request.stream ? "text/event-stream" : "application/json"],
    ];

    if (oauth) {
      protocol.push(["Authorization", `Bearer ${req.credentials.accessToken}`]);
      protocol.push(["anthropic-beta", OAUTH_BETA]);
    } else if (req.credentials.apiKey !== null) {
      protocol.push(["x-api-key", req.credentials.apiKey]);
    } else {
      throw new GatewayError("AUTH", "anthropic credential has no token", {
        provider: "anthropic",
      });
    }

    const profile = PROFILES.anthropic;
    const headers = orderHeaders(mergeHeaders(profile.headers, protocol), profile.order);

    // Order the fields, serialize, then swap the cch placeholder for a token
    // over those exact bytes. Substitution is length-preserving.
    const bodyString = signAnthropicBody(
      JSON.stringify(orderFields(withSystem, BODY_ORDER.anthropic)),
    );

    const res = await req.http({
      url: BASE_URL,
      method: "POST",
      headers,
      body: bodyString,
      signal: req.signal,
    });

    if (res.status < 200 || res.status >= 300) throw await httpError(res, "anthropic");
    if (res.body === null)
      throw new GatewayError("UPSTREAM", "empty response body", { provider: "anthropic" });

    return { events: decodeAnthropic(parseSse(res.body)), degradations };
  },
};

export { decodeAnthropic, toWire };
