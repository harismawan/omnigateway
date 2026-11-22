//! Contract tests for `evaluate`: decisions, headroom, resets and
//! `Retry-After`.

use omni_ratelimit::limits::{CountWindows, LimitScope, SpendWindows};
use omni_ratelimit::{
    CounterSnapshot, Dimension, DimensionCounters, Headroom, Violation, Window, WindowCounter,
    after_this_request, combine, evaluate, last_to_clear, retry_after_ms,
};

const NOW: f64 = 1_000_000.0;

fn c(used: f64, reset_at: f64) -> WindowCounter {
    WindowCounter { used, reset_at }
}

fn requests(m: Option<u64>, h: Option<u64>, w: Option<u64>) -> LimitScope {
    LimitScope {
        requests: Some(CountWindows {
            one_minute: m.map(Some),
            five_hours: h.map(Some),
            one_week: w.map(Some),
        }),
        ..LimitScope::default()
    }
}

fn counters(dim: Dimension, pairs: &[(Window, WindowCounter)]) -> CounterSnapshot {
    let mut d = DimensionCounters::default();
    for (w, counter) in pairs {
        d.set(*w, *counter);
    }
    let mut s = CounterSnapshot::default();
    match dim {
        Dimension::Requests => s.requests = d,
        Dimension::Tokens => s.tokens = d,
        Dimension::Spend => s.spend = d,
        Dimension::Concurrency => {}
    }
    s
}

#[test]
fn no_configured_limit_allows_everything_and_reports_no_headroom() {
    let d = evaluate(
        &LimitScope::default(),
        &counters(Dimension::Requests, &[(Window::M1, c(9_999.0, NOW))]),
        NOW,
    );
    assert!(d.allowed);
    assert!(d.violation.is_none());
    assert!(d.headroom.is_empty());
}

#[test]
fn an_explicit_null_is_unlimited_exactly_as_an_absent_key_is() {
    let s = counters(
        Dimension::Requests,
        &[(Window::M1, c(500.0, NOW + 1_000.0))],
    );
    let null = LimitScope {
        requests: Some(CountWindows {
            one_minute: Some(None),
            ..CountWindows::default()
        }),
        ..LimitScope::default()
    };
    assert!(evaluate(&null, &s, NOW).allowed);
    let empty = LimitScope {
        requests: Some(CountWindows::default()),
        ..LimitScope::default()
    };
    assert!(evaluate(&empty, &s, NOW).allowed);
}

#[test]
fn the_request_that_lands_exactly_on_the_limit_is_allowed_the_next_is_denied() {
    let at = |used: f64| {
        evaluate(
            &requests(Some(2), None, None),
            &counters(
                Dimension::Requests,
                &[(Window::M1, c(used, NOW + 60_000.0))],
            ),
            NOW,
        )
    };
    assert!(at(0.0).allowed);
    assert!(at(1.0).allowed);
    assert!(!at(2.0).allowed);
    assert_eq!(
        at(2.0).violation,
        Some(Violation {
            dimension: Dimension::Requests,
            window: Some(Window::M1),
            limit: 2.0,
            used: 2.0,
            reset_at: NOW + 60_000.0,
        })
    );
}

#[test]
fn every_dimension_is_enforced_in_both_directions() {
    let config = LimitScope {
        requests: Some(CountWindows {
            five_hours: Some(Some(10)),
            ..CountWindows::default()
        }),
        tokens: Some(CountWindows {
            one_week: Some(Some(1_000)),
            ..CountWindows::default()
        }),
        spend: Some(SpendWindows {
            one_week: Some(Some(25.0)),
            ..SpendWindows::default()
        }),
        concurrency: Some(Some(4)),
    };
    let reset = NOW + 1_000.0;
    let under = || {
        let mut s = CounterSnapshot::default();
        s.requests.set(Window::H5, c(9.0, reset));
        s.tokens.set(Window::W1, c(999.0, reset));
        s.spend.set(Window::W1, c(24.99, reset));
        s.concurrency = 3.0;
        s
    };
    assert!(evaluate(&config, &under(), NOW).allowed);
    let mut over = Vec::new();
    let mut s = under();
    s.requests.set(Window::H5, c(10.0, reset));
    over.push(s);
    let mut s = under();
    s.tokens.set(Window::W1, c(1_000.0, reset));
    over.push(s);
    let mut s = under();
    s.spend.set(Window::W1, c(25.0, reset));
    over.push(s);
    let mut s = under();
    s.concurrency = 4.0;
    over.push(s);
    for s in over {
        assert!(!evaluate(&config, &s, NOW).allowed);
    }
}

#[test]
fn concurrency_is_a_gauge_so_its_violation_carries_no_window() {
    let config = LimitScope {
        concurrency: Some(Some(2)),
        ..LimitScope::default()
    };
    let s = CounterSnapshot {
        concurrency: 2.0,
        ..CounterSnapshot::default()
    };
    let d = evaluate(&config, &s, NOW);
    assert_eq!(
        d.violation,
        Some(Violation {
            dimension: Dimension::Concurrency,
            window: None,
            limit: 2.0,
            used: 2.0,
            reset_at: NOW,
        })
    );
    assert_eq!(retry_after_ms(d.violation.as_ref(), NOW), 0.0);
}

#[test]
fn headroom_reports_the_window_nearest_exhaustion_by_proportion() {
    let d = evaluate(
        &requests(Some(60), None, Some(2_000)),
        &counters(
            Dimension::Requests,
            &[
                (Window::M1, c(1.0, NOW + 60_000.0)),
                (Window::W1, c(1_999.0, NOW + 604_800_000.0)),
            ],
        ),
        NOW,
    );
    assert!(d.allowed);
    assert_eq!(
        d.headroom.requests,
        Some(Headroom {
            window: Window::W1,
            limit: 2_000.0,
            used: 1_999.0,
            remaining: 1.0,
            reset_at: NOW + 604_800_000.0,
        })
    );
}

#[test]
fn headroom_is_per_dimension_and_skips_unconfigured_ones() {
    let mut config = requests(Some(10), None, None);
    config.concurrency = Some(Some(4));
    let mut s = counters(Dimension::Requests, &[(Window::M1, c(4.0, NOW + 500.0))]);
    s.concurrency = 1.0;
    let d = evaluate(&config, &s, NOW);
    assert!(d.headroom.tokens.is_none() && d.headroom.spend.is_none());
    assert_eq!(d.headroom.requests.map(|h| h.remaining), Some(6.0));
}

#[test]
fn remaining_floors_at_zero() {
    let config = LimitScope {
        tokens: Some(CountWindows {
            one_week: Some(Some(1_000)),
            ..CountWindows::default()
        }),
        ..LimitScope::default()
    };
    let d = evaluate(
        &config,
        &counters(Dimension::Tokens, &[(Window::W1, c(1_400.0, NOW + 10.0))]),
        NOW,
    );
    let h = d.headroom.tokens.expect("tokens");
    assert_eq!(h.remaining, 0.0);
    assert_eq!(h.used, 1_400.0);
}

#[test]
fn a_missing_counter_reads_as_zero_used_and_a_full_window_ahead() {
    let d = evaluate(
        &requests(None, Some(10), None),
        &CounterSnapshot::default(),
        NOW,
    );
    assert!(d.allowed);
    assert_eq!(
        d.headroom.requests,
        Some(Headroom {
            window: Window::H5,
            limit: 10.0,
            used: 0.0,
            remaining: 10.0,
            reset_at: NOW + 18_000_000.0,
        })
    );
}

#[test]
fn of_several_violations_the_one_clearing_last_is_reported() {
    let d = evaluate(
        &requests(Some(10), None, Some(100)),
        &counters(
            Dimension::Requests,
            &[
                (Window::M1, c(10.0, NOW + 30_000.0)),
                (Window::W1, c(100.0, NOW + 600_000_000.0)),
            ],
        ),
        NOW,
    );
    assert_eq!(
        d.violation.as_ref().and_then(|v| v.window),
        Some(Window::W1)
    );
    assert_eq!(retry_after_ms(d.violation.as_ref(), NOW), 600_000_000.0);
}

#[test]
fn violations_that_clear_together_are_separated_by_overshoot() {
    let together = NOW + 60_000.0;
    let first = evaluate(
        &requests(None, Some(10), Some(100)),
        &counters(
            Dimension::Requests,
            &[
                (Window::H5, c(50.0, together)),
                (Window::W1, c(110.0, together)),
            ],
        ),
        NOW,
    );
    assert_eq!(first.violation.and_then(|v| v.window), Some(Window::H5));

    let mut config = requests(Some(10), None, None);
    config.tokens = Some(CountWindows {
        one_minute: Some(Some(100)),
        ..CountWindows::default()
    });
    let mut s = counters(Dimension::Requests, &[(Window::M1, c(11.0, together))]);
    s.tokens.set(Window::M1, c(500.0, together));
    let second = evaluate(&config, &s, NOW);
    assert_eq!(
        second.violation.map(|v| v.dimension),
        Some(Dimension::Tokens)
    );
}

#[test]
fn retry_after_never_goes_negative() {
    let v = Violation {
        dimension: Dimension::Requests,
        window: Some(Window::M1),
        limit: 1.0,
        used: 1.0,
        reset_at: 5.0,
    };
    assert_eq!(retry_after_ms(Some(&v), 10.0), 0.0);
    assert_eq!(retry_after_ms(None, 10.0), 0.0);
}

fn key_wide(used: f64, reset_at: f64) -> omni_ratelimit::Decision {
    evaluate(
        &requests(Some(10), None, None),
        &counters(Dimension::Requests, &[(Window::M1, c(used, reset_at))]),
        NOW,
    )
}

fn model_scope(used: f64, reset_at: f64) -> omni_ratelimit::Decision {
    evaluate(
        &requests(None, Some(4), None),
        &counters(Dimension::Requests, &[(Window::H5, c(used, reset_at))]),
        NOW,
    )
}

#[test]
fn combine_allows_only_what_both_scopes_allow() {
    assert!(combine(&key_wide(1.0, NOW + 1.0), &model_scope(1.0, NOW + 2.0)).allowed);
    let key_only = combine(
        &key_wide(10.0, NOW + 30_000.0),
        &model_scope(1.0, NOW + 2.0),
    );
    assert!(!key_only.allowed);
    assert_eq!(
        key_only.violation,
        Some(Violation {
            dimension: Dimension::Requests,
            window: Some(Window::M1),
            limit: 10.0,
            used: 10.0,
            reset_at: NOW + 30_000.0,
        })
    );
    let model_only = combine(&key_wide(1.0, NOW + 1.0), &model_scope(4.0, NOW + 90_000.0));
    assert!(!model_only.allowed);
    let v = model_only.violation.expect("violation");
    assert_eq!(v.window, Some(Window::H5));
    assert_eq!(v.reset_at, NOW + 90_000.0);
}

#[test]
fn combine_reports_the_violation_clearing_last_whichever_scope_holds_it() {
    let model_later = combine(
        &key_wide(10.0, NOW + 30_000.0),
        &model_scope(4.0, NOW + 90_000.0),
    );
    assert_eq!(
        model_later.violation.and_then(|v| v.window),
        Some(Window::H5)
    );
    let key_later = combine(
        &key_wide(10.0, NOW + 95_000.0),
        &model_scope(4.0, NOW + 90_000.0),
    );
    assert_eq!(
        key_later.violation.as_ref().and_then(|v| v.window),
        Some(Window::M1)
    );
    assert_eq!(retry_after_ms(key_later.violation.as_ref(), NOW), 95_000.0);
}

#[test]
fn combine_reports_per_dimension_the_headroom_nearer_exhaustion() {
    let key_nearer = combine(&key_wide(6.0, NOW + 1.0), &model_scope(1.0, NOW + 2.0));
    assert_eq!(
        key_nearer.headroom.requests,
        Some(Headroom {
            window: Window::M1,
            limit: 10.0,
            used: 6.0,
            remaining: 4.0,
            reset_at: NOW + 1.0,
        })
    );
    let model_nearer = combine(&key_wide(6.0, NOW + 1.0), &model_scope(3.0, NOW + 2.0));
    assert_eq!(
        model_nearer.headroom.requests,
        Some(Headroom {
            window: Window::H5,
            limit: 4.0,
            used: 3.0,
            remaining: 1.0,
            reset_at: NOW + 2.0,
        })
    );
}

#[test]
fn combine_keeps_a_dimension_only_one_scope_configures() {
    let key = evaluate(
        &LimitScope {
            tokens: Some(CountWindows {
                one_minute: Some(Some(100)),
                ..CountWindows::default()
            }),
            ..LimitScope::default()
        },
        &counters(Dimension::Tokens, &[(Window::M1, c(5.0, 7.0))]),
        NOW,
    );
    let model = evaluate(
        &LimitScope {
            spend: Some(SpendWindows {
                one_week: Some(Some(4.0)),
                ..SpendWindows::default()
            }),
            ..LimitScope::default()
        },
        &counters(Dimension::Spend, &[(Window::W1, c(1.0, 9.0))]),
        NOW,
    );
    let combined = combine(&key, &model);
    assert_eq!(combined.headroom.tokens.map(|h| h.limit), Some(100.0));
    assert_eq!(combined.headroom.spend.map(|h| h.limit), Some(4.0));
    assert!(combined.headroom.requests.is_none());
    assert_eq!(combine(&model, &key).headroom, combined.headroom);
}

#[test]
fn combine_keeps_the_key_wide_headroom_when_both_are_equally_near() {
    let combined = combine(&key_wide(5.0, NOW + 1.0), &model_scope(2.0, NOW + 2.0));
    assert_eq!(
        combined.headroom.requests.map(|h| h.window),
        Some(Window::M1)
    );
}

#[test]
fn a_decision_carries_every_violation() {
    let mut config = requests(Some(1), None, Some(1));
    config.concurrency = Some(Some(1));
    let mut s = counters(
        Dimension::Requests,
        &[
            (Window::M1, c(1.0, NOW + 1.0)),
            (Window::W1, c(1.0, NOW + 2.0)),
        ],
    );
    s.concurrency = 1.0;
    let d = evaluate(&config, &s, NOW);
    let mut names: Vec<String> = d
        .violations
        .iter()
        .map(|v| {
            format!(
                "{}:{:?}",
                v.dimension.as_str(),
                v.window.map(Window::as_str)
            )
        })
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "concurrency:None",
            "requests:Some(\"1m\")",
            "requests:Some(\"1w\")"
        ]
    );
    assert_eq!(d.violation.and_then(|v| v.window), Some(Window::W1));
    assert!(
        evaluate(
            &requests(Some(5), None, None),
            &CounterSnapshot::default(),
            NOW
        )
        .violations
        .is_empty()
    );
}

#[test]
fn combine_carries_both_scopes_violations() {
    let combined = combine(
        &key_wide(10.0, NOW + 30_000.0),
        &model_scope(4.0, NOW + 90_000.0),
    );
    assert_eq!(combined.violations.len(), 2);
    assert_eq!(
        combine(&key_wide(1.0, NOW), &model_scope(4.0, NOW + 90_000.0))
            .violations
            .len(),
        1
    );
    assert_eq!(
        combine(&key_wide(10.0, NOW), &model_scope(1.0, NOW))
            .violations
            .len(),
        1
    );
}

#[test]
fn last_to_clear_picks_the_latest_reset_then_the_larger_overshoot() {
    let at = |reset_at: f64, used: f64| Violation {
        dimension: Dimension::Requests,
        window: Some(Window::M1),
        limit: 10.0,
        used,
        reset_at,
    };
    assert_eq!(
        last_to_clear(&[at(5.0, 10.0), at(9.0, 10.0), at(7.0, 10.0)]).map(|v| v.reset_at),
        Some(9.0)
    );
    assert_eq!(
        last_to_clear(&[at(9.0, 10.0), at(9.0, 30.0)]).map(|v| v.used),
        Some(30.0)
    );
    assert!(last_to_clear(&[]).is_none());
}

/// The `after_this_request` header adjustment.
#[test]
fn after_this_request_spends_one_request_and_nothing_else() {
    let d = evaluate(
        &LimitScope {
            tokens: Some(CountWindows {
                one_minute: Some(Some(100)),
                ..CountWindows::default()
            }),
            ..requests(Some(60), None, None)
        },
        &CounterSnapshot::default(),
        NOW,
    );
    let after = after_this_request(&d.headroom);
    assert_eq!(after.requests.map(|h| h.remaining), Some(59.0));
    assert_eq!(after.tokens.map(|h| h.remaining), Some(100.0));
    let full = evaluate(
        &requests(Some(1), None, None),
        &counters(Dimension::Requests, &[(Window::M1, c(1.0, NOW))]),
        NOW,
    );
    assert_eq!(
        after_this_request(&full.headroom)
            .requests
            .map(|h| h.remaining),
        Some(0.0)
    );
}

/// The finite-counter precondition is asserted in debug builds.
#[test]
#[cfg(debug_assertions)]
#[should_panic(expected = "non-finite rate-limit counter")]
fn a_nan_counter_is_refused_in_debug_builds() {
    let s = counters(Dimension::Tokens, &[(Window::H5, c(f64::NAN, NOW))]);
    let _ = evaluate(&requests(Some(1), None, None), &s, NOW);
}
