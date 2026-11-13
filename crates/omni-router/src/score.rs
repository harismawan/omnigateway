//! Scoring (`packages/router/src/score.ts`).

use crate::filters::Pair;
use crate::quota::quota_headroom;
use crate::rank::{Candidate, RankInput, Reasons};
use crate::snapshot::health_key;
use omni_ir::js::math_min;
use omni_ir::request::ChatRequest;
use omni_ir::tokens::estimate_input_and_cached_tokens;
use omni_store::models::Target;
use omni_store::{BreakerState, CredentialHealth};

/// Neutral value for a term with no data.
const UNKNOWN: f64 = 0.5;

/// Assumed output length when the request does not cap it lower.
const EXPECTED_OUTPUT_TOKENS: f64 = 1000.0;

fn lower_is_better(value: f64, min: f64, max: f64) -> f64 {
    if max == min {
        1.0
    } else {
        (max - value) / (max - min)
    }
}

fn ratio(value: f64, min: f64) -> f64 {
    math_min(1.0, min / value)
}

/// The smallest positive value, or `None`.
fn best_positive(values: impl Iterator<Item = f64>) -> Option<f64> {
    values.filter(|v| *v > 0.0).fold(None, |best, v| {
        Some(best.map_or(v, |b: f64| math_min(b, v)))
    })
}

struct TokenEstimate {
    cached: f64,
    fresh: f64,
    out: f64,
}

fn estimate_tokens(request: &ChatRequest) -> TokenEstimate {
    let (input, cached) = estimate_input_and_cached_tokens(request);
    let fresh = (input - cached).max(0.0);
    let out = request.max_tokens.map_or(EXPECTED_OUTPUT_TOKENS, |m| {
        math_min(m, EXPECTED_OUTPUT_TOKENS)
    });
    TokenEstimate { cached, fresh, out }
}

fn request_cost(target: &Target, t: &TokenEstimate) -> f64 {
    let p = &target.cost_per_m_tok;
    t.fresh * p.input + t.cached * p.cache_read_rate() + t.out * p.output
}

/// `healthScore`, shared with the weighted draw.
#[allow(clippy::cast_precision_loss)]
pub fn health_score(h: Option<&CredentialHealth>) -> f64 {
    let base = h.map_or(1.0, omni_store::CredentialHealth::health_score);
    match h.map(|h| &h.breaker_state) {
        Some(BreakerState::Open | BreakerState::HalfOpen) => base * 0.5,
        _ => base,
    }
}

pub(crate) fn score<'a>(pairs: &[Pair<'a>], input: &RankInput<'a>) -> Vec<Candidate<'a>> {
    let snapshot = input.snapshot;
    let w = &snapshot.settings.weights;

    let min_tier = pairs
        .iter()
        .map(|p| p.target.tier)
        .fold(f64::INFINITY, math_min);
    let max_tier = pairs
        .iter()
        .map(|p| p.target.tier)
        .fold(f64::NEG_INFINITY, omni_ir::js::math_max);

    let tokens = estimate_tokens(input.request);
    let costs: Vec<f64> = pairs
        .iter()
        .map(|p| request_cost(p.target, &tokens))
        .collect();
    let best_cost = best_positive(costs.iter().copied());

    let ewma_of = |key: &str| {
        input
            .recent
            .and_then(|r| r.get(key))
            .and_then(|r| r.ewma_ttft_ms)
    };
    let keys: Vec<String> = pairs
        .iter()
        .map(|p| health_key(&p.credential.id, &p.target.model))
        .collect();
    let best_latency = best_positive(keys.iter().filter_map(|k| ewma_of(k)));

    pairs
        .iter()
        .zip(keys.iter())
        .zip(costs.iter())
        .map(|((pair, key), own_cost)| {
            let h = snapshot.health.get(key);
            let tier = lower_is_better(pair.target.tier, min_tier, max_tier);
            let inflight = input.load.and_then(|l| l.get(key)).copied().unwrap_or(0.0);
            let load = 1.0 / (1.0 + inflight);
            let health = health_score(h);
            let quota = quota_headroom(
                pair.credential,
                snapshot.quota_of(&pair.credential.id),
                input.now,
                snapshot.settings.quota_poll_interval_ms,
            );
            let cost = match best_cost {
                Some(best) if *own_cost > 0.0 => ratio(*own_cost, best),
                _ => UNKNOWN,
            };
            let latency = match (ewma_of(key), best_latency) {
                (Some(e), Some(best)) if e > 0.0 => ratio(e, best),
                _ => UNKNOWN,
            };
            let reasons = Reasons {
                tier,
                health,
                quota,
                cost,
                latency,
                load,
            };
            let base = tier * w.tier
                + health * w.health
                + quota * w.quota
                + cost * w.cost
                + latency * w.latency
                + load * w.load;
            Candidate {
                credential: pair.credential,
                target: pair.target,
                probe: pair.probe,
                score: base * pair.credential.weight * pair.target.weight,
                reasons,
            }
        })
        .collect()
}
