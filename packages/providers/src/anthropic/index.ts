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
    //
    // The upstream leg always streams, whatever the client asked for, as it
    // does for the other two providers: dispatch collects events into a
    // buffered body when the client wants one, so a non-streaming request
    // needs an event stream to collect. Asking for JSON here and then parsing
    // the reply as SSE yields no events at all. Streaming also keeps bytes
    // moving on a long generation instead of holding one response open, and
    // it is what the client this adapter mimics actually sends.
    const withSystem: Record<string, unknown> = {
      ...body,
      system: applyAnthropicSystem(body.system ?? []),
      stream: true,
    };

    const protocol: HeaderPair[] = [
      ["Content-Type", "application/json"],
      ["anthropic-version", API_VERSION],
      // Constant, because the request above always streams.
      ["Accept", "text/event-stream"],
    ];

    // The client's own betas ride along: the fields they authorise are already
    // forwarded through `vendor`, and Anthropic rejects such a field outright
    // when the header does not name its beta.
    const betas = new Set(req.request.betas ?? []);

    if (oauth) {
      protocol.push(["Authorization", `Bearer ${req.credentials.accessToken}`]);
      betas.add(OAUTH_BETA);
    } else if (req.credentials.apiKey !== null) {
      protocol.push(["x-api-key", req.credentials.apiKey]);
    } else {
      throw new GatewayError("AUTH", "anthropic credential has no token", {
        provider: "anthropic",
      });
    }

    if (betas.size > 0) protocol.push(["anthropic-beta", [...betas].join(",")]);

    const profile = PROFILES.anthropic;
    const headers = orderHeaders(mergeHeaders(profile.headers, protocol), profile.order);

    // Order the fields, serialize, then swap the cch placeholder for a token
    // over those exact bytes. Substitution is length-preserving.
    const bodyString = signAnthropicBody(
      JSON.stringify(orderFields(withSystem, BODY_ORDER.anthropic)),
    );

    const res = await req.http({
      provider: "anthropic",
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
