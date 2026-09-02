import { GatewayError, type ProviderId, safeToken } from "@omni/ir";
import { entryLimits, entryPricing } from "@omni/providers/catalog";
import {
  PROVIDER_DESCRIPTORS,
  type ProviderDescriptor,
  type ProviderDescriptors,
} from "@omni/providers/descriptors";
import type { Target, VirtualModel } from "@omni/store";
import type { Snapshot } from "./types.ts";

// Both provider imports are leaf subpaths carrying model lists and per-provider
// data — no adapters, no HTTP client, no I/O. The router stays pure by reading
// records it is handed, and these are handed to it at module scope.

/**
 * Prefixes for bare model names, so a client can pass a concrete upstream model
 * without configuring a virtual model first. Longest match wins.
 *
 * Assembled from the descriptors and sorted longest-first, which is what makes
 * the sentence above true rather than merely accurate today. The hand-written
 * table it replaced was iterated in declaration order and happened to contain no
 * prefix of another prefix, so the two readings agreed — but a provider adding
 * one would have inherited the wrong rule silently.
 *
 * Built per call, not once at import. `loadPlugins()` runs long after this
 * module is imported, so a snapshot here would leave a provider registered at
 * boot unable to be reached by its own `modelPrefixes` — while the explicit
 * `provider/model` branch below, which reads the registry directly, would route
 * it fine. That split lived inside this one function until it was measured:
 * `late-arrival/x` resolved and `latearr-1` did not.
 *
 * The cost is one walk of six descriptors and a sort per unconfigured bare name,
 * on a path that is about to make a network call. If that ever matters, cache it
 * against the registry's identity rather than reverting to a snapshot.
 */
function prefixProviders(
  providers: ProviderDescriptors,
): ReadonlyArray<readonly [string, ProviderId, ProviderDescriptor]> {
  return Object.entries(providers)
    .flatMap(([id, descriptor]) =>
      descriptor.modelPrefixes.map((prefix) => [prefix, id as ProviderId, descriptor] as const),
    )
    .sort(([a], [b]) => b.length - a.length);
}

/**
 * The descriptor is passed in rather than looked up again.
 *
 * Both callers have already resolved one — that is how they decided this is a
 * provider at all — and a second lookup here would be partial under a widened
 * `ProviderId`, inviting a non-null assertion at the one place the caller
 * already holds the answer.
 */
function synthesize(
  provider: ProviderId,
  model: string,
  descriptor: ProviderDescriptor,
): VirtualModel {
  // Priced from the descriptor this function was handed, not from the id-keyed
  // global. They hold the same object for a built-in, and only the descriptor
  // has anything at all for a provider that arrived from `<root>/plugins/`:
  // `registerProvider` mutates `PROVIDER_DESCRIPTORS` and deliberately not
  // `PROVIDER_MODEL_CATALOG`. Reading the global here priced every plugin
  // provider's model at zero, which the scorer reads as "unpriced" and
  // `priceOf` bills as free — no throw, no degradation, a `costUsd` of 0 and
  // spend limits that never accumulate. `capabilities` two lines down already
  // read the descriptor; these did not.
  //
  // A model the descriptor does not list still stays at zero, which is the
  // documented "unpriced" case and the operator's cue to configure a virtual
  // model stating the price they actually pay.
  const listed = entryPricing(descriptor.catalog, model);
  // The same treatment for limits, so a synthesized target is shaped like a
  // configured one. Nothing reads them yet — `/v1/models` lists only configured
  // models — but a target that carried prices and not limits would be a trap
  // for the next reader of this function.
  const limits = entryLimits(descriptor.catalog, model);
  const target: Target = {
    provider,
    model,
    tier: 1,
    weight: 1,
    costPerMTok:
      listed === null
        ? { input: 0, output: 0 }
        : {
            input: listed.input,
            output: listed.output,
            cacheRead: listed.cacheRead,
            cacheWrite5m: listed.cacheWrite5m,
            cacheWrite1h: listed.cacheWrite1h,
          },
    ...(limits === null
      ? {}
      : { contextWindow: limits.contextWindow, maxOutputTokens: limits.maxOutputTokens }),
    capabilities: descriptor.capabilities,
  };
  return { id: `${provider}/${model}`, targets: [target], strategy: "score", isAlias: true };
}

/**
 * Turns a client-supplied model name into a virtual model.
 *
 * Concrete names become single-target virtual models so that routing has one
 * code path: a direct passthrough is just a degenerate load-balancing pool.
 */
export function resolveModel(
  name: string,
  snapshot: Snapshot,
  // Defaults to the real registry; a caller may describe a different
  // installation. See `RankInput.providers` for why this is a parameter.
  providers: ProviderDescriptors = PROVIDER_DESCRIPTORS,
): VirtualModel {
  const configured = snapshot.models.get(name);
  if (configured !== undefined) return configured;

  const sep = name.search(/[/:]/);
  if (sep > 0) {
    const prefix = name.slice(0, sep);
    const rest = name.slice(sep + 1);
    // `Object.hasOwn`, because `providers` may be a caller's own object literal
    // and not only the null-prototype registry. This lookup replaced a
    // `Set.has` — which never consults a prototype — and against an ordinary
    // literal it admitted `constructor/x` and `toString/x`, then threw a
    // `TypeError` out of `synthesize` that reached the client as a 500 carrying
    // an internal expression.
    const descriptor = Object.hasOwn(providers, prefix) ? providers[prefix] : undefined;
    if (descriptor !== undefined && prefix !== "custom" && rest.length > 0) {
      return synthesize(prefix, rest, descriptor);
    }
    // Both bounded. `model` is `z.string().min(1)` on every surface, and this
    // split is on `/` and `:` — ordinary prose contains a colon, so a whole
    // prompt can arrive here as a "model name". This refusal names no provider,
    // so `reasonField` prints it, and unlike the allowlist check in `proxy.ts`
    // this fires on the default configuration.
    throw new GatewayError(
      "NO_CANDIDATES",
      `unknown provider "${safeToken(prefix)}" in model "${safeToken(name)}"`,
    );
  }

  for (const [prefix, provider, descriptor] of prefixProviders(providers)) {
    if (name.startsWith(prefix)) return synthesize(provider, name, descriptor);
  }

  throw new GatewayError(
    "NO_CANDIDATES",
    `model "${safeToken(name)}" is not a configured virtual model and its provider could not be inferred`,
  );
}
