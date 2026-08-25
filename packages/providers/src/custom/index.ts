import { GatewayError, PROVIDER_CAPABILITIES, type ReasoningConfig } from "@omni/ir";
import { httpError } from "../http.ts";
import { decodeKiloChat } from "../kilo/decode.ts";
import { toChatWire } from "../kimi/wire.ts";
import { decodeResponses } from "../openai/decode.ts";
import { toResponsesWire } from "../openai/wire.ts";
import { parseSse } from "../sse.ts";
import type { AdapterRequest, AdapterResult, HeaderPair, ProviderAdapter } from "../types.ts";

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

/**
 * Forwards the client's thinking level onto the wire, verbatim.
 *
 * Both OpenAI-compatible surfaces carry a coarse effort string, and a custom
 * server answers for its own model vocabulary, so the value crosses unclamped
 * and unmapped — including levels the big two would refuse. Nothing is
 * fabricated either: an absent config and an explicit `off` stay off the body,
 * and a token budget, which neither surface can express, is recorded rather
 * than mapped onto an invented effort.
 *
 * Runs after the codec so an explicitly set `vendor.openai` field keeps
 * precedence: a client that supplied that raw field asked for it, not for a
 * derived one.
 */
function applyReasoning(
  body: Record<string, unknown>,
  reasoning: ReasoningConfig | undefined,
  protocol: Protocol,
): string[] {
  if (reasoning === undefined || reasoning.mode === "off") return [];
  if (reasoning.mode === "budget") return ["custom:reasoning-budget-dropped"];
  const effort = reasoning.effort ?? "medium";
  if (protocol === "chat_completions") {
    if (body.reasoning_effort === undefined) body.reasoning_effort = effort;
  } else if (body.reasoning === undefined) {
    body.reasoning = { effort, summary: "auto" };
  }
  return [];
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
    // The shared codecs serve providers whose surfaces mangle or drop the
    // thinking level, and would note that themselves; custom owns the field,
    // so hand them a request without it and forward it directly below. The
    // copy is shallow — `req.request` is shared across attempts and is never
    // written to.
    const request = { ...req.request };
    delete request.reasoning;
    const encoded =
      protocol === "chat_completions"
        ? toChatWire(request, req.model, "openai")
        : toResponsesWire(request, req.model);
    const reasoningDegradations = applyReasoning(encoded.body, req.request.reasoning, protocol);
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
      // Kilo's chat decoder, not Kimi's: a custom server may reason in any of
      // the spellings OpenRouter normalizes (`reasoning`, `reasoning_content`,
      // `reasoning_details`), and those deltas must reach the client as
      // unsigned thinking rather than vanish. Everything else the two decoders
      // read is identical.
      events:
        protocol === "chat_completions"
          ? decodeKiloChat(parseSse(res.body))
          : decodeResponses(parseSse(res.body)),
      degradations: [
        ...encoded.degradations.map((value) =>
          value.replace(protocol === "chat_completions" ? /^kimi:/ : /^openai:/, "custom:"),
        ),
        ...reasoningDegradations,
      ],
    };
  },
};
