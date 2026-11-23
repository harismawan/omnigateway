//! Kimi's usage probe pinned against the kimi cases in
//! `packages/control/test/oauth/usage.test.ts`: one weekly plan window whose
//! counters arrive as strings, no invented duration, and the sibling
//! per-minute `limits` array never read as the plan window.

use omni_providers::quota::usage;
use serde_json::json;

const NOW: f64 = 1_755_000_000_000.0;

#[test]
fn kimi_reports_one_plan_window_whose_counters_are_strings() {
    let rows = usage(
        "kimi",
        &json!({
            "user": {"id": "u1"},
            "usage": {"limit": "100", "used": "92", "remaining": "8", "resetTime": "2026-08-15T00:00:00.000Z"},
            "limits": [{"detail": {"limit": 60, "remaining": 12}}]
        }),
        NOW,
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["windowType"], "weekly");
    assert_eq!(rows[0]["used"], 92.0);
    assert_eq!(rows[0]["limit"], 100.0);
    // `Date.parse("2026-08-15T00:00:00.000Z")`.
    assert_eq!(rows[0]["resetsAt"], 1_786_752_000_000.0);
}

#[test]
fn kimi_reports_no_window_duration() {
    // Kimi states none, and inventing a duration from the bucket name would
    // be a claim it never made.
    let rows = usage(
        "kimi",
        &json!({"usage": {"limit": "100", "used": "92"}}),
        NOW,
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["windowMs"], serde_json::Value::Null);
}

#[test]
fn kimi_weekly_window_type_is_pinned_even_with_a_duration_key() {
    // `windowFrom(root.usage ?? root.Usage, "weekly", now)`: a stray
    // `window_seconds` must neither reclassify the window nor give it a
    // duration.
    let rows = usage(
        "kimi",
        &json!({"usage": {"limit": "100", "used": "92", "window_seconds": 3600}}),
        NOW,
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["windowType"], "weekly");
    assert_eq!(rows[0]["windowMs"], serde_json::Value::Null);
}

#[test]
fn kimi_per_minute_rate_limits_are_not_read_as_the_plan_window() {
    // `limits` describes request bursts the breaker already reacts to.
    // Treating one as the subscription would park an account over a minute
    // of throttling.
    let rows = usage(
        "kimi",
        &json!({"limits": [{"detail": {"limit": 60, "remaining": 0}}]}),
        NOW,
    );
    assert!(rows.is_empty());
}

#[test]
fn kimi_reads_the_capitalized_usage_key_as_a_fallback() {
    // `root.usage ?? root.Usage`.
    let rows = usage(
        "kimi",
        &json!({"Usage": {"limit": "100", "used": "92"}}),
        NOW,
    );
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["windowType"], "weekly");
    assert_eq!(rows[0]["used"], 92.0);
    assert_eq!(rows[0]["limit"], 100.0);
}
