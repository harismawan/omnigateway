//! A refusal's correction: each violated long window's true reset, read
//! from the retained row stamps, then the one clearing last.

use crate::ratelimit::{RateLimitExceeded, State, Subject, long_index};
use omni_ratelimit::limits::LimitScope;
use omni_ratelimit::{
    Decision, Violation, Window, combine_all, evaluate, last_to_clear, refused_headroom,
    retry_after_ms, with_reset,
};

impl State {
    /// `exactReset`: when a long window truly frees a slot, from the
    /// retained row stamps. `None` keeps the overstated figure.
    fn exact_reset(&mut self, subject: &str, window: Window, now: f64) -> Option<f64> {
        if window == Window::M1 {
            return None;
        }
        let state = &mut self.long.get_mut(subject)?[long_index(window)];
        if !state.buckets.is_seeded() {
            return None;
        }
        state.trim(window, now);
        state.stamps.front().map(|oldest| oldest + window.ms())
    }

    /// `correct`: one subject's decision with each violated long window's
    /// true reset, headroom moved with it.
    fn correct(&mut self, subject: &Subject, scope: &Decision, now: f64) -> Decision {
        if scope.violations.is_empty() {
            return scope.clone();
        }
        let mut exact: Vec<(Window, f64)> = Vec::new();
        for v in &scope.violations {
            let Some(window) = v.window else { continue };
            if exact.iter().any(|(w, _)| *w == window) {
                continue;
            }
            if let Some(reset) = self.exact_reset(&subject.id, window, now) {
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

    /// Judges every subject; on a refusal, corrects and builds the error.
    pub(crate) fn judge(
        &mut self,
        subjects: &[Subject],
        scope: fn(&LimitScope) -> LimitScope,
        now: f64,
        queued: &mut bool,
    ) -> Result<Decision, RateLimitExceeded> {
        let mut decisions = Vec::with_capacity(subjects.len());
        for s in subjects {
            let limits = scope(&s.limits);
            let counters = self.counters(s, &limits, now, queued);
            decisions.push(evaluate(&limits, &counters, now));
        }
        let decision = combine_all(&decisions);
        if decision.violation.is_none() {
            return Ok(decision);
        }
        let corrected: Vec<Decision> = subjects
            .iter()
            .zip(&decisions)
            .map(|(s, d)| self.correct(s, d, now))
            .collect();
        let decision = combine_all(&corrected);
        let Some(violation) = decision.violation else {
            // Correcting a reset never removes a violation.
            return Ok(decision);
        };
        Err(RateLimitExceeded {
            retry_after_ms: retry_after_ms(Some(&violation), now),
            headroom: Box::new(refused_headroom(&decision, &violation)),
            violation: Box::new(violation),
        })
    }
}
