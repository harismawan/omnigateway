import { GatewayError, PROVIDER_CAPABILITIES } from "@omni/ir";
import type { AdapterRequest, AdapterResult, ProviderAdapter } from "../types.ts";

/**
 * Placeholder so `ADAPTERS` stays exhaustive while the provider id, catalog,
 * profile and routing land ahead of the wire format.
 *
 * A registered id with no adapter would be worse than this: the router would
 * offer grok targets and dispatch would fail on an undefined lookup rather than
 * on a typed upstream error.
 */
// TODO(phase 2): replace with the real Responses adapter — wire.ts, decode.ts,
// and URL selection by credential type (cli-chat-proxy for OAuth, api.x.ai for
// an API key).
export const grokAdapter: ProviderAdapter = {
  id: "grok",
  capabilities: PROVIDER_CAPABILITIES.grok,

  // Rejects rather than throwing synchronously, so a caller that never awaits
  // still sees a rejected promise instead of an exception mid-call.
  async send(_req: AdapterRequest): Promise<AdapterResult> {
    throw new GatewayError("UPSTREAM", "grok adapter not implemented", { provider: "grok" });
  },
};
