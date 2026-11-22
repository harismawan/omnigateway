//! `rank`: the router's entry point.

use crate::filters::{Excluded, eligible};
use crate::providers::Providers;
use crate::quota::{QUOTA_FLOOR, quota_headroom};
use crate::score::{health_score, score};
use crate::snapshot::{Snapshot, health_key};
use crate::{or_else, stable_sort};
use omni_ir::request::ChatRequest;
use omni_store::{Credential, Strategy, Target, VirtualModel};
use std::collections::HashMap;

/// This process's record of a (credential, model) pair.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RecentUse {
    /// When this process last finished a request there.
    pub last_released_at: f64,
    /// Exponentially weighted time-to-first-token, or `None` unmeasured.
    pub ewma_ttft_ms: Option<f64>,
}

/// `RankInput`.
#[derive(Debug, Clone, Copy)]
pub struct RankInput<'a> {
    pub request: &'a ChatRequest,
    pub model: &'a VirtualModel,
    pub snapshot: &'a Snapshot,
    pub now: f64,
    /// Range [0, 1); injected so weighted selection stays pure.
    pub rand: f64,
    /// In-flight count per [`health_key`]; missing means zero.
    pub load: Option<&'a HashMap<String, f64>>,
    pub recent: Option<&'a HashMap<String, RecentUse>>,
    /// The installation's providers; `None` is the built-in registry.
    pub providers: Option<&'a Providers>,
}

/// Per-term contributions, surfaced in the request log.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Reasons {
    pub tier: f64,
    pub health: f64,
    pub quota: f64,
    pub cost: f64,
    pub latency: f64,
    pub load: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct Candidate<'a> {
    pub credential: &'a Credential,
    pub target: &'a Target,
    pub probe: bool,
    pub score: f64,
    pub reasons: Reasons,
}

#[derive(Debug, Clone, Default)]
pub struct RankResult<'a> {
    /// Best first; dispatch walks this list on retryable failure.
    pub candidates: Vec<Candidate<'a>>,
    pub excluded: Vec<Excluded>,
}

/// Head drawn by weight over arrival order; tail in score order.
fn weighted_shuffle<'a>(
    candidates: Vec<Candidate<'a>>,
    rand: f64,
    draw_weight: impl Fn(&Candidate<'a>) -> f64,
) -> Vec<Candidate<'a>> {
    let by_score = |a: &Candidate<'_>, b: &Candidate<'_>| b.score - a.score;
    let total: f64 = candidates.iter().map(&draw_weight).sum();
    // `total <= 0` is false for NaN in JS, which then draws; so does this.
    if total <= 0.0 {
        let mut sorted = candidates;
        stable_sort(&mut sorted, by_score);
        return sorted;
    }
    let mut cursor = rand * total;
    let mut chosen = candidates.len() - 1;
    for (i, c) in candidates.iter().enumerate() {
        cursor -= draw_weight(c);
        if cursor < 0.0 {
            chosen = i;
            break;
        }
    }
    let mut rest = candidates;
    let head = rest.remove(chosen);
    stable_sort(&mut rest, by_score);
    rest.insert(0, head);
    rest
}

/// `rank`.
pub fn rank<'a>(input: &RankInput<'a>) -> RankResult<'a> {
    let elig = eligible(input);
    if elig.pairs.is_empty() {
        return RankResult {
            candidates: Vec::new(),
            excluded: elig.excluded,
        };
    }
    let mut scored = score(&elig.pairs, input);
    let snapshot = input.snapshot;

    let headroom = |c: &Candidate<'_>| {
        quota_headroom(
            c.credential,
            snapshot.quota_of(&c.credential.id),
            input.now,
            snapshot.settings.quota_poll_interval_ms,
        )
    };
    let key = |c: &Candidate<'_>| health_key(&c.credential.id, &c.target.model);

    match &input.model.strategy {
        Strategy::Priority => {
            stable_sort(&mut scored, |a, b| {
                or_else(a.target.tier - b.target.tier, || b.score - a.score)
            });
        }
        Strategy::RoundRobin => {
            let inflight = |c: &Candidate<'_>| {
                input
                    .load
                    .and_then(|l| l.get(&key(c)))
                    .copied()
                    .unwrap_or(0.0)
            };
            let idle = |c: &Candidate<'_>| {
                input
                    .recent
                    .and_then(|r| r.get(&key(c)))
                    .map_or(f64::INFINITY, |r| input.now - r.last_released_at)
            };
            let spent = |c: &Candidate<'_>| if headroom(c) < QUOTA_FLOOR { 1.0 } else { 0.0 };
            stable_sort(&mut scored, |a, b| {
                or_else(spent(a) - spent(b), || {
                    or_else(inflight(a) - inflight(b), || idle(b) - idle(a))
                })
            });
        }
        Strategy::Weighted => {
            let candidates = weighted_shuffle(scored, input.rand, |c| {
                c.credential.weight
                    * c.target.weight
                    * headroom(c)
                    * health_score(snapshot.health.get(&key(c)))
            });
            return RankResult {
                candidates,
                excluded: elig.excluded,
            };
        }
        Strategy::Score => stable_sort(&mut scored, |a, b| b.score - a.score),
        // A strategy name this build does not know matches no case,
        // which leaves the scored list in pair order.
        Strategy::Other(_) => {}
    }
    RankResult {
        candidates: scored,
        excluded: elig.excluded,
    }
}
