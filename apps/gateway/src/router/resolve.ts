import { GatewayError, PROVIDER_CAPABILITIES, type ProviderId } from "@omni/ir";
import type { Target, VirtualModel } from "@omni/store";
import type { Snapshot } from "./types.ts";

const PROVIDERS = new Set<string>(Object.keys(PROVIDER_CAPABILITIES));

/**
 * Prefixes for bare model names, so a client can pass a concrete upstream model
 * without configuring a virtual model first. Longest match wins.
 */
const PREFIX_PROVIDER: ReadonlyArray<readonly [string, ProviderId]> = [
  ["claude-", "anthropic"],
  ["gpt-", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["kimi-", "kimi"],
  ["moonshot", "kimi"],
];

function synthesize(provider: ProviderId, model: string): VirtualModel {
  const target: Target = {
    provider,
    model,
    tier: 1,
    weight: 1,
    // Unknown to the operator, so cost scoring contributes nothing and the
    // remaining terms decide. Configure a virtual model to price it.
    costPerMTok: { input: 0, output: 0 },
    capabilities: PROVIDER_CAPABILITIES[provider],
  };
  return { id: `${provider}/${model}`, targets: [target], strategy: "score", isAlias: true };
}

/**
 * Turns a client-supplied model name into a virtual model.
 *
 * Concrete names become single-target virtual models so that routing has one
 * code path: a direct passthrough is just a degenerate load-balancing pool.
 */
export function resolveModel(name: string, snapshot: Snapshot): VirtualModel {
  const configured = snapshot.models.get(name);
  if (configured !== undefined) return configured;

  const sep = name.search(/[/:]/);
  if (sep > 0) {
    const prefix = name.slice(0, sep);
    const rest = name.slice(sep + 1);
    if (PROVIDERS.has(prefix) && rest.length > 0) {
      return synthesize(prefix as ProviderId, rest);
    }
    throw new GatewayError("NO_CANDIDATES", `unknown provider "${prefix}" in model "${name}"`);
  }

  for (const [prefix, provider] of PREFIX_PROVIDER) {
    if (name.startsWith(prefix)) return synthesize(provider, name);
  }

  throw new GatewayError(
    "NO_CANDIDATES",
    `model "${name}" is not a configured virtual model and its provider could not be inferred`,
  );
}
