//! The decision, from what the counters held before this request, with the
//! arithmetic in `omni-ratelimit`.

use omni_coord::Counts;
use omni_ratelimit::limits::LimitScope;
use omni_ratelimit::{
    CounterSnapshot, Decision, HeadroomByDimension, Violation, Window, WindowCounter, combine_all,
    evaluate, last_to_clear, refused_headroom, retry_after_ms, with_reset,
};

use crate::subject::{LONG, any_long_limit};

/// What one subject's counters held the instant before this request joined
/// them: the `1m` ring, the gauge, and each long window that is seeded.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Observed {
    pub before_1m: WindowCounter,
    pub concurrency: f64,
    /// `None`: not asked for, or unseeded (read as nothing used).
    pub long: [Option<Counts>; 2],
    /// Per long window, the oldest in-window row's `at` the script could
    /// recover from Redis, or `None`.
    pub oldest: [Option<f64>; 2],
}

/// The snapshot `evaluate` judges.
pub(crate) fn snapshot(limits: &LimitScope, o: &Observed, now: f64) -> CounterSnapshot {
    let mut s = CounterSnapshot::default();
    s.requests.set(Window::M1, o.before_1m);
    s.concurrency = o.concurrency;
    if !any_long_limit(limits) {
        return s;
    }
    for (i, window) in LONG.into_iter().enumerate() {
        let Some(c) = o.long[i] else { continue };
        // The far end of the window; corrected on a refusal.
        let reset_at = now + window.ms();
        s.requests.set(
            window,
            WindowCounter {
                used: c.requests,
                reset_at,
            },
        );
        s.tokens.set(
            window,
            WindowCounter {
                used: c.tokens,
                reset_at,
            },
        );
        s.spend.set(
            window,
            WindowCounter {
                used: c.cost_usd,
                reset_at,
            },
        );
    }
    s
}

/// Each subject judged alone (against its scoped limits), then combined.
pub(crate) fn decide(scopes: &[LimitScope], observed: &[Observed], now: f64) -> Vec<Decision> {
    scopes
        .iter()
        .zip(observed)
        .map(|(limits, o)| evaluate(limits, &snapshot(limits, o, now), now))
        .collect()
}

/// `RateLimitExceeded`: the refusal, with what its headers render.
#[derive(Debug, Clone, PartialEq)]
pub struct RateLimitExceeded {
    pub retry_after_ms: f64,
    pub headroom: Box<HeadroomByDimension>,
    /// The violation reported (`dimension`/`window` are the metric labels).
    pub violation: Box<Violation>,
}

impl std::fmt::Display for RateLimitExceeded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("API key rate limit exceeded")
    }
}

impl std::error::Error for RateLimitExceeded {}

/// `refuse`: every violated long window's reset corrected first (in every
/// subject), then the one clearing last chosen. `None` only if no decision
/// holds a violation (the caller then admits). Reads nothing: the resets
/// came back with the admission script's reply.
pub(crate) fn refusal(
    decisions: &[Decision],
    observed: &[Observed],
    now: f64,
) -> Option<RateLimitExceeded> {
    let corrected: Vec<Decision> = decisions
        .iter()
        .zip(observed)
        .map(|(scope, o)| correct(scope, o))
        .collect();
    let decision = combine_all(&corrected);
    let violation = decision.violation?;
    Some(RateLimitExceeded {
        retry_after_ms: retry_after_ms(Some(&violation), now),
        headroom: Box::new(refused_headroom(&decision, &violation)),
        violation: Box::new(violation),
    })
}

/// `correct`: one subject's decision with each violated long window's true
/// reset, its headroom moved with it.
fn correct(scope: &Decision, o: &Observed) -> Decision {
    if scope.violations.is_empty() {
        return scope.clone();
    }
    let mut exact: Vec<(Window, f64)> = Vec::new();
    for v in &scope.violations {
        let Some(window) = v.window else { continue };
        if exact.iter().any(|(w, _)| *w == window) {
            continue;
        }
        if let Some(reset) = exact_reset(o, window) {
            exact.push((window, reset));
        }
    }
    let violations: Vec<Violation> = scope
        .violations
        .iter()
        .map(|v| {
            let reset = v
                .window
                .and_then(|w| exact.iter().find(|(e, _)| *e == w).map(|(_, r)| *r));
            reset.map_or(*v, |reset_at| Violation { reset_at, ..*v })
        })
        .collect();
    let mut headroom = scope.headroom;
    for (window, reset) in &exact {
        headroom = with_reset(&headroom, *window, *reset);
    }
    Decision {
        allowed: scope.allowed,
        violation: last_to_clear(&violations),
        violations,
        headroom,
    }
}

/// The exact reset: the oldest in-window row's `at` plus the window. `None`
/// keeps the overstated `now + window`: `1m` (already exact), or no row
/// range known.
///
/// Taken from Redis, not the store (ruling on D3: the request path never
/// touches Postgres): exact when the oldest row's bucket lies wholly inside
/// the window; when the window's cutoff falls inside that bucket, the
/// bucket's newest row — later than the true oldest by less than one bucket
/// width (a minute of 5h, an hour of 1w), never earlier.
fn exact_reset(o: &Observed, window: Window) -> Option<f64> {
    let i = LONG.iter().position(|w| *w == window)?;
    o.oldest[i].map(|at| at + window.ms())
}
