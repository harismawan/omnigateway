//! Candidate ranking.
//!
//! Pure: no I/O and no clock. `now` and `rand` are parameters, so a ranking
//! is reproducible from its inputs alone. The router reads credentials from
//! the snapshot but never their secrets.
//!
//! Numbers follow JS: instants and scores are `f64`, `Math.min`/`Math.max`
//! propagate NaN, and sorts are stable with a NaN comparison reading as a
//! tie, as `Array.prototype.sort` treats one.

mod breaker;
mod filters;
mod model_limits;
mod providers;
mod quota;
mod rank;
mod resolve;
mod score;
mod snapshot;

pub use breaker::{
    Failure, Penalty, blank_health, penalty, record_failure, record_success, success_would_change,
};
pub use filters::{
    Eligible, Excluded, ExcludedKind, Pair, Required, eligible, required_capabilities,
    required_providers, serves_target,
};
pub use model_limits::{ServingCredentials, model_display_name, resolve_model_limits};
pub use providers::{CatalogModel, Descriptor, Providers};
pub use quota::{QUOTA_FLOOR, UNKNOWN_QUOTA, quota_headroom, quota_stale_after_ms};
pub use rank::{Candidate, RankInput, RankResult, Reasons, RecentUse, rank};
pub use resolve::{local_only_model, resolve_model};
pub use score::health_score;
pub use snapshot::{Snapshot, health_key};

use std::cmp::Ordering;

/// A JS comparator result as an ordering: NaN and zero are a tie.
pub(crate) fn order(d: f64) -> Ordering {
    if d < 0.0 {
        Ordering::Less
    } else if d > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

/// `a || b` over comparator results: the first that is neither 0 nor NaN.
pub(crate) fn or_else(a: f64, b: impl FnOnce() -> f64) -> f64 {
    if a != 0.0 && !a.is_nan() { a } else { b() }
}

/// A stable sort that never panics on an inconsistent comparator (a NaN
/// score makes one). Candidate lists are short, so insertion sort is enough.
pub(crate) fn stable_sort<T>(items: &mut [T], mut cmp: impl FnMut(&T, &T) -> f64) {
    for i in 1..items.len() {
        let mut j = i;
        while j > 0 && order(cmp(&items[j - 1], &items[j])) == Ordering::Greater {
            items.swap(j - 1, j);
            j -= 1;
        }
    }
}
