import type { ProviderId, Usage } from "@omni/ir";
import { PROVIDER_DESCRIPTORS, type ProviderDescriptors } from "@omni/providers/descriptors";
import { cacheReadRate, type TargetPricing } from "@omni/store/types";

/**
 * Splits cache-creation tokens by the TTL each write bought.
 *
 * The breakdown and the aggregate are reported together and the parts sum to
 * it, so whichever side is missing is the remainder. Symmetric on purpose:
 * deriving only one direction would price the other's shortfall at zero if an
 * upstream ever reported a partial breakdown.
 *
 * When both parts are present they are trusted over the aggregate, and that
 * sum is not reconciled. An upstream reporting parts that fall short of its
 * own aggregate would price the difference at zero while the request log kept
 * the larger figure. Deliberate: the aggregate is documented as their sum, and
 * inventing a split for a provider that contradicted itself would be a guess
 * about which TTL the missing tokens bought.
 */
function splitWrites(usage: Usage): { fiveMinute: number; oneHour: number } {
  const { cacheWrite5mTokens: five, cacheWrite1hTokens: hour, cacheWriteTokens: total } = usage;
  if (five !== undefined && hour !== undefined) return { fiveMinute: five, oneHour: hour };
  if (five !== undefined) return { fiveMinute: five, oneHour: Math.max(0, total - five) };
  if (hour !== undefined) return { fiveMinute: Math.max(0, total - hour), oneHour: hour };
  // Nothing reported: a marker without an explicit TTL asks for five minutes.
  return { fiveMinute: total, oneHour: 0 };
}

/**
 * What one request cost, in dollars, at the prices the operator saved.
 *
 * `inputTokens` is the uncached remainder, so the token classes are disjoint
 * and each is priced once.
 */
export function priceOf(
  prices: TargetPricing,
  usage: Usage,
  provider: ProviderId,
  // The registry to price against, symmetric with `resolveModel`, `rank` and
  // `providerCatalog`. Defaults to the real one, so production is unchanged.
  //
  // Added because threading `deps.providers` into routing and *not* into here
  // made the two disagree: a provider present in the injected registry and
  // absent from the module-global one routed, dispatched, and then priced its
  // cache writes at zero — a $12.50 write billed $0.00, with no throw and no
  // log line. The coupling this function's safety rests on is only a coupling
  // if every party reads the same registry.
  providers: ProviderDescriptors = PROVIDER_DESCRIPTORS,
): number {
  // What this provider charges to create a cache entry, as a multiple of its
  // base input price. Only a fallback: a target saved before write pricing
  // existed carries `input`, `output` and `cacheRead` and nothing else, and the
  // catalog now gives every new target an explicit figure. Per provider rather
  // than one constant because the answers are opposite — Anthropic bills a write
  // at more than fresh input, while OpenAI and Kimi cache automatically and bill
  // no premium. Guessing Anthropic's rate for a Kimi target overcharges exactly
  // the tokens its decoder now reports.
  //
  // **A known, accepted exception to "the descriptor has no defaults"**, which
  // exists precisely so `writeOverInput` can never default to zero. It does here.
  //
  // A provider id is a validated string, so this lookup is partial in the type.
  // What keeps it from being partial in practice is a coupling between three
  // call sites, not anything this function does: the router excludes a target
  // whose provider has no descriptor (`provider:missing`), and dispatch throws
  // `INTERNAL` on a missing adapter before the first byte. That coupling holds
  // only while all three read the *same* registry, which is why `providers` is
  // a parameter and why dispatch passes its own down — for one round it did not,
  // and the two sources could disagree.
  //
  // Throwing instead is not available: `priceOf` runs inside `finishLog`, which
  // must run at most once per request id and is what writes usage — a throw
  // there loses accounting for a request that already succeeded.
  //
  // **The risk if that coupling loosens is silent**: cache writes priced at
  // zero, no log line, no degradation, a `costUsd` that is simply too low.
  // Nothing here would notice. The plugin host is expected to loosen it, and the
  // fix then is to thread the descriptor down with the candidate — routing has
  // already resolved one — or to price from `Target.costPerMTok` alone. Recorded
  // in `docs/superpowers/specs/2026-08-27-widening-provider-id-design.md`.
  const fallback = providers[provider]?.writeOverInput ?? {
    fiveMinute: 0,
    oneHour: 0,
  };
  const readRate = cacheReadRate(prices);
  const write5mRate = prices.cacheWrite5m ?? prices.input * fallback.fiveMinute;
  const write1hRate = prices.cacheWrite1h ?? prices.input * fallback.oneHour;
  const writes = splitWrites(usage);

  return (
    (usage.inputTokens * prices.input +
      usage.outputTokens * prices.output +
      usage.cacheReadTokens * readRate +
      writes.fiveMinute * write5mRate +
      writes.oneHour * write1hRate) /
    1_000_000
  );
}
