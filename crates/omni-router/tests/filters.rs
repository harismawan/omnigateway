//! Port of `packages/router/test/filters.test.ts`, `providerNative.test.ts`
//! and `blockPositions.test.ts` (the logic in the router itself).

mod common;

use common::*;
use omni_router::{
    Eligible, ExcludedKind, Providers, eligible, required_capabilities, required_providers,
};
use omni_store::BreakerState;
use serde_json::{Value, json};

fn rows(out: &Eligible<'_>) -> Vec<(ExcludedKind, String, String, String)> {
    out.excluded
        .iter()
        .map(|e| {
            (
                e.kind,
                e.credential_id.clone(),
                e.model.clone(),
                e.reason.clone(),
            )
        })
        .collect()
}

fn account(cred: &str, model: &str, reason: &str) -> (ExcludedKind, String, String, String) {
    (
        ExcludedKind::Account,
        cred.into(),
        model.into(),
        reason.into(),
    )
}

fn target_row(model: &str, reason: &str) -> (ExcludedKind, String, String, String) {
    (
        ExcludedKind::Target,
        String::new(),
        model.into(),
        reason.into(),
    )
}

fn reasons(out: &Eligible<'_>) -> Vec<String> {
    out.excluded.iter().map(|e| e.reason.clone()).collect()
}

fn pair_ids(out: &Eligible<'_>) -> Vec<String> {
    out.pairs.iter().map(|p| p.credential.id.clone()).collect()
}

fn pinned(cred: &str) -> omni_store::Target {
    target_with(|t| t.credential_id = Some(cred.into()))
}

#[test]
fn derives_required_capabilities_from_the_request() {
    let c = required_capabilities(&req());
    assert!(!c.tools && !c.images && !c.reasoning);
    assert!(required_capabilities(&req_with(json!({ "tools": portable_tool() }))).tools);
    assert!(
        required_capabilities(&req_with(
            json!({ "reasoning": { "mode": "adaptive", "effort": "low" } })
        ))
        .reasoning
    );
    assert!(
        required_capabilities(&req_with(json!({ "messages": [{ "role": "user",
            "content": [{ "type": "image", "mediaType": "image/png", "data": "A" }] }] })))
        .images
    );
}

#[test]
fn between_tools_keeps_a_non_reasoning_target_that_adaptive_reasoning_excludes() {
    let m = score_model(vec![target_with(|t| t.capabilities.reasoning = false)]);
    let s = creds(vec![credential("a")]);
    let between = req_with(json!({ "reasoning": { "mode": "betweenTools" } }));
    let out = eligible(&input(&between, &m, &s));
    assert_eq!(pair_ids(&out), ["a"]);
    assert!(out.excluded.is_empty());
    let adaptive = req_with(json!({ "reasoning": { "mode": "adaptive" } }));
    let out = eligible(&input(&adaptive, &m, &s));
    assert!(out.pairs.is_empty());
    assert_eq!(reasons(&out), ["capability:reasoning"]);
}

#[test]
fn pairs_each_target_with_every_credential_of_its_provider() {
    let r = req();
    let m = score_model(vec![target()]);
    let s = creds(vec![cred_of("a", "anthropic"), cred_of("k", "kimi")]);
    assert_eq!(pair_ids(&eligible(&input(&r, &m, &s))), ["a"]);
}

#[test]
fn pairs_custom_targets_only_with_credentials_for_the_same_endpoint() {
    let r = req();
    let m = score_model(vec![target_with(|t| {
        t.provider = "custom".into();
        t.endpoint_id = Some(json!("local"));
        t.model = "llama".into();
    })]);
    let s = creds(vec![
        custom_cred("matching", json!("local")),
        custom_cred("other", json!("remote")),
    ]);
    assert_eq!(pair_ids(&eligible(&input(&r, &m, &s))), ["matching"]);
}

/// `servesTarget`'s endpoint rule, including the malformed-row cases it
/// closes: a custom target naming no endpoint is served only by an account
/// naming none, and a non-string or empty account endpoint matches nothing.
#[test]
fn the_endpoint_rule_fails_closed_on_malformed_rows() {
    let r = req();
    let custom = |endpoint: Option<Value>| {
        score_model(vec![target_with(|t| {
            t.provider = "custom".into();
            t.endpoint_id = endpoint;
            t.model = "m".into();
        })])
    };
    let no_endpoint = cred_with("none", |c| {
        c.provider = "custom".into();
        c.provider_data = json!({});
    });
    let s = creds(vec![
        no_endpoint,
        custom_cred("num", json!(42)),
        custom_cred("null", Value::Null),
        custom_cred("empty", json!("")),
        custom_cred("local", json!("local")),
    ]);
    for (endpoint, expected) in [
        (None, vec!["none"]),
        (Some(json!("")), vec!["none"]),
        (Some(json!("local")), vec!["local"]),
        (Some(json!(42)), vec![]),
        (Some(Value::Null), vec![]),
    ] {
        let m = custom(endpoint.clone());
        assert_eq!(
            pair_ids(&eligible(&input(&r, &m, &s))),
            expected,
            "{endpoint:?}"
        );
    }
}

#[test]
fn a_pinned_target_pairs_only_with_the_credential_it_names() {
    let r = req();
    let m = score_model(vec![pinned("pinned")]);
    let s = creds(vec![credential("pinned"), credential("other")]);
    let out = eligible(&input(&r, &m, &s));
    assert_eq!(pair_ids(&out), ["pinned"]);
    assert!(out.excluded.is_empty());
}

#[test]
fn a_pin_is_hard() {
    let r = req();
    let m = score_model(vec![pinned("pinned")]);
    let s = creds(vec![
        cred_with("pinned", |c| c.enabled = false),
        credential("other"),
    ]);
    let out = eligible(&input(&r, &m, &s));
    assert!(out.pairs.is_empty());
    assert_eq!(rows(&out), [account("pinned", "claude-opus-4", "disabled")]);
}

#[test]
fn a_pin_naming_no_existing_credential_reports_itself() {
    let r = req();
    let m = score_model(vec![pinned("deleted")]);
    let s = creds(vec![credential("other")]);
    let out = eligible(&input(&r, &m, &s));
    assert!(out.pairs.is_empty());
    assert_eq!(
        rows(&out),
        [account("deleted", "claude-opus-4", "pin:missing")]
    );
}

#[test]
fn an_unpinned_target_in_the_same_model_is_unaffected_by_a_siblings_pin() {
    let r = req();
    let m = score_model(vec![
        pinned("pinned"),
        target_with(|t| t.model = "claude-sonnet-4".into()),
    ]);
    let s = creds(vec![credential("pinned"), credential("other")]);
    let out = eligible(&input(&r, &m, &s));
    let mut got: Vec<String> = out
        .pairs
        .iter()
        .map(|p| format!("{}:{}", p.target.model, p.credential.id))
        .collect();
    got.sort();
    assert_eq!(
        got,
        [
            "claude-opus-4:pinned",
            "claude-sonnet-4:other",
            "claude-sonnet-4:pinned"
        ]
    );
}

#[test]
fn a_pin_does_not_rescue_a_credential_the_provider_filter_already_rejects() {
    let r = req();
    let m = score_model(vec![pinned("k")]);
    let s = creds(vec![cred_of("k", "kimi")]);
    let out = eligible(&input(&r, &m, &s));
    assert!(out.pairs.is_empty());
    assert_eq!(rows(&out), [account("k", "claude-opus-4", "pin:missing")]);
}

#[test]
fn every_dangling_pin_in_a_model_is_reported() {
    let r = req();
    let m = score_model(vec![
        pinned("live"),
        target_with(|t| {
            t.model = "claude-sonnet-4".into();
            t.credential_id = Some("gone".into());
        }),
        target_with(|t| {
            t.model = "claude-haiku-4".into();
            t.credential_id = Some("also-gone".into());
        }),
    ]);
    let s = creds(vec![credential("live")]);
    let out = eligible(&input(&r, &m, &s));
    assert_eq!(out.pairs.len(), 1);
    assert_eq!(
        rows(&out),
        [
            account("gone", "claude-sonnet-4", "pin:missing"),
            account("also-gone", "claude-haiku-4", "pin:missing"),
        ]
    );
}

#[test]
fn a_pinned_target_reports_one_reason() {
    let r = req_with(json!({ "tools": portable_tool() }));
    let m = score_model(vec![target_with(|t| {
        t.capabilities.tools = false;
        t.credential_id = Some("a".into());
    })]);
    let s = creds(vec![credential("a")]);
    assert_eq!(
        rows(&eligible(&input(&r, &m, &s))),
        [account("a", "claude-opus-4", "capability:tools")]
    );
}

#[test]
fn a_pin_cannot_reach_a_custom_credential_on_another_endpoint() {
    let r = req();
    let m = score_model(vec![target_with(|t| {
        t.provider = "custom".into();
        t.endpoint_id = Some(json!("local"));
        t.model = "llama".into();
        t.credential_id = Some("remote-account".into());
    })]);
    let s = creds(vec![custom_cred("remote-account", json!("remote"))]);
    let out = eligible(&input(&r, &m, &s));
    assert!(out.pairs.is_empty());
    assert_eq!(
        rows(&out),
        [account("remote-account", "llama", "pin:missing")]
    );
}

#[test]
fn a_pin_reaches_a_custom_credential_on_the_targets_own_endpoint() {
    let r = req();
    let m = score_model(vec![target_with(|t| {
        t.provider = "custom".into();
        t.endpoint_id = Some(json!("local"));
        t.model = "llama".into();
        t.credential_id = Some("l".into());
    })]);
    let s = creds(vec![
        custom_cred("l", json!("local")),
        custom_cred("other", json!("local")),
    ]);
    assert_eq!(pair_ids(&eligible(&input(&r, &m, &s))), ["l"]);
}

#[test]
fn a_pin_on_an_installation_with_no_credentials_still_reports_itself() {
    let r = req();
    let m = score_model(vec![pinned("gone")]);
    let s = creds(vec![]);
    assert_eq!(
        rows(&eligible(&input(&r, &m, &s))),
        [account("gone", "claude-opus-4", "pin:missing")]
    );
}

#[test]
fn a_dangling_pin_reports_itself_once() {
    let r = req();
    let m = score_model(vec![pinned("gone")]);
    let s = creds(vec![credential("a"), credential("b")]);
    assert_eq!(
        rows(&eligible(&input(&r, &m, &s))),
        [account("gone", "claude-opus-4", "pin:missing")]
    );
}

#[test]
fn excludes_disabled_credentials() {
    let r = req();
    let m = score_model(vec![target()]);
    let s = creds(vec![cred_with("a", |c| c.enabled = false)]);
    let out = eligible(&input(&r, &m, &s));
    assert!(out.pairs.is_empty());
    assert_eq!(rows(&out), [account("a", "claude-opus-4", "disabled")]);
}

#[test]
fn excludes_targets_that_lack_a_required_capability() {
    let r = req_with(json!({ "tools": portable_tool() }));
    let m = score_model(vec![target_with(|t| t.capabilities.tools = false)]);
    let s = creds(vec![credential("a")]);
    assert_eq!(reasons(&eligible(&input(&r, &m, &s))), ["capability:tools"]);
}

fn open_health(opened_at: i64, failures: i64) -> omni_store::CredentialHealth {
    health_with("a", |h| {
        h.breaker_state = BreakerState::Open;
        #[allow(clippy::cast_precision_loss)]
        {
            h.opened_at = Some(opened_at as f64);
        }
        h.consecutive_failures = failures;
    })
}

#[test]
fn excludes_an_open_breaker_inside_its_cooldown() {
    let r = req();
    let m = score_model(vec![target()]);
    let s = snapshot(Snap {
        credentials: vec![credential("a")],
        health: vec![open_health(999_000, 3)],
        ..Snap::default()
    });
    assert_eq!(reasons(&eligible(&input(&r, &m, &s))), ["breaker:open"]);
}

#[test]
fn admits_an_open_breaker_whose_cooldown_has_elapsed_as_a_probe() {
    let r = req();
    let m = score_model(vec![target()]);
    let s = snapshot(Snap {
        credentials: vec![credential("a")],
        health: vec![open_health(940_000, 3)],
        ..Snap::default()
    });
    let out = eligible(&input(&r, &m, &s));
    assert_eq!(out.pairs.len(), 1);
    assert!(out.pairs[0].probe);
}

#[test]
fn a_half_open_breaker_is_admitted_as_probe_territory() {
    let r = req();
    let m = score_model(vec![target()]);
    let s = snapshot(Snap {
        credentials: vec![credential("a")],
        health: vec![health_with("a", |h| {
            h.breaker_state = BreakerState::HalfOpen;
            h.opened_at = Some(1_000_000.0);
            h.consecutive_failures = 3;
        })],
        ..Snap::default()
    });
    let out = eligible(&input(&r, &m, &s));
    assert!(out.excluded.is_empty());
    assert!(out.pairs[0].probe);
}

#[test]
fn a_closed_breaker_and_a_missing_row_are_not_probe_territory() {
    let r = req();
    let m = score_model(vec![target()]);
    for with_row in [true, false] {
        let s = snapshot(Snap {
            credentials: vec![credential("a")],
            health: if with_row {
                vec![health_with("a", |h| h.consecutive_failures = 2)]
            } else {
                vec![]
            },
            ..Snap::default()
        });
        assert!(!eligible(&input(&r, &m, &s)).pairs[0].probe);
    }
}

#[test]
fn cooldown_grows_exponentially_with_consecutive_failures() {
    let r = req();
    let m = score_model(vec![target()]);
    let build = |failures: i64| {
        let s = snapshot(Snap {
            credentials: vec![credential("a")],
            health: vec![open_health(900_000, failures)],
            ..Snap::default()
        });
        eligible(&input(&r, &m, &s)).pairs.len()
    };
    assert_eq!(build(3), 1);
    assert_eq!(build(8), 0);
}

#[test]
fn rate_limit_windows_exclude_until_they_pass() {
    let r = req();
    let m = score_model(vec![target()]);
    let at = |until: i64| {
        let s = snapshot(Snap {
            credentials: vec![credential("a")],
            health: vec![health_with("a", |h| {
                h.rate_limited_until = Some(until as f64)
            })],
            ..Snap::default()
        });
        let out = eligible(&input(&r, &m, &s));
        (out.pairs.len(), reasons(&out))
    };
    assert_eq!(at(1_005_000), (0, vec!["rateLimited".to_owned()]));
    assert_eq!(at(999_999), (1, vec![]));
}

#[test]
fn spent_quota_windows_exclude_until_their_reset() {
    let r = req();
    let m = score_model(vec![target()]);
    let at = |resets_at: Option<f64>, limit: Option<f64>, used: f64| {
        let s = snapshot(Snap {
            credentials: vec![credential("a")],
            quota: vec![quota_with("a", used, limit, |q| q.resets_at = resets_at)],
            ..Snap::default()
        });
        let out = eligible(&input(&r, &m, &s));
        (out.pairs.len(), reasons(&out))
    };
    assert_eq!(at(Some(NOW - 1.0), Some(100.0), 100.0), (1, vec![]));
    assert_eq!(
        at(Some(NOW + 60_000.0), Some(100.0), 100.0),
        (0, vec!["quota:fiveHour".to_owned()])
    );
    assert_eq!(
        at(None, Some(100.0), 100.0),
        (0, vec!["quota:fiveHour".to_owned()])
    );
    assert_eq!(at(None, None, 10_000.0), (1, vec![]));
}

#[test]
fn expiry_excludes_only_an_unrefreshable_oauth_credential() {
    let r = req();
    let m = score_model(vec![target()]);
    let run = |c| eligible(&input(&r, &m, &creds(vec![c]))).pairs.len();
    assert_eq!(
        run(cred_with("a", |c| {
            c.expires_at = Some(999_999);
            c.has_refresh_token = false;
        })),
        0
    );
    let dead = cred_with("a", |c| {
        c.expires_at = Some(999_999);
        c.has_refresh_token = false;
    });
    assert_eq!(
        reasons(&eligible(&input(&r, &m, &creds(vec![dead])))),
        ["expired"]
    );
    assert_eq!(run(cred_with("a", |c| c.expires_at = Some(999_999))), 1);
    assert_eq!(
        run(cred_with("a", |c| {
            c.auth_type = omni_store::AuthType::ApiKey;
            c.expires_at = Some(999_999);
            c.has_refresh_token = false;
        })),
        1
    );
}

#[test]
fn a_target_naming_a_provider_that_is_not_installed_is_excluded_once() {
    let r = req();
    let m = score_model(vec![target_of("nonesuch", "nonesuch-1")]);
    for credentials in [
        vec![credential("a")],
        vec![cred_of("a", "nonesuch")],
        vec![
            cred_of("a", "anthropic"),
            cred_of("b", "openai"),
            cred_of("c", "kimi"),
        ],
    ] {
        let s = creds(credentials);
        let out = eligible(&input(&r, &m, &s));
        assert!(out.pairs.is_empty());
        assert_eq!(rows(&out), [target_row("nonesuch-1", "provider:missing")]);
    }
}

#[test]
fn an_uninstalled_provider_reports_itself_rather_than_pin_missing() {
    let r = req();
    let m = score_model(vec![target_with(|t| {
        t.provider = "nonesuch".into();
        t.model = "nonesuch-1".into();
        t.credential_id = Some("gone".into());
    })]);
    let s = creds(vec![credential("a")]);
    assert_eq!(
        rows(&eligible(&input(&r, &m, &s))),
        [target_row("nonesuch-1", "provider:missing")]
    );
}

#[test]
fn every_broken_target_in_a_pool_reports_wherever_it_sits() {
    let r = req();
    let m = score_model(vec![
        target(),
        target_of("nonesuch", "nonesuch-1"),
        target_of("alsogone", "alsogone-1"),
    ]);
    let s = creds(vec![credential("a")]);
    let out = eligible(&input(&r, &m, &s));
    assert_eq!(out.pairs.len(), 1);
    assert_eq!(
        rows(&out),
        [
            target_row("nonesuch-1", "provider:missing"),
            target_row("alsogone-1", "provider:missing"),
        ]
    );
}

#[test]
fn the_guard_reads_the_registry_it_is_handed() {
    let r = req();
    let m = score_model(vec![target_of("late-arrival", "late-1")]);
    let s = creds(vec![cred_of("a", "late-arrival")]);
    assert_eq!(reasons(&eligible(&input(&r, &m, &s))), ["provider:missing"]);
    let mut installed = Providers::builtin();
    installed.register(
        "late-arrival",
        Providers::builtin().get("anthropic").expect("a").clone(),
    );
    let mut i = input(&r, &m, &s);
    i.providers = Some(&installed);
    let out = eligible(&i);
    assert!(out.excluded.is_empty());
    assert_eq!(pair_ids(&out), ["a"]);
}

#[test]
fn inherited_js_keys_are_not_providers() {
    let r = req();
    let m = score_model(vec![target_of("constructor", "c-1")]);
    let s = creds(vec![cred_of("a", "constructor")]);
    assert_eq!(
        rows(&eligible(&input(&r, &m, &s))),
        [target_row("c-1", "provider:missing")]
    );
}

// ---- providerNative.test.ts

fn web_search() -> Value {
    json!({ "kind": "provider", "provider": "anthropic", "family": "webSearch",
        "type": "web_search_20250305", "name": "web_search", "wire": {} })
}

fn native_history(provider: &str) -> Value {
    json!([{ "role": "assistant", "content": [{ "type": "providerNative", "provider": provider,
        "blockType": "web_search_tool_result", "data": { "tool_use_id": "srvtoolu_1", "content": [] } }] }])
}

fn owners(r: &omni_ir::request::ChatRequest) -> Vec<String> {
    let mut v: Vec<String> = required_providers(r).into_iter().collect();
    v.sort();
    v
}

#[test]
fn required_providers_reads_every_position() {
    assert!(owners(&req_with(json!({ "tools": portable_tool() }))).is_empty());
    assert_eq!(
        owners(&req_with(json!({ "tools": [web_search()] }))),
        ["anthropic"]
    );
    assert_eq!(
        owners(&req_with(
            json!({ "messages": native_history("anthropic") })
        )),
        ["anthropic"]
    );
    let in_result = json!([{ "role": "user", "content": [{ "type": "toolResult", "toolUseId": "t",
        "content": "", "native": [{ "type": "providerNative", "provider": "acme",
        "blockType": "document", "data": {} }] }] }]);
    assert_eq!(
        owners(&req_with(json!({ "messages": in_result }))),
        ["acme"]
    );
    let system =
        json!([{ "type": "providerNative", "provider": "acme", "blockType": "x", "data": {} }]);
    assert_eq!(owners(&req_with(json!({ "system": system }))), ["acme"]);
    assert_eq!(
        owners(&req_with(
            json!({ "tools": [web_search()], "messages": native_history("acme") })
        )),
        ["acme", "anthropic"]
    );
}

#[test]
fn a_request_owned_by_two_providers_can_be_served_by_neither() {
    let r = req_with(json!({ "tools": [web_search()], "messages": native_history("acme") }));
    let m = score_model(vec![target_of("anthropic", "claude")]);
    let s = creds(vec![credential("a1")]);
    let out = eligible(&input(&r, &m, &s));
    assert!(out.pairs.is_empty());
    assert_eq!(out.excluded.len(), 1);
    assert_eq!(out.excluded[0].kind, ExcludedKind::Target);
    assert_eq!(out.excluded[0].reason, "capability:providerNative");
}

#[test]
fn a_request_naming_anthropic_excludes_other_providers_as_target_facts() {
    let r = req_with(json!({ "tools": [web_search()] }));
    let m = score_model(vec![
        target_of("openai", "gpt-5"),
        target_of("kimi", "k2"),
        target_of("anthropic", "claude-opus-4"),
    ]);
    let s = creds(vec![
        cred_of("o", "openai"),
        cred_of("k", "kimi"),
        cred_of("a", "anthropic"),
    ]);
    let out = eligible(&input(&r, &m, &s));
    assert_eq!(pair_ids(&out), ["a"]);
    assert_eq!(
        reasons(&out),
        ["capability:providerNative", "capability:providerNative"]
    );
    assert!(out.excluded.iter().all(|e| e.kind == ExcludedKind::Target));
}

#[test]
fn a_missing_portable_capability_stays_a_fact_about_the_account() {
    let r = req_with(json!({ "tools": portable_tool() }));
    let m = score_model(vec![target_with(|t| {
        t.provider = "openai".into();
        t.model = "gpt-5".into();
        t.capabilities.tools = false;
    })]);
    let s = creds(vec![cred_of("o", "openai")]);
    let out = eligible(&input(&r, &m, &s));
    assert_eq!(out.excluded[0].kind, ExcludedKind::Account);
}

#[test]
fn a_tool_the_custom_provider_defines_routes_only_to_custom_targets() {
    let tool = json!([{ "kind": "provider", "provider": "custom", "family": "webSearch",
        "type": "web_search_20250305", "name": "web_search", "wire": {} }]);
    let r = req_with(json!({ "tools": tool }));
    let m = score_model(vec![
        target_of("anthropic", "claude-opus-4"),
        target_of("custom", "llama"),
    ]);
    let s = creds(vec![
        cred_of("a", "anthropic"),
        cred_with("c", |c| c.provider = "custom".into()),
    ]);
    assert_eq!(pair_ids(&eligible(&input(&r, &m, &s))), ["c"]);
}

#[test]
fn a_target_no_account_can_serve_reports_why_even_unpinned() {
    let r = req();
    let m = score_model(vec![target_with(|t| {
        t.provider = "custom".into();
        t.model = "m".into();
        t.endpoint_id = Some(json!("nowhere"));
    })]);
    let s = creds(vec![custom_cred("c", json!("a"))]);
    assert_eq!(
        rows(&eligible(&input(&r, &m, &s))),
        [target_row("m", "endpoint:unmatched")]
    );
    // No accounts at all: silent.
    assert!(eligible(&input(&r, &m, &creds(vec![]))).excluded.is_empty());
}

#[test]
fn an_account_dropped_for_its_own_reason_is_not_also_reported_as_unservable() {
    let r = req();
    let m = score_model(vec![target_with(|t| {
        t.provider = "custom".into();
        t.model = "m".into();
        t.endpoint_id = Some(json!("a"));
    })]);
    let s = creds(vec![cred_with("c", |c| {
        c.provider = "custom".into();
        c.enabled = false;
        c.provider_data = json!({ "endpointId": "a" });
    })]);
    assert_eq!(reasons(&eligible(&input(&r, &m, &s))), ["disabled"]);
}

// ---- blockPositions.test.ts

#[test]
fn every_predicate_that_reads_blocks_reads_every_position() {
    let image = json!({ "type": "image", "mediaType": "image/png", "data": "iVBORw0KGgo=" });
    let native = json!({ "type": "providerNative", "provider": "acme", "blockType": "acme_lookup", "data": { "id": "srv_1" } });
    let text = json!({ "type": "text", "text": "ordinary" });
    let at = |position: &str, block: &Value| {
        if position == "system" {
            req_with(json!({ "system": [block] }))
        } else {
            req_with(json!({ "messages": [{ "role": "user", "content": [block] }] }))
        }
    };
    for position in ["system", "messages"] {
        assert!(required_providers(&at(position, &native)).contains("acme"));
        assert!(required_capabilities(&at(position, &image)).images);
        assert!(required_providers(&at(position, &text)).is_empty());
        assert!(!required_capabilities(&at(position, &text)).images);
    }
}

#[test]
fn an_image_or_file_inside_a_tool_result_needs_a_vision_target() {
    let with = |extra: Value| {
        let mut block = json!({ "type": "toolResult", "toolUseId": "t", "content": "" });
        for (k, v) in extra.as_object().expect("o") {
            block[k] = v.clone();
        }
        req_with(json!({ "messages": [{ "role": "user", "content": [block] }] }))
    };
    assert!(!required_capabilities(&with(json!({}))).images);
    assert!(
        required_capabilities(&with(
            json!({ "images": [{ "type": "image", "mediaType": "image/png", "data": "" }] })
        ))
        .images
    );
    assert!(
        required_capabilities(&with(
            json!({ "files": [{ "type": "file", "mediaType": "application/pdf", "data": "" }] })
        ))
        .images
    );
    // An empty list still names the field, as `!== undefined` reads it.
    assert!(required_capabilities(&with(json!({ "images": [] }))).images);
}

#[test]
fn a_breaker_is_admitted_the_instant_its_cooldown_has_elapsed() {
    // threshold 3, base 30s, 3 failures: cooldown is exactly 30s.
    let r = req();
    let m = score_model(vec![target()]);
    let at = |opened_at: i64| {
        let s = snapshot(Snap {
            credentials: vec![credential("a")],
            health: vec![open_health(opened_at, 3)],
            ..Snap::default()
        });
        eligible(&input(&r, &m, &s)).pairs.len()
    };
    assert_eq!(at(970_000), 1);
    assert_eq!(at(970_001), 0);
}

/// TS reads `toolResult.native` inside messages only; a system-prompt tool
/// result's native parts name no owner (packages/router/src/filters.ts).
#[test]
fn a_tool_result_native_part_in_the_system_prompt_names_no_owner() {
    let block = json!({ "type": "toolResult", "toolUseId": "t", "content": "",
        "native": [{ "type": "providerNative", "provider": "anthropic", "blockType": "document", "data": {} }] });
    let r = req_with(json!({ "system": [block] }));
    assert!(required_providers(&r).is_empty());
    let m = score_model(vec![target_of("openai", "gpt-5")]);
    let s = creds(vec![cred_of("o", "openai")]);
    assert_eq!(pair_ids(&eligible(&input(&r, &m, &s))), ["o"]);
}
