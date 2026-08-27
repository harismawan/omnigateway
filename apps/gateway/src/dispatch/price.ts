import type { ProviderId, Usage } from "@omni/ir";
import { PROVIDER_DESCRIPTORS } from "@omni/providers/descriptors";
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
export function priceOf(prices: TargetPricing, usage: Usage, provider: ProviderId): number {
  // What this provider charges to create a cache entry, as a multiple of its
  // base input price. Only a fallback: a target saved before write pricing
  // existed carries `input`, `output` and `cacheRead` and nothing else, and the
  // catalog now gives every new target an explicit figure. Per provider rather
  // than one constant because the answers are opposite — Anthropic bills a write
  // at more than fresh input, while OpenAI and Kimi cache automatically and bill
  // no premium. Guessing Anthropic's rate for a Kimi target overcharges exactly
  // the tokens its decoder now reports.
  //
  // A provider id is a validated string, so this lookup is partial in the type.
  // It is not partial in practice: the router excludes a target whose provider
  // has no descriptor, and dispatch throws `INTERNAL` before the first byte if
  // one reaches it anyway — so a priced request has an installed provider by
  // the time it gets here. Zero is what an unreachable branch evaluates to, not
  // a claim that writes are free; the loud failure is upstream, where it can
  // still change the outcome.
  const fallback = PROVIDER_DESCRIPTORS[provider]?.writeOverInput ?? {
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
