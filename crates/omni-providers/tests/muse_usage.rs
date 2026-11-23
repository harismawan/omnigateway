//! Muse's subscription usage payload, read into the two windows it describes
//! (`museUsage.test.ts`).
//!
//! The field names are quoted from the shipped client's own serde metadata:
//! `SubscriptionUsageSnapshot { window, weekly }`, `SubscriptionWindowSnapshot
//! { used_percent, resets_at, window_duration_mins }`, `SubscriptionWeeklySnapshot
//! { used_percent, resets_at }`. Nothing here is a live capture — the fixtures
//! are built from that shape, which is what the parser is being held to.

use omni_providers::muse::oauth::parse_usage;
use serde_json::{Value, json};

const NOW: f64 = 1_700_000_000_000.0;
/// Epoch **seconds**, which is what the reset reader scales up from.
const RESET: f64 = 1_700_000_600.0;

fn payload() -> Value {
    json!({
        "window": {"used_percent": 42, "resets_at": RESET, "window_duration_mins": 300},
        "weekly": {"used_percent": 7, "resets_at": RESET + 86_400.0},
    })
}

#[test]
fn both_windows_are_read_and_the_rolling_one_states_its_own_length() {
    let report = parse_usage(&payload(), NOW);
    assert_eq!(
        report,
        [
            json!({
                "windowType": "fiveHour",
                "used": 42.0,
                "limit": 100.0,
                "resetsAt": RESET * 1000.0,
                // Read from `window_duration_mins`, not assumed. A window
                // filed under `fiveHour` but actually running three would
                // have its start inferred two hours early.
                "windowMs": 300.0 * 60_000.0,
            }),
            json!({
                "windowType": "weekly",
                "used": 7.0,
                "limit": 100.0,
                "resetsAt": (RESET + 86_400.0) * 1000.0,
                // The weekly snapshot states no duration; `weekly` already
                // means seven days, so saying nothing is correct.
                "windowMs": null,
            }),
        ]
    );
}

#[test]
fn a_percentage_becomes_a_value_out_of_100_so_every_consumer_does_one_ratio() {
    // The router score, the quota filter and the console meter all divide
    // `used / limit`. A percentage arriving as `used: 42, limit: null` would
    // be drawn as an unknown ceiling.
    let report = parse_usage(&payload(), NOW);
    assert!(report.iter().all(|w| w["limit"] == json!(100.0)));
}

#[test]
fn a_duration_meta_changes_is_followed_rather_than_pinned_to_five_hours() {
    let report = parse_usage(
        &json!({"window": {"used_percent": 1, "resets_at": RESET, "window_duration_mins": 180}}),
        NOW,
    );
    assert_eq!(report[0]["windowMs"], json!(180.0 * 60_000.0));
}

#[test]
fn a_window_with_no_stated_duration_is_reported_without_inventing_one() {
    let report = parse_usage(
        &json!({"window": {"used_percent": 5, "resets_at": RESET}}),
        NOW,
    );
    assert_eq!(report[0]["windowType"], json!("fiveHour"));
    assert_eq!(report[0]["windowMs"], Value::Null);
}

#[test]
fn one_readable_window_survives_the_other_being_absent() {
    // A payload carrying only the weekly half is a real answer, not a broken one.
    let report = parse_usage(
        &json!({"weekly": {"used_percent": 90, "resets_at": RESET}}),
        NOW,
    );
    assert_eq!(report.len(), 1);
    assert_eq!(report[0]["windowType"], json!("weekly"));
}

#[test]
fn an_unreadable_payload_is_empty_so_the_previous_snapshot_stands() {
    // Missing data means unknown, never zero: an unreadable probe must leave
    // the last good reading in place rather than overwrite it.
    assert!(parse_usage(&Value::Null, NOW).is_empty());
    assert!(parse_usage(&json!("nope"), NOW).is_empty());
    assert!(parse_usage(&json!({}), NOW).is_empty());
    // Present but empty: neither window says anything countable.
    assert!(parse_usage(&json!({"window": {}, "weekly": {}}), NOW).is_empty());
    // `recordOf` excludes arrays, unlike the mint's `isRecord`.
    assert!(parse_usage(&json!([]), NOW).is_empty());
}

#[test]
fn a_percentage_past_the_ceiling_is_clamped_rather_than_drawn_past_full() {
    let report = parse_usage(
        &json!({"weekly": {"used_percent": 140, "resets_at": RESET}}),
        NOW,
    );
    assert_eq!(report[0]["used"], json!(100.0));
}

#[test]
fn the_quota_dispatch_reads_subs_usage_off_a_mint_shaped_body() {
    // The probe is a mint; the host hands the whole mint body to the shared
    // usage dispatch, which must find `subs_usage` inside it. An account with
    // no active subscription receives no `subs_usage` at all — the ordinary
    // pay-as-you-go answer is an empty report, not a zero one.
    let minted = json!({
        "api_key": "meta-key",
        "subs_usage": payload(),
    });
    let rows = omni_providers::quota::usage("muse", &minted, NOW);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["windowType"], json!("fiveHour"));
    assert!(omni_providers::quota::usage("muse", &json!({"api_key": "meta-key"}), NOW).is_empty());
    assert!(omni_providers::quota::usage("muse", &json!([]), NOW).is_empty());

    // The probe request is the mint request: same URL, same empty-object
    // body, the OAuth bearer — never the minted key.
    let request =
        omni_providers::quota::request("muse", "usage", "oauth-tok", &json!({}), Value::Null)
            .expect("muse usage probe");
    assert_eq!(request.timeout.as_secs(), 15);
    assert_eq!(request.http.url, "https://api.meta.ai/muse-code/key");
    assert_eq!(request.http.method, "POST");
    assert_eq!(request.http.body, "{}");
    assert!(
        request
            .http
            .headers
            .iter()
            .any(|(n, v)| n == "Authorization" && v == "Bearer oauth-tok")
    );
}
