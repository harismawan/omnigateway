//! The decision, from what the counters held before this request: TS
//! `judge` / `counters` / `refuse` / `correct` / `exactReset`, with the
//! arithmetic in `omni-ratelimit`.

use std::time::Duration;

use omni_coord::Counts;
use omni_ratelimit::limits::LimitScope;
use omni_ratelimit::{
    CounterSnapshot, Decision, HeadroomByDimension, Violation, Window, WindowCounter, combine_all,
    evaluate, last_to_clear, refused_headroom, retry_after_ms, with_reset,
};

use crate::UsageSource;
use crate::subject::{LONG, Subject, any_long_limit};

/// What one subject's counters held the instant before this request joined
/// them: the `1m` ring, the gauge, and each long window that is seeded.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Observed {
    pub before_1m: WindowCounter,
    pub concurrency: f64,
    /// `None`: not asked for, or unseeded (read as nothing used).
    pub long: [Option<Counts>; 2],
}

/// `counters`: the snapshot `evaluate` judges.
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
/// holds a violation (the caller then admits).
pub(crate) async fn refusal(
    subjects: &[Subject],
    decisions: &[Decision],
    now: f64,
    usage: &dyn UsageSource,
    reset_timeout: Duration,
) -> Option<RateLimitExceeded> {
    let mut corrected = Vec::with_capacity(decisions.len());
    for (subject, scope) in subjects.iter().zip(decisions) {
        corrected.push(correct(subject, scope, now, usage, reset_timeout).await);
    }
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
async fn correct(
    subject: &Subject,
    scope: &Decision,
    now: f64,
    usage: &dyn UsageSource,
    reset_timeout: Duration,
) -> Decision {
    if scope.violations.is_empty() {
        return scope.clone();
    }
    let mut exact: Vec<(Window, f64)> = Vec::new();
    let mut asked: Vec<Window> = Vec::new();
    for v in &scope.violations {
        let Some(window) = v.window else { continue };
        if asked.contains(&window) {
            continue;
        }
        asked.push(window);
        if let Some(reset) = exact_reset(subject, window, now, usage, reset_timeout).await {
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

/// `exactReset`: the oldest retained done row's `at` plus the window, asked
/// only of a request being refused. `None` keeps the overstated figure: `1m`
/// (already exact), no row, or a failed (or, beyond TS, timed-out) read.
async fn exact_reset(
    subject: &Subject,
    window: Window,
    now: f64,
    usage: &dyn UsageSource,
    reset_timeout: Duration,
) -> Option<f64> {
    if window == Window::M1 {
        return None;
    }
    let length = window.ms();
    let read = usage.oldest_since(&subject.key_id, now - length, subject.model.as_deref());
    let reason = match tokio::time::timeout(reset_timeout, read).await {
        Ok(Ok(oldest)) => return oldest.map(|at| at + length),
        Ok(Err(e)) => e,
        Err(_) => "timed out".to_owned(),
    };
    tracing::warn!(
        api_key_id = subject.key_id.as_str(),
        model = subject.model.as_deref().unwrap_or(""),
        reason = reason.as_str(),
        "rate limit reset unavailable"
    );
    None
}
