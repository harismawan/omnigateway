//! Ports of `packages/router/test/quota.test.ts`, `breaker.test.ts` and
//! `resolve.test.ts`.

mod common;

use common::*;
use omni_ir::error::ErrorCode;
use omni_router::{
    Failure, Penalty, Providers, QUOTA_FLOOR, UNKNOWN_QUOTA, blank_health, local_only_model,
    penalty, quota_headroom, record_failure, record_success, resolve_model, success_would_change,
};
use omni_store::settings::{Settings, default_settings_json};
use omni_store::{AuthType, BreakerState, QuotaWindow, Strategy, WindowType};
use serde_json::json;

const QNOW: f64 = 1_000_000_000.0;
const POLL_MS: f64 = 300_000.0;
const HOUR: f64 = 3_600_000.0;

fn read(windows: &[QuotaWindow]) -> f64 {
    quota_headroom(&credential("a"), windows, QNOW, POLL_MS)
}

fn q(
    window_type: WindowType,
    used: f64,
    resets_at: Option<f64>,
    window_ms: Option<f64>,
) -> QuotaWindow {
    quota_with("a", used, Some(100.0), |w| {
        w.window_type = window_type;
        w.observed_at = QNOW;
        w.resets_at = resets_at;
        w.window_ms = window_ms;
    })
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-5
}

#[test]
fn unknown_and_api_key_credentials_with_no_window() {
    assert_eq!(read(&[]), UNKNOWN_QUOTA);
    let key = cred_with("a", |c| c.auth_type = AuthType::ApiKey);
    assert_eq!(quota_headroom(&key, &[], QNOW, POLL_MS), 1.0);
}

#[test]
fn stale_unobserved_and_rolled_over_readings_are_not_believed() {
    let stale = quota_with("a", 10.0, Some(100.0), |w| {
        w.observed_at = QNOW - POLL_MS * 3.0 - 1.0
    });
    assert_eq!(read(&[stale]), UNKNOWN_QUOTA);
    let fresh = quota_with("a", 10.0, Some(100.0), |w| w.observed_at = QNOW - POLL_MS);
    assert!(read(&[fresh]) > UNKNOWN_QUOTA);
    assert_eq!(read(&[quota("a", 10.0, Some(100.0))]), UNKNOWN_QUOTA);
    let rolled = quota_with("a", 100.0, Some(100.0), |w| {
        w.observed_at = QNOW - 60_000.0;
        w.resets_at = Some(QNOW - 1.0);
    });
    assert_eq!(read(&[rolled]), UNKNOWN_QUOTA);
    let unlimited = quota_with("a", 5_000.0, None, |w| w.observed_at = QNOW);
    assert_eq!(read(&[unlimited]), UNKNOWN_QUOTA);
}

#[test]
fn headroom_is_judged_against_how_much_of_the_window_is_left() {
    assert_eq!(
        read(&[q(WindowType::FiveHour, 80.0, Some(QNOW + 0.5 * HOUR), None)]),
        1.0
    );
    assert!(close(
        read(&[q(WindowType::FiveHour, 80.0, Some(QNOW + 5.0 * HOUR), None)]),
        0.2
    ));
    let five = read(&[q(
        WindowType::FiveHour,
        95.0,
        Some(QNOW + 15.0 * 60_000.0),
        None,
    )]);
    let week = read(&[q(
        WindowType::Weekly,
        95.0,
        Some(QNOW + 6.0 * 24.0 * HOUR),
        None,
    )]);
    assert!(five > week);
    assert!(week < QUOTA_FLOOR);
}

#[test]
fn a_stated_window_length_is_believed_over_the_bucket() {
    let r = Some(QNOW + 1.5 * HOUR);
    assert!(close(
        read(&[q(WindowType::FiveHour, 80.0, r, Some(3.0 * HOUR))]),
        0.4
    ));
    assert!(close(
        read(&[q(WindowType::FiveHour, 80.0, r, None)]),
        2.0 / 3.0
    ));
    assert!(close(
        read(&[q(WindowType::FiveHour, 90.0, r, Some(10.0 * HOUR))]),
        2.0 / 3.0
    ));
    assert!(close(
        read(&[q(WindowType::FiveHour, 90.0, r, None)]),
        1.0 / 3.0
    ));
    assert!(close(
        read(&[q(
            WindowType::Weekly,
            50.0,
            Some(QNOW + 3.5 * 24.0 * HOUR),
            None
        )]),
        1.0
    ));
}

#[test]
fn plain_headroom_and_the_tightest_window() {
    assert!(close(
        read(&[q(WindowType::FiveHour, 25.0, None, None)]),
        0.75
    ));
    let roomy = q(WindowType::FiveHour, 10.0, None, None);
    let tight = q(WindowType::Weekly, 90.0, None, None);
    assert!(close(read(&[roomy, tight]), 0.1));
}

// ---- breaker

fn settings() -> Settings {
    Settings::from_json(default_settings_json())
}

fn fail(
    h: &omni_store::CredentialHealth,
    code: ErrorCode,
    retry_after_ms: Option<f64>,
    jitter: f64,
) -> omni_store::CredentialHealth {
    let s = settings();
    record_failure(
        h,
        &Failure {
            settings: &s,
            now: 1_000_000,
            code,
            retry_after_ms,
            jitter,
        },
    )
}

#[test]
fn blank_health_starts_closed_with_no_failures() {
    let h = blank_health("c1", "m");
    assert_eq!(h.breaker_state, BreakerState::Closed);
    assert_eq!(
        (h.consecutive_failures, h.opened_at, h.rate_limited_until),
        (0, None, None)
    );
    assert_eq!((h.credential_id.as_str(), h.model.as_str()), ("c1", "m"));
}

#[test]
fn success_resets_every_routing_field() {
    let next = record_success(&health_with("a", |h| {
        h.breaker_state = BreakerState::Open;
        h.consecutive_failures = 5;
        h.opened_at = Some(999_000);
        h.rate_limited_until = Some(1_005_000);
    }));
    assert_eq!(next, health("a"));
}

#[test]
fn success_would_change_is_exactly_whether_record_success_changes_the_row() {
    assert!(!success_would_change(None));
    let cases = [
        (health("a"), false),
        (health_with("a", |h| h.consecutive_failures = 1), true),
        (
            health_with("a", |h| h.breaker_state = BreakerState::Open),
            true,
        ),
        (
            health_with("a", |h| h.breaker_state = BreakerState::HalfOpen),
            true,
        ),
        (health_with("a", |h| h.rate_limited_until = Some(1)), true),
        (health_with("a", |h| h.opened_at = Some(1)), true),
    ];
    for (h, expected) in cases {
        assert_eq!(success_would_change(Some(&h)), expected, "{h:?}");
        assert_eq!(record_success(&h) != h, expected);
    }
}

#[test]
fn hard_failures_accumulate_and_open_at_the_threshold() {
    let one = fail(&health("a"), ErrorCode::Upstream, None, 0.0);
    assert_eq!(
        (one.consecutive_failures, one.breaker_state.clone()),
        (1, BreakerState::Closed)
    );
    let third = fail(
        &health_with("a", |h| h.consecutive_failures = 2),
        ErrorCode::Upstream,
        None,
        0.0,
    );
    assert_eq!(third.consecutive_failures, 3);
    assert_eq!(third.breaker_state, BreakerState::Open);
    assert_eq!(third.opened_at, Some(1_000_000));
}

#[test]
fn a_failed_probe_and_an_auth_failure_open_immediately() {
    let probe = fail(
        &health_with("a", |h| {
            h.breaker_state = BreakerState::HalfOpen;
            h.consecutive_failures = 1;
        }),
        ErrorCode::Network,
        None,
        0.0,
    );
    assert_eq!(
        (probe.breaker_state, probe.opened_at),
        (BreakerState::Open, Some(1_000_000))
    );
    let auth = fail(&health("a"), ErrorCode::Auth, None, 0.0);
    assert_eq!(
        (auth.breaker_state, auth.consecutive_failures),
        (BreakerState::Open, 1)
    );
}

#[test]
fn soft_failures_park_the_credential_without_touching_the_breaker() {
    let rl = fail(&health("a"), ErrorCode::RateLimit, Some(30_000.0), 0.0);
    assert_eq!(rl.rate_limited_until, Some(1_030_000));
    assert_eq!(
        (rl.breaker_state, rl.consecutive_failures),
        (BreakerState::Closed, 0)
    );
    assert_eq!(
        fail(&health("a"), ErrorCode::RateLimit, None, 0.0).rate_limited_until,
        Some(1_060_000)
    );
    let a = fail(&health("a"), ErrorCode::RateLimit, Some(10_000.0), 0.0)
        .rate_limited_until
        .expect("a");
    let b = fail(&health("a"), ErrorCode::RateLimit, Some(10_000.0), 1.0)
        .rate_limited_until
        .expect("b");
    assert_eq!(b - a, 2_000);
    assert_eq!(
        fail(&health("a"), ErrorCode::QuotaExhausted, None, 0.0).rate_limited_until,
        Some(4_600_000)
    );
    // A fractional Retry-After makes a fractional JS instant; the integer
    // column takes its ceiling, so `until > now` agrees for every integer now.
    assert_eq!(
        fail(&health("a"), ErrorCode::RateLimit, Some(1_500.4), 0.5).rate_limited_until,
        Some(1_002_501)
    );
}

#[test]
fn request_level_errors_change_nothing() {
    let before = health_with("a", |h| h.consecutive_failures = 1);
    for code in [
        ErrorCode::BadRequest,
        ErrorCode::CapabilityMismatch,
        ErrorCode::ContentFilter,
    ] {
        assert_eq!(fail(&before, code, None, 0.0), before);
    }
}

#[test]
fn every_error_code_has_the_ts_penalty_class() {
    use ErrorCode::*;
    for code in ErrorCode::ALL {
        let expected = match code {
            Auth | Upstream | Timeout | Network | ModelUnavailable => Penalty::Hard,
            RateLimit | QuotaExhausted | Overloaded => Penalty::Soft,
            _ => Penalty::None,
        };
        assert_eq!(penalty(code), expected, "{code}");
    }
}

// ---- resolve

fn empty() -> &'static omni_router::Snapshot {
    static EMPTY: std::sync::OnceLock<omni_router::Snapshot> = std::sync::OnceLock::new();
    EMPTY.get_or_init(|| snapshot(Snap::default()))
}

#[test]
fn resolves_a_configured_virtual_model_by_id_and_it_wins_over_inference() {
    let vm = |id: &str, provider: &str| {
        let mut m = model(vec![target_of(provider, "kimi-k2")], Strategy::Priority);
        m.id = id.into();
        m
    };
    let s = snapshot(Snap {
        models: vec![vm("fast", "anthropic"), vm("claude-opus-4", "kimi")],
        ..Snap::default()
    });
    let p = Providers::builtin();
    assert_eq!(resolve_model("fast", &s, &p).expect("fast").id, "fast");
    assert_eq!(
        resolve_model("claude-opus-4", &s, &p).expect("c").targets[0].provider,
        "kimi"
    );
}

#[test]
fn synthesises_a_single_target_model_from_provider_model_syntax() {
    let p = Providers::builtin();
    let m = resolve_model("anthropic/claude-opus-4", empty(), &p).expect("resolve");
    assert!(m.is_alias);
    assert_eq!(m.id, "anthropic/claude-opus-4");
    assert_eq!(m.strategy, Strategy::Score);
    let t = &m.targets[0];
    assert_eq!(
        (t.provider.as_str(), t.model.as_str(), t.tier, t.weight),
        ("anthropic", "claude-opus-4", 1.0, 1.0)
    );
    assert_eq!(
        omni_ir::jsjson::to_string(&serde_json::to_value(t).expect("json")),
        r#"{"provider":"anthropic","model":"claude-opus-4","tier":1,"weight":1,"costPerMTok":{"input":0,"output":0},"capabilities":{"tools":true,"images":true,"reasoning":true}}"#
    );
    assert_eq!(
        resolve_model("kimi:kimi-k2", empty(), &p)
            .expect("k")
            .targets[0]
            .model,
        "kimi-k2"
    );
    let slashed = resolve_model("openai/org/gpt-5", empty(), &p).expect("o");
    assert_eq!(
        (
            slashed.targets[0].provider.as_str(),
            slashed.targets[0].model.as_str()
        ),
        ("openai", "org/gpt-5")
    );
    let kimi = resolve_model("kimi/kimi-k2", empty(), &p).expect("k");
    assert!(!kimi.targets[0].capabilities.images && !kimi.targets[0].capabilities.reasoning);
}

#[test]
fn infers_the_provider_for_a_bare_well_known_model_name_longest_prefix_first() {
    let p = Providers::builtin();
    let m = resolve_model("claude-sonnet-4-5", empty(), &p).expect("claude");
    assert_eq!(
        (m.targets[0].provider.as_str(), m.id.as_str()),
        ("anthropic", "anthropic/claude-sonnet-4-5")
    );
    let mut installed = Providers::builtin();
    let seed = installed.get("anthropic").expect("a").clone();
    installed.register(
        "shortpfx",
        omni_router::Descriptor {
            model_prefixes: vec!["dup-".into()],
            ..seed.clone()
        },
    );
    installed.register(
        "longpfx",
        omni_router::Descriptor {
            model_prefixes: vec!["dup-long-".into()],
            ..seed
        },
    );
    assert_eq!(
        resolve_model("dup-long-1", empty(), &installed)
            .expect("l")
            .targets[0]
            .provider,
        "longpfx"
    );
    assert_eq!(
        resolve_model("dup-1", empty(), &installed)
            .expect("s")
            .targets[0]
            .provider,
        "shortpfx"
    );
}

#[test]
fn unresolvable_names_are_no_candidates_with_the_ts_messages() {
    let p = Providers::builtin();
    let err = |name: &str| resolve_model(name, empty(), &p).expect_err(name);
    for name in [
        "custom/model",
        "custom:model",
        "bedrock/claude",
        "constructor/x",
        "toString/x",
    ] {
        assert_eq!(err(name).code, ErrorCode::NoCandidates, "{name}");
    }
    assert_eq!(
        err("bedrock/claude").message,
        r#"unknown provider "bedrock" in model "bedrock/claude""#
    );
    assert_eq!(
        err("does-not-exist").message,
        r#"model "does-not-exist" is not a configured virtual model and its provider could not be inferred"#
    );
    assert_eq!(
        err("a b/c").message,
        r#"unknown provider "(unprintable)" in model "(unprintable)""#
    );
    // An empty model part is refused, not synthesised.
    assert_eq!(err("anthropic/").code, ErrorCode::NoCandidates);
}

#[test]
fn local_only_model_answers_for_configured_all_custom_models_only() {
    let custom = |m: &str, e: &str| {
        target_with(|t| {
            t.provider = "custom".into();
            t.model = m.into();
            t.endpoint_id = Some(json!(e));
        })
    };
    let named = |id: &str, targets| {
        let mut m = score_model(targets);
        m.id = id.into();
        m
    };
    let s = snapshot(Snap {
        models: vec![
            named(
                "private",
                vec![custom("llama", "ollama"), custom("qwen", "vllm")],
            ),
            named("mixed", vec![custom("llama", "ollama"), target()]),
            named("empty", vec![]),
        ],
        ..Snap::default()
    });
    let p = Providers::builtin();
    assert_eq!(
        local_only_model("private", &s, &p).map(|m| m.id.clone()),
        Some("private".into())
    );
    for name in [
        "mixed",
        "empty",
        "anthropic/claude-x",
        "custom/llama",
        "no-such-model",
    ] {
        assert!(local_only_model(name, &s, &p).is_none(), "{name}");
    }
}

#[test]
fn a_non_ascii_prefix_resolves_by_longest_match() {
    // Two prefixes that both match one name are prefixes of each other, so
    // UTF-8 bytes and UTF-16 units order them the same; this pins the
    // non-ASCII path, and the sort itself now measures units as JS does.
    let mut p = Providers::builtin();
    let seed = p.get("anthropic").expect("a").clone();
    p.register(
        "short",
        omni_router::Descriptor {
            model_prefixes: vec!["é".into()],
            ..seed.clone()
        },
    );
    p.register(
        "long",
        omni_router::Descriptor {
            model_prefixes: vec!["é😀".into()],
            ..seed
        },
    );
    assert_eq!(
        resolve_model("é😀x", empty(), &p).expect("r").targets[0].provider,
        "long"
    );
    assert_eq!(
        resolve_model("éx", empty(), &p).expect("r").targets[0].provider,
        "short"
    );
}
