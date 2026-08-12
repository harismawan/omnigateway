import type { ProviderId, Usage } from "@omni/ir";
import type { TargetPricing } from "@omni/store/types";

/**
 * What a provider charges to create a cache entry, as a multiple of its base
 * input price, for a target that names no price of its own.
 *
 * Only used as a fallback: a target saved before write pricing existed carries
 * `input`, `output` and `cacheRead` and nothing else, and the catalog now
 * gives every new target an explicit figure. The default has to be per
 * provider rather than a single constant, because the two answers are
 * opposite — Anthropic bills a write at more than fresh input, while OpenAI
 * and Kimi cache automatically and bill no premium at all. Guessing
 * Anthropic's rate for a Kimi target overcharges exactly the tokens its
 * decoder now reports.
 */
const WRITE_OVER_INPUT: Readonly<Record<ProviderId, { fiveMinute: number; oneHour: number }>> = {
  anthropic: { fiveMinute: 1.25, oneHour: 2 },
  openai: { fiveMinute: 0, oneHour: 0 },
  kimi: { fiveMinute: 0, oneHour: 0 },
  custom: { fiveMinute: 0, oneHour: 0 },
};

const READ_OVER_INPUT = 0.1;

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
  const fallback = WRITE_OVER_INPUT[provider];
  const readRate = prices.cacheRead ?? prices.input * READ_OVER_INPUT;
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
