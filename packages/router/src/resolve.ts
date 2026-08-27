import { GatewayError, type ProviderId } from "@omni/ir";
import { catalogLimits, catalogPricing } from "@omni/providers/catalog";
import { PROVIDER_DESCRIPTORS, type ProviderDescriptor } from "@omni/providers/descriptors";
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
function prefixProviders(): ReadonlyArray<readonly [string, ProviderId, ProviderDescriptor]> {
  return Object.entries(PROVIDER_DESCRIPTORS)
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
  // The catalog's list price, so a bare model name is cost-ranked like a
  // configured one. A model the catalog does not list stays at zero, which the
  // scorer reads as "unpriced" and drops from the cost term rather than
  // treating as free. Either way the operator can configure a virtual model to
  // state the price they actually pay.
  const listed = catalogPricing(provider, model);
  // The same treatment for limits, so a synthesized target is shaped like a
  // configured one. Nothing reads them yet — `/v1/models` lists only configured
  // models — but a target that carried prices and not limits would be a trap
  // for the next reader of this function.
  const limits = catalogLimits(provider, model);
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
export function resolveModel(name: string, snapshot: Snapshot): VirtualModel {
  const configured = snapshot.models.get(name);
  if (configured !== undefined) return configured;

  const sep = name.search(/[/:]/);
  if (sep > 0) {
    const prefix = name.slice(0, sep);
    const rest = name.slice(sep + 1);
    // `prefix` is a slice of a client-supplied model name, and this lookup
    // replaced a `Set.has` — which never consults a prototype. On an ordinary
    // object literal it therefore admitted `constructor/x` and `toString/x` and
    // threw a `TypeError` out of `synthesize`, which reached the client as a 500
    // carrying an internal expression. What makes the plain check correct is
    // that `PROVIDER_DESCRIPTORS` has no prototype to inherit from; that is one
    // invariant covering every reader of every provider table, and
    // `descriptor.test.ts` pins it.
    const descriptor = PROVIDER_DESCRIPTORS[prefix];
    if (descriptor !== undefined && prefix !== "custom" && rest.length > 0) {
      return synthesize(prefix, rest, descriptor);
    }
    throw new GatewayError("NO_CANDIDATES", `unknown provider "${prefix}" in model "${name}"`);
  }

  for (const [prefix, provider, descriptor] of prefixProviders()) {
    if (name.startsWith(prefix)) return synthesize(provider, name, descriptor);
  }

  throw new GatewayError(
    "NO_CANDIDATES",
    `model "${name}" is not a configured virtual model and its provider could not be inferred`,
  );
}
