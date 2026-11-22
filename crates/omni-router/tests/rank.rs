//! Ranking and scoring regressions.

mod common;

use common::*;
use omni_router::{Candidate, health_key, rank};
use omni_store::{BreakerState, Strategy};
use serde_json::json;
use std::collections::HashMap;

fn ids(candidates: &[Candidate<'_>]) -> Vec<String> {
    candidates.iter().map(|c| c.credential.id.clone()).collect()
}

fn models(candidates: &[Candidate<'_>]) -> Vec<String> {
    candidates.iter().map(|c| c.target.model.clone()).collect()
}

#[test]
fn prefers_the_lower_tier_when_everything_else_is_equal() {
    let r = req();
    let m = score_model(vec![
        target_with(|t| {
            t.model = "cheap".into();
            t.tier = 2.0;
        }),
        target_with(|t| {
            t.model = "premium".into();
            t.tier = 1.0;
        }),
    ]);
    let s = creds(vec![credential("a")]);
    assert_eq!(models(&rank(&input(&r, &m, &s)).candidates)[0], "premium");
}

#[test]
fn prefers_the_healthier_credential_at_the_same_tier() {
    let r = req();
    let m = score_model(vec![target()]);
    let s = snapshot(Snap {
        credentials: vec![credential("sick"), credential("well")],
        health: vec![health_with("sick", |h| h.consecutive_failures = 2)],
        ..Snap::default()
    });
    assert_eq!(ids(&rank(&input(&r, &m, &s)).candidates)[0], "well");
}

#[test]
fn prefers_the_cheaper_target_when_cost_is_the_only_weighted_term() {
    let r = req();
    let m = score_model(vec![
        target_with(|t| {
            t.model = "pricey".into();
            t.cost_per_m_tok = pricing(15.0, 75.0);
        }),
        target_with(|t| {
            t.model = "thrifty".into();
            t.cost_per_m_tok = pricing(1.0, 3.0);
        }),
    ]);
    let s = snapshot(Snap {
        credentials: vec![credential("a")],
        settings: only("cost"),
        ..Snap::default()
    });
    assert_eq!(models(&rank(&input(&r, &m, &s)).candidates)[0], "thrifty");
}

#[test]
fn prefers_the_faster_credential_when_latency_is_the_only_weighted_term() {
    let r = req();
    let m = score_model(vec![target()]);
    let s = snapshot(Snap {
        credentials: vec![credential("slow"), credential("quick")],
        settings: only("latency"),
        ..Snap::default()
    });
    let rec = recent(&[("slow", None, Some(3000.0)), ("quick", None, Some(200.0))]);
    let mut i = input(&r, &m, &s);
    i.recent = Some(&rec);
    assert_eq!(ids(&rank(&i).candidates)[0], "quick");
}

#[test]
fn prefers_the_credential_with_more_quota_headroom() {
    let r = req();
    let m = score_model(vec![target()]);
    let s = snapshot(Snap {
        credentials: vec![credential("drained"), credential("fresh")],
        quota: vec![
            quota_with("drained", 90.0, Some(100.0), |q| q.observed_at = NOW),
            quota_with("fresh", 10.0, Some(100.0), |q| q.observed_at = NOW),
        ],
        settings: only("quota"),
        ..Snap::default()
    });
    assert_eq!(ids(&rank(&input(&r, &m, &s)).candidates)[0], "fresh");
}

#[test]
fn credential_weight_multiplies_the_final_score() {
    let r = req();
    let m = score_model(vec![target()]);
    let s = creds(vec![
        cred_with("light", |c| c.weight = 1.0),
        cred_with("heavy", |c| c.weight = 5.0),
    ]);
    assert_eq!(ids(&rank(&input(&r, &m, &s)).candidates)[0], "heavy");
}

#[test]
fn priority_strategy_sorts_by_tier_and_ignores_other_terms() {
    let r = req();
    let m = model(
        vec![
            target_with(|t| {
                t.model = "tier2".into();
                t.tier = 2.0;
                t.cost_per_m_tok = pricing(0.0, 0.0);
            }),
            target_with(|t| {
                t.model = "tier1".into();
                t.tier = 1.0;
            }),
        ],
        Strategy::Priority,
    );
    let s = creds(vec![credential("a")]);
    assert_eq!(
        models(&rank(&input(&r, &m, &s)).candidates),
        ["tier1", "tier2"]
    );
}

#[test]
fn round_robin_puts_the_least_recently_used_credential_first() {
    let r = req();
    let m = model(vec![target()], Strategy::RoundRobin);
    let s = creds(vec![credential("a"), credential("b")]);
    let rec = recent(&[("a", Some(NOW), None), ("b", Some(NOW - 10.0), None)]);
    let mut i = input(&r, &m, &s);
    i.recent = Some(&rec);
    assert_eq!(ids(&rank(&i).candidates)[0], "b");
}

#[test]
fn weighted_selection_is_deterministic_in_the_injected_random_value() {
    let r = req();
    let m = model(vec![target()], Strategy::Weighted);
    let s = creds(vec![
        cred_with("a", |c| c.weight = 1.0),
        cred_with("b", |c| c.weight = 9.0),
    ]);
    let pick = |rand: f64| {
        let mut i = input(&r, &m, &s);
        i.rand = rand;
        ids(&rank(&i).candidates)[0].clone()
    };
    assert_eq!(pick(0.05), "a");
    assert_eq!(pick(0.5), "b");
    assert_eq!(pick(0.05), "a");
}

#[test]
fn weighted_ranking_still_returns_every_candidate_for_failover() {
    let r = req();
    let m = model(vec![target()], Strategy::Weighted);
    let s = creds(vec![credential("a"), credential("b"), credential("c")]);
    let mut i = input(&r, &m, &s);
    i.rand = 0.5;
    let mut got = ids(&rank(&i).candidates);
    got.sort();
    assert_eq!(got, ["a", "b", "c"]);
}

#[test]
fn returns_an_empty_list_with_reasons_when_nothing_is_eligible() {
    let r = req();
    let m = score_model(vec![target()]);
    let s = creds(vec![cred_with("a", |c| c.enabled = false)]);
    let out = rank(&input(&r, &m, &s));
    assert!(out.candidates.is_empty());
    assert_eq!(out.excluded.len(), 1);
}

#[test]
fn candidates_carry_their_per_term_reasons() {
    let r = req();
    let m = score_model(vec![target()]);
    let s = creds(vec![credential("a")]);
    let out = rank(&input(&r, &m, &s));
    let reasons = out.candidates[0].reasons;
    // tier 1 alone, healthy, unknown oauth quota, priced alone, unmeasured, idle.
    assert_eq!(
        (
            reasons.tier,
            reasons.health,
            reasons.quota,
            reasons.cost,
            reasons.latency,
            reasons.load
        ),
        (1.0, 1.0, 0.5, 1.0, 0.5, 1.0)
    );
}

#[test]
fn ranking_is_stable_for_identical_inputs() {
    let r = req();
    let m = score_model(vec![target()]);
    let s = creds(vec![credential("a"), credential("b"), credential("c")]);
    let a = ids(&rank(&input(&r, &m, &s)).candidates);
    assert_eq!(a, ids(&rank(&input(&r, &m, &s)).candidates));
    // Equal scores keep arrival order (JS `sort` is stable).
    assert_eq!(a, ["a", "b", "c"]);
}

#[test]
fn the_weighted_lottery_draws_a_near_spent_account_less_often() {
    let r = req();
    let m = model(vec![target()], Strategy::Weighted);
    let s = snapshot(Snap {
        credentials: vec![credential("drained"), credential("fresh")],
        quota: vec![
            quota_with("drained", 95.0, Some(100.0), |q| q.observed_at = NOW),
            quota_with("fresh", 5.0, Some(100.0), |q| q.observed_at = NOW),
        ],
        ..Snap::default()
    });
    let pick = |rand: f64| {
        let mut i = input(&r, &m, &s);
        i.rand = rand;
        ids(&rank(&i).candidates)[0].clone()
    };
    assert_eq!(pick(0.04), "drained");
    assert_eq!(pick(0.06), "fresh");
}

#[test]
fn a_candidate_with_no_headroom_left_is_never_drawn() {
    let r = req();
    let m = model(vec![target()], Strategy::Weighted);
    let s = snapshot(Snap {
        credentials: vec![credential("spent"), credential("fresh")],
        quota: vec![
            quota_with("spent", 100.0, Some(100.0), |q| q.observed_at = NOW),
            quota_with("fresh", 0.0, Some(100.0), |q| q.observed_at = NOW),
        ],
        ..Snap::default()
    });
    let mut i = input(&r, &m, &s);
    i.rand = 0.999;
    assert_eq!(ids(&rank(&i).candidates)[0], "fresh");
}

#[test]
fn round_robin_skips_past_an_account_close_to_exhaustion() {
    let r = req();
    let m = model(vec![target()], Strategy::RoundRobin);
    let s = snapshot(Snap {
        credentials: vec![credential("idle-but-spent"), credential("busier")],
        quota: vec![
            quota_with("idle-but-spent", 97.0, Some(100.0), |q| q.observed_at = NOW),
            quota_with("busier", 20.0, Some(100.0), |q| q.observed_at = NOW),
        ],
        ..Snap::default()
    });
    let rec = recent(&[
        ("idle-but-spent", Some(NOW - 600_000.0), None),
        ("busier", Some(NOW - 1_000.0), None),
    ]);
    let mut i = input(&r, &m, &s);
    i.recent = Some(&rec);
    assert_eq!(ids(&rank(&i).candidates), ["busier", "idle-but-spent"]);
}

#[test]
fn round_robin_still_rotates_when_both_accounts_have_headroom() {
    let r = req();
    let m = model(vec![target()], Strategy::RoundRobin);
    let s = snapshot(Snap {
        credentials: vec![credential("idle"), credential("busier")],
        quota: vec![
            quota_with("idle", 40.0, Some(100.0), |q| q.observed_at = NOW),
            quota_with("busier", 20.0, Some(100.0), |q| q.observed_at = NOW),
        ],
        ..Snap::default()
    });
    let rec = recent(&[
        ("idle", Some(NOW - 600_000.0), None),
        ("busier", Some(NOW - 1_000.0), None),
    ]);
    let mut i = input(&r, &m, &s);
    i.recent = Some(&rec);
    assert_eq!(ids(&rank(&i).candidates)[0], "idle");
}

#[test]
fn round_robin_counts_requests_in_flight_not_requests_already_finished() {
    let r = req();
    let m = model(vec![target()], Strategy::RoundRobin);
    let s = creds(vec![credential("serving"), credential("free")]);
    let load = HashMap::from([(health_key("serving", "claude-opus-4"), 3.0)]);
    let rec = recent(&[
        ("serving", Some(NOW - 600_000.0), None),
        ("free", Some(NOW - 1_000.0), None),
    ]);
    let mut i = input(&r, &m, &s);
    i.load = Some(&load);
    i.recent = Some(&rec);
    assert_eq!(ids(&rank(&i).candidates)[0], "free");
}

#[test]
fn weighted_selection_will_not_draw_a_failing_credential_at_full_weight() {
    let r = req();
    let m = model(vec![target()], Strategy::Weighted);
    let s = snapshot(Snap {
        credentials: vec![credential("well"), credential("sick")],
        health: vec![health_with("sick", |h| {
            h.consecutive_failures = 3;
            h.breaker_state = BreakerState::Open;
            h.opened_at = Some(-9_000_000.0);
        })],
        ..Snap::default()
    });
    let mut i = input(&r, &m, &s);
    i.rand = 0.6;
    assert_eq!(ids(&rank(&i).candidates)[0], "well");
}

// ---- scoring

#[test]
fn scores_latency_by_how_much_slower_it_is_not_by_rank_order() {
    let r = req();
    let m = score_model(vec![target()]);
    let s = snapshot(Snap {
        credentials: vec![credential("quick"), credential("slow")],
        settings: only("latency"),
        ..Snap::default()
    });
    let latency = |slow: f64| {
        let rec = recent(&[("quick", None, Some(100.0)), ("slow", None, Some(slow))]);
        let mut i = input(&r, &m, &s);
        i.recent = Some(&rec);
        let out = rank(&i);
        out.candidates
            .iter()
            .find(|c| c.credential.id == "slow")
            .expect("slow")
            .reasons
            .latency
    };
    assert!((latency(105.0) - 0.952).abs() < 0.005);
    assert!((latency(10_000.0) - 0.01).abs() < 0.005);
}

#[test]
fn an_unpriced_target_scores_neutral_without_collapsing_its_priced_peers() {
    let r = req();
    let m = score_model(vec![
        target_with(|t| {
            t.model = "thrifty".into();
            t.cost_per_m_tok = pricing(1.0, 3.0);
        }),
        target_with(|t| {
            t.model = "pricey".into();
            t.cost_per_m_tok = pricing(2.0, 6.0);
        }),
        target_with(|t| {
            t.model = "unpriced".into();
            t.cost_per_m_tok = pricing(0.0, 0.0);
        }),
    ]);
    let s = snapshot(Snap {
        credentials: vec![credential("a")],
        settings: only("cost"),
        ..Snap::default()
    });
    let out = rank(&input(&r, &m, &s));
    let cost = |name: &str| {
        out.candidates
            .iter()
            .find(|c| c.target.model == name)
            .expect("target")
            .reasons
            .cost
    };
    assert_eq!(cost("unpriced"), 0.5);
    assert_eq!(cost("thrifty"), 1.0);
    assert!((cost("pricey") - 0.5).abs() < 0.005);
}

fn cheapest_for(r: &omni_ir::request::ChatRequest) -> String {
    let m = score_model(vec![
        target_with(|t| {
            t.model = "cheap-input".into();
            t.cost_per_m_tok = pricing(1.0, 100.0);
        }),
        target_with(|t| {
            t.model = "cheap-output".into();
            t.cost_per_m_tok = pricing(30.0, 10.0);
        }),
    ]);
    let s = snapshot(Snap {
        credentials: vec![credential("a")],
        settings: only("cost"),
        ..Snap::default()
    });
    models(&rank(&input(r, &m, &s)).candidates)[0].clone()
}

fn prompt(chars: usize, max_tokens: Option<f64>) -> omni_ir::request::ChatRequest {
    let mut v = json!({
        "model": "fast",
        "messages": [{ "role": "user", "content": [{ "type": "text", "text": "x".repeat(chars) }] }],
        "stream": true
    });
    if let Some(m) = max_tokens {
        v["maxTokens"] = json!(m);
    }
    request(v)
}

#[test]
fn prices_the_request_in_front_of_it_not_an_average_request() {
    assert_eq!(cheapest_for(&prompt(400, None)), "cheap-output");
    assert_eq!(cheapest_for(&prompt(400_000, None)), "cheap-input");
}

#[test]
fn treats_an_unusually_low_max_tokens_as_a_real_ceiling_on_output() {
    assert_eq!(cheapest_for(&prompt(4_000, None)), "cheap-output");
    assert_eq!(cheapest_for(&prompt(4_000, Some(100.0))), "cheap-input");
}

#[test]
fn prefers_the_credential_with_fewer_requests_in_flight() {
    let r = req();
    let m = score_model(vec![target()]);
    let s = snapshot(Snap {
        credentials: vec![credential("busy"), credential("idle")],
        settings: only("load"),
        ..Snap::default()
    });
    let load = HashMap::from([(health_key("busy", "claude-opus-4"), 2.0)]);
    let mut i = input(&r, &m, &s);
    i.load = Some(&load);
    assert_eq!(ids(&rank(&i).candidates)[0], "idle");
}

#[test]
fn prefers_the_target_with_the_cheaper_cache_read_for_a_cached_prompt() {
    let r = request(json!({
        "model": "fast",
        "messages": [{ "role": "user", "content": [
            { "type": "text", "text": "x".repeat(400_000), "cacheControl": { "type": "ephemeral" } },
            { "type": "text", "text": "and now the new turn" }
        ] }],
        "stream": true
    }));
    let mut dear = pricing(3.0, 15.0);
    dear.cache_read = Some(3.0);
    let mut cheap = pricing(3.0, 15.0);
    cheap.cache_read = Some(0.3);
    let m = score_model(vec![
        target_with(|t| {
            t.model = "dear-cache".into();
            t.cost_per_m_tok = dear;
        }),
        target_with(|t| {
            t.model = "cheap-cache".into();
            t.cost_per_m_tok = cheap;
        }),
    ]);
    let s = snapshot(Snap {
        credentials: vec![credential("a")],
        settings: only("cost"),
        ..Snap::default()
    });
    assert_eq!(
        models(&rank(&input(&r, &m, &s)).candidates)[0],
        "cheap-cache"
    );
}

#[test]
fn a_zero_first_token_measurement_is_unknown_not_instant() {
    let r = req();
    let m = score_model(vec![target()]);
    let s = snapshot(Snap {
        credentials: vec![credential("unmeasured"), credential("slow")],
        settings: only("latency"),
        ..Snap::default()
    });
    let rec = recent(&[("unmeasured", None, Some(0.0)), ("slow", None, Some(400.0))]);
    let mut i = input(&r, &m, &s);
    i.recent = Some(&rec);
    let out = rank(&i);
    let lat = |id: &str| {
        out.candidates
            .iter()
            .find(|c| c.credential.id == id)
            .expect("id")
            .reasons
            .latency
    };
    assert_eq!(lat("unmeasured"), 0.5);
    assert_eq!(lat("slow"), 1.0);
}
