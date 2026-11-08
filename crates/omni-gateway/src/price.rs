//! `priceOf` (`dispatch/price.ts`): one request's cost in dollars.

use omni_ir::stream::Usage;
use omni_store::models::TargetPricing;

/// `writeOverInput` per provider descriptor (five-minute, one-hour).
fn write_over_input(provider: &str) -> (f64, f64) {
    match provider {
        "anthropic" => (1.25, 2.0),
        _ => (0.0, 0.0),
    }
}

/// `splitWrites`.
fn split_writes(u: &Usage) -> (f64, f64) {
    match (u.cache_write_5m_tokens, u.cache_write_1h_tokens) {
        (Some(five), Some(hour)) => (five, hour),
        (Some(five), None) => (
            five,
            omni_ir::js::math_max(0.0, u.cache_write_tokens - five),
        ),
        (None, Some(hour)) => (
            omni_ir::js::math_max(0.0, u.cache_write_tokens - hour),
            hour,
        ),
        (None, None) => (u.cache_write_tokens, 0.0),
    }
}

/// `priceOf(prices, usage, provider)`.
pub fn price_of(prices: &TargetPricing, usage: &Usage, provider: &str) -> f64 {
    let (five_fallback, hour_fallback) = write_over_input(provider);
    let read_rate = prices.cache_read_rate();
    let write5 = prices
        .cache_write_5m
        .unwrap_or(prices.input * five_fallback);
    let write1h = prices
        .cache_write_1h
        .unwrap_or(prices.input * hour_fallback);
    let (five, hour) = split_writes(usage);
    (usage.input_tokens * prices.input
        + usage.output_tokens * prices.output
        + usage.cache_read_tokens * read_rate
        + five * write5
        + hour * write1h)
        / 1_000_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pricing(input: f64, output: f64) -> TargetPricing {
        TargetPricing {
            input,
            output,
            cache_read: None,
            cache_write_5m: None,
            cache_write_1h: None,
            extra: serde_json::Map::new(),
        }
    }

    #[test]
    fn prices_like_ts() {
        let u = Usage {
            input_tokens: 64.0,
            output_tokens: 6.0,
            ..Usage::default()
        };
        // The TS gateway logged 7.6e-05 for this request.
        assert_eq!(price_of(&pricing(1.0, 2.0), &u, "custom"), 7.6e-5);
        let cached = Usage {
            input_tokens: 0.0,
            cache_read_tokens: 1000.0,
            cache_write_tokens: 1000.0,
            ..Usage::default()
        };
        // Read at a tenth of input; writes at 1.25× on Anthropic, free elsewhere.
        // Bun: 0.0003000000000000001.
        assert_eq!(
            price_of(&pricing(3.0, 15.0), &cached, "custom"),
            0.000_300_000_000_000_000_1
        );
        assert!((price_of(&pricing(3.0, 15.0), &cached, "anthropic") - 0.00405).abs() < 1e-15);
    }
}
