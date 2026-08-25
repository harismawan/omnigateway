import { GatewayError, PROVIDER_CAPABILITIES } from "@omni/ir";
import { httpError } from "../http.ts";
import { parseSse } from "../sse.ts";
import type { AdapterRequest, AdapterResult, HeaderPair, ProviderAdapter } from "../types.ts";
import { decodeCustomChat, decodeCustomResponses } from "./decode.ts";
import { toCustomChatWire, toCustomResponsesWire } from "./wire.ts";

type Protocol = "chat_completions" | "responses";

function metadata(data: Record<string, unknown>): {
  origin: string;
  basePath: string;
  protocol: Protocol;
} {
  const { origin, protocol } = data;
  if (typeof origin !== "string" || (protocol !== "chat_completions" && protocol !== "responses")) {
    throw new GatewayError("BAD_REQUEST", "custom credential has invalid endpoint metadata");
  }
  // Rows written before custom endpoints carried a base path have none.
  const basePath = typeof data.basePath === "string" ? data.basePath : "";
  return { origin, basePath, protocol };
}

/**
 * Joins stored endpoint metadata into the inference URL.
 *
 * The stored value may carry a base path (`https://host/api`), and operators
 * habitually enter OpenAI-SDK-style bases that already end in `/v1`, which a
 * blind `/v1` append would double. A bare-origin row therefore targets
 * `${origin}/v1/<suffix>` exactly as it always did, while a path-bearing row
 * targets `${origin}${basePath}/v1/<suffix>` unless its path already ends in
 * `/v1`.
 */
function endpointUrl(origin: string, basePath: string, protocol: Protocol): string {
  const suffix = protocol === "chat_completions" ? "chat/completions" : "responses";
  const base = `${origin}${basePath}`.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/${suffix}` : `${base}/v1/${suffix}`;
}

export const customAdapter: ProviderAdapter = {
  id: "custom",
  capabilities: PROVIDER_CAPABILITIES.custom,

  async send(req: AdapterRequest): Promise<AdapterResult> {
    const apiKey = req.credentials.apiKey;
    if (apiKey === null) {
      throw new GatewayError("AUTH", "custom credential has no API key", { provider: "custom" });
    }
    const { origin, basePath, protocol } = metadata(req.credentials.providerData);
    const encoded =
      protocol === "chat_completions"
        ? toCustomChatWire(req.request, req.model)
        : toCustomResponsesWire(req.request, req.model);
    const headers: HeaderPair[] = [
      ["Content-Type", "application/json"],
      ["Authorization", `Bearer ${apiKey}`],
    ];
    const res = await req.http({
      provider: "custom",
      url: endpointUrl(origin, basePath, protocol),
      method: "POST",
      headers,
      body: JSON.stringify({ ...encoded.body, stream: true }),
      signal: req.signal,
    });

    if (res.status < 200 || res.status >= 300) throw await httpError(res, "custom");
    if (res.body === null) {
      throw new GatewayError("UPSTREAM", "empty response body", { provider: "custom" });
    }

    return {
      events:
        protocol === "chat_completions"
          ? decodeCustomChat(parseSse(res.body))
          : decodeCustomResponses(parseSse(res.body)),
      degradations: encoded.degradations,
    };
  },
};
