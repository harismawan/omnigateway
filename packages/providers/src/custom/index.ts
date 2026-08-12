import { GatewayError, PROVIDER_CAPABILITIES } from "@omni/ir";
import { httpError } from "../http.ts";
import { decodeChat } from "../kimi/decode.ts";
import { toChatWire } from "../kimi/wire.ts";
import { decodeResponses } from "../openai/decode.ts";
import { toResponsesWire } from "../openai/wire.ts";
import { parseSse } from "../sse.ts";
import type { AdapterRequest, AdapterResult, HeaderPair, ProviderAdapter } from "../types.ts";

type Protocol = "chat_completions" | "responses";

function metadata(data: Record<string, unknown>): { origin: string; protocol: Protocol } {
  const { origin, protocol } = data;
  if (typeof origin !== "string" || (protocol !== "chat_completions" && protocol !== "responses")) {
    throw new GatewayError("BAD_REQUEST", "custom credential has invalid endpoint metadata");
  }
  return { origin, protocol };
}

export const customAdapter: ProviderAdapter = {
  id: "custom",
  capabilities: PROVIDER_CAPABILITIES.custom,

  async send(req: AdapterRequest): Promise<AdapterResult> {
    const apiKey = req.credentials.apiKey;
    if (apiKey === null) {
      throw new GatewayError("AUTH", "custom credential has no API key", { provider: "custom" });
    }
    const { origin, protocol } = metadata(req.credentials.providerData);
    const encoded =
      protocol === "chat_completions"
        ? toChatWire(req.request, req.model, "openai")
        : toResponsesWire(req.request, req.model);
    const headers: HeaderPair[] = [
      ["Content-Type", "application/json"],
      ["Authorization", `Bearer ${apiKey}`],
    ];
    const res = await req.http({
      provider: "custom",
      url: `${origin}/v1/${protocol === "chat_completions" ? "chat/completions" : "responses"}`,
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
          ? decodeChat(parseSse(res.body))
          : decodeResponses(parseSse(res.body)),
      degradations: encoded.degradations.map((value) =>
        value.replace(protocol === "chat_completions" ? /^kimi:/ : /^openai:/, "custom:"),
      ),
    };
  },
};
