import type { Usage } from "@omni/ir";
import type { TargetPricing } from "@omni/store/types";

/**
 * Anthropic's published multipliers over base input, used only when a target
 * names no price of its own.
 *
 * A target saved before write pricing existed carries `input`, `output` and
 * `cacheRead` and nothing else. Charging zero for a cache write is the one
 * answer that is certainly wrong — those tokens cost more than fresh input,
 * not less — so the documented rates stand in until the operator saves real
 * ones. A provider that bills no write premium says so with an explicit zero,
 * which is a price and not a missing one.
 */
const WRITE_5M_OVER_INPUT = 1.25;
const WRITE_1H_OVER_INPUT = 2;
const READ_OVER_INPUT = 0.1;

/**
 * What one request cost, in dollars, at the prices the operator saved.
 *
 * `inputTokens` is the uncached remainder, so the four token classes are
 * disjoint and each is priced once. Cache writes are split by TTL when the
 * upstream reported the breakdown; an upstream that reported only the
 * aggregate is priced as 5m, which is what a marker without an explicit TTL
 * asks for.
 */
export function priceOf(prices: TargetPricing, usage: Usage): number {
  const readRate = prices.cacheRead ?? prices.input * READ_OVER_INPUT;
  const write5mRate = prices.cacheWrite5m ?? prices.input * WRITE_5M_OVER_INPUT;
  const write1hRate = prices.cacheWrite1h ?? prices.input * WRITE_1H_OVER_INPUT;

  const write1h = usage.cacheWrite1hTokens ?? 0;
  // Whatever the breakdown did not account for is 5m by default. When neither
  // field is present that is the whole aggregate; when both are, it is exactly
  // the 5m figure, because they sum to it.
  const write5m = usage.cacheWrite5mTokens ?? Math.max(0, usage.cacheWriteTokens - write1h);

  return (
    (usage.inputTokens * prices.input +
      usage.outputTokens * prices.output +
      usage.cacheReadTokens * readRate +
      write5m * write5mRate +
      write1h * write1hRate) /
    1_000_000
  );
}
