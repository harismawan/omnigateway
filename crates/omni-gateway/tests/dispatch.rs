//! The dispatch loop against a scripted upstream: commit point, failover,
//! breaker writes, logs, deadline, load accounting and cancellation.

mod common;

use common::*;
use futures_util::StreamExt as _;
use omni_gateway::dispatch::{Request, dispatch};
use omni_ir::error::ErrorCode;
use omni_ir::stream::StreamEvent;
use std::time::Duration;

async fn drain(d: &mut omni_gateway::dispatch::Dispatched) -> Vec<StreamEvent> {
    let mut out = Vec::new();
    while let Some(ev) = d.events.next().await {
        out.push(ev.expect("no throw"));
    }
    out
}

fn req(model: &str) -> Request {
    Request {
        request: chat(model, true),
        request_id: "req_t".into(),
        api_key_id: Some("k1".into()),
        route_started_at: 1_000,
    }
}

async fn flush(h: Harness) {
    h.writer.close().await.expect("close");
}

#[tokio::test]
async fn openai_registered_codec_dispatches_responses() {
    let f = fixture(&["c0"]);
    let conn = rusqlite::Connection::open(&f.path).expect("db");
    conn.execute(
        "UPDATE credentials SET provider='openai',provider_data='{}'",
        [],
    )
    .expect("provider");
    let body = "event: response.created\ndata: {\"response\":{\"id\":\"r1\",\"model\":\"gpt-6-astra\"}}\n\nevent: response.completed\ndata: {\"response\":{\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}}\n\n";
    let h = harness(&f, vec![Reply::Http(200, vec![], vec![body.into()])]);
    let mut d = dispatch(h.deps.clone(), req("gpt-6-astra"));
    let events = drain(&mut d).await;
    assert!(
        matches!(events.last(), Some(StreamEvent::End { .. })),
        "{events:?}"
    );
    {
        let calls = h.script.seen.lock().expect("seen");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].provider, "openai");
        assert_eq!(calls[0].url, "https://api.openai.com/v1/responses");
        let sent: serde_json::Value = serde_json::from_str(&calls[0].body).expect("body");
        assert_eq!(sent["model"], "gpt-6-astra");
        assert_eq!(sent["stream"], true);
    }
    flush(h).await;
}

#[tokio::test]
async fn rejected_refresh_falls_back_and_removes_credential_from_snapshot() {
    let f = fixture(&["c0", "c1"]);
    set_setting(&f.path, "routingStrategy", "\"priority\"");
    let conn = rusqlite::Connection::open(&f.path).expect("db");
    conn.execute("UPDATE credentials SET provider='anthropic',provider_data='{}',weight=CASE id WHEN 'c0' THEN 100000 ELSE 1 END,tier=CASE id WHEN 'c0' THEN 1 ELSE 2 END", []).expect("providers");
    conn.execute(
        "UPDATE credentials SET auth_type='oauth',expires_at=1,refresh_token=? WHERE id='c0'",
        [omni_crypto::field::encrypt(&key(), "rejected")],
    )
    .expect("oauth");
    let body = "event: message_start\ndata: {\"message\":{\"id\":\"m\",\"model\":\"claude-opus-5-5\"}}\n\nevent: message_stop\ndata: {}\n\n";
    let h = harness(
        &f,
        vec![
            Reply::Http(400, vec![], vec![r#"{"error":"invalid_grant"}"#.into()]),
            Reply::Http(200, vec![], vec![body.into()]),
            Reply::Http(200, vec![], vec![body.into()]),
        ],
    );
    let mut d = dispatch(h.deps.clone(), req("claude-opus-5-5"));
    let events = drain(&mut d).await;
    assert!(
        matches!(events.last(), Some(StreamEvent::End { .. })),
        "{events:?}; calls={:?}",
        h.script.seen.lock().expect("seen")
    );
    assert_eq!(h.script.seen.lock().expect("seen").len(), 2);
    assert!(
        !h.deps
            .holder
            .load()
            .routing
            .credentials
            .iter()
            .find(|c| c.id == "c0")
            .expect("credential")
            .enabled
    );
    let mut second = dispatch(h.deps.clone(), req("claude-opus-5-5"));
    assert!(matches!(
        drain(&mut second).await.last(),
        Some(StreamEvent::End { .. })
    ));
    assert_eq!(h.script.seen.lock().expect("seen").len(), 3);
    flush(h).await;
}

#[tokio::test]
async fn expired_anthropic_refreshes_before_inference() {
    let f = fixture(&["c0"]);
    let conn = rusqlite::Connection::open(&f.path).expect("db");
    conn.execute("UPDATE credentials SET provider='anthropic',provider_data='{}',auth_type='oauth',expires_at=1,refresh_token=?", [omni_crypto::field::encrypt(&key(), "refresh")]).expect("oauth");
    let body = "event: message_start\ndata: {\"message\":{\"id\":\"m\",\"model\":\"claude-opus-5-5\"}}\n\nevent: message_stop\ndata: {}\n\n";
    let h = harness(
        &f,
        vec![
            Reply::Http(
                200,
                vec![],
                vec![r#"{"access_token":"rotated","expires_in":3600}"#.into()],
            ),
            Reply::Http(200, vec![], vec![body.into()]),
        ],
    );
    let mut d = dispatch(h.deps.clone(), req("claude-opus-5-5"));
    let events = drain(&mut d).await;
    assert!(matches!(events.last(), Some(StreamEvent::End { .. })));
    assert_eq!(h.script.seen.lock().expect("seen").len(), 2);
    flush(h).await;
}

#[tokio::test]
async fn anthropic_401_refreshes_and_retries_once() {
    let f = fixture(&["c0"]);
    let conn = rusqlite::Connection::open(&f.path).expect("db");
    conn.execute("UPDATE credentials SET provider='anthropic',provider_data='{}',auth_type='oauth',access_token=?,refresh_token=?", rusqlite::params![omni_crypto::field::encrypt(&key(), "old"), omni_crypto::field::encrypt(&key(), "refresh")]).expect("oauth");
    let h = harness(
        &f,
        vec![
            Reply::Http(401, vec![], vec!["{}".into()]),
            Reply::Http(200, vec![], vec![r#"{"access_token":"rotated"}"#.into()]),
            Reply::Http(401, vec![], vec!["{}".into()]),
        ],
    );
    let mut d = dispatch(h.deps.clone(), req("claude-opus-5-5"));
    while d.events.next().await.is_some() {}
    assert_eq!(h.script.seen.lock().expect("seen").len(), 3);
    flush(h).await;
}

#[tokio::test]
async fn anthropic_api_key_dispatch_uses_messages_codec() {
    let f = fixture(&["c0"]);
    let conn = rusqlite::Connection::open(&f.path).expect("db");
    conn.execute(
        "UPDATE credentials SET provider='anthropic', provider_data='{}'",
        [],
    )
    .expect("provider");
    let body = "event: message_start\ndata: {\"message\":{\"id\":\"m\",\"model\":\"claude-opus-5-5\",\"usage\":{\"input_tokens\":10}}}\n\nevent: message_delta\ndata: {\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":4}}\n\nevent: message_stop\ndata: {}\n\n";
    let h = harness(&f, vec![Reply::Http(200, vec![], vec![body.into()])]);
    let mut d = dispatch(h.deps.clone(), req("claude-opus-5-5"));
    let events = drain(&mut d).await;
    assert!(
        matches!(events.last(), Some(StreamEvent::End { .. })),
        "{events:?}"
    );
    let sent = h.script.seen.lock().expect("seen")[0].clone();
    assert_eq!(sent.url, "https://api.anthropic.com/v1/messages");
    assert!(sent.headers.iter().any(|(k, _)| k == "x-api-key"));
    assert!(sent.body.contains("cch="));
    assert_eq!(
        d.log.lock().expect("log").cost_usd,
        (10.0 * 4.0 + 4.0 * 20.0) / 1e6
    );
    flush(h).await;
}

#[tokio::test]
async fn a_healthy_stream_is_forwarded_and_begins_one_pending_row() {
    let f = fixture(&["c0"]);
    let h = harness(&f, vec![sse_ok(2)]);
    let mut d = dispatch(h.deps.clone(), req("m1"));
    let events = drain(&mut d).await;
    assert!(matches!(events.first(), Some(StreamEvent::Start { .. })));
    assert!(matches!(events.last(), Some(StreamEvent::End { .. })));
    let log = d.log.lock().expect("log").clone();
    assert_eq!(
        (
            log.status,
            log.attempts,
            log.input_tokens,
            log.output_tokens
        ),
        (200, 1, 10, 4)
    );
    assert_eq!(log.cost_usd, (10.0 * 1.0 + 4.0 * 2.0) / 1e6);
    assert!(log.ttft_ms.is_some());
    assert_eq!(log.credential_id.as_deref(), Some("c0"));
    // The load slot went back with this attempt's TTFT.
    assert!(h.deps.load.counts().is_empty());
    assert!(h.deps.load.recent()["c0::up0"].ewma_ttft_ms.is_some());
    let url = h.script.seen.lock().expect("seen")[0].url.clone();
    assert_eq!(url, "http://127.0.0.1:9/v1/chat/completions");
    flush(h).await;
    // Only the Begin was sent by dispatch (the route sends the Finish).
    assert_eq!(
        rows(
            &f.path,
            "SELECT state, at, api_key_id, requested_model, credential_id FROM request_logs"
        ),
        [["pending", "1000", "k1", "m1", "c0"]]
    );
}

#[tokio::test]
async fn a_retryable_failure_before_commit_fails_over_and_routes_the_row() {
    let f = fixture(&["c0", "c1"]);
    let h = harness(
        &f,
        vec![status(500, "{\"error\":{\"message\":\"boom\"}}"), sse_ok(1)],
    );
    let mut d = dispatch(h.deps.clone(), req("m1"));
    let events = drain(&mut d).await;
    assert!(matches!(events.last(), Some(StreamEvent::End { .. })));
    let log = d.log.lock().expect("log").clone();
    assert_eq!((log.status, log.attempts), (200, 2));
    assert_eq!(log.credential_id.as_deref(), Some("c1"));
    assert_eq!(h.script.calls(), 2);
    // The failed credential's health is in the snapshot at once.
    let snap = h.deps.holder.load();
    let hc = snap.routing.health_of("c0", "up0").expect("health");
    assert_eq!(hc.consecutive_failures, 1);
    flush(h).await;
    assert_eq!(
        rows(
            &f.path,
            "SELECT state, credential_id, resolved_model FROM request_logs"
        ),
        [["pending", "c1", "up1"]]
    );
    assert_eq!(
        rows(
            &f.path,
            "SELECT credential_id, model, breaker_state, consecutive_failures FROM credential_health"
        ),
        [["c0", "up0", "closed", "1"]]
    );
}

#[tokio::test]
async fn every_candidate_failing_is_all_candidates_failed_with_the_last_message() {
    let f = fixture(&["c0", "c1"]);
    let h = harness(&f, vec![Reply::Refused, Reply::Refused]);
    let mut d = dispatch(h.deps.clone(), req("m1"));
    let events = drain(&mut d).await;
    match events.as_slice() {
        [
            StreamEvent::Error {
                code,
                message,
                retryable,
            },
        ] => {
            assert_eq!(*code, ErrorCode::AllCandidatesFailed);
            assert_eq!(message, "connect ECONNREFUSED 127.0.0.1:9");
            assert!(!retryable);
        }
        other => panic!("{other:?}"),
    }
    let log = d.log.lock().expect("log").clone();
    assert_eq!((log.status, log.attempts), (503, 2));
    assert_eq!(log.error_code.as_deref(), Some("ALL_CANDIDATES_FAILED"));
    flush(h).await;
}

#[tokio::test]
async fn a_non_retryable_failure_stops_at_once_with_its_own_code() {
    let f = fixture(&["c0", "c1"]);
    let h = harness(
        &f,
        vec![status(400, "{\"error\":{\"message\":\"bad\"}}"), sse_ok(1)],
    );
    let mut d = dispatch(h.deps.clone(), req("m1"));
    let events = drain(&mut d).await;
    assert!(matches!(
        events.as_slice(),
        [StreamEvent::Error {
            code: ErrorCode::BadRequest,
            ..
        }]
    ));
    assert_eq!(h.script.calls(), 1);
    flush(h).await;
}

#[tokio::test]
async fn max_attempts_bounds_the_candidates_tried() {
    let f = fixture(&["c0", "c1", "c2"]);
    set_setting(&f.path, "maxAttempts", "2");
    let h = harness(&f, vec![Reply::Refused, Reply::Refused, sse_ok(1)]);
    let mut d = dispatch(h.deps.clone(), req("m1"));
    let events = drain(&mut d).await;
    assert!(matches!(
        events.as_slice(),
        [StreamEvent::Error {
            code: ErrorCode::AllCandidatesFailed,
            ..
        }]
    ));
    assert_eq!(h.script.calls(), 2);
    flush(h).await;
}

#[tokio::test]
async fn an_error_after_the_commit_point_goes_in_stream_without_failover() {
    let f = fixture(&["c0", "c1"]);
    let h = harness(&f, vec![sse_breaks_after_commit(), sse_ok(1)]);
    let mut d = dispatch(h.deps.clone(), req("m1"));
    let events = drain(&mut d).await;
    assert!(
        events
            .iter()
            .any(|e| matches!(e, StreamEvent::BlockDelta { .. }))
    );
    match events.last() {
        Some(StreamEvent::Error { code, message, .. }) => {
            assert_eq!(*code, ErrorCode::Upstream);
            assert_eq!(message, "upstream stream ended before [DONE]");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(h.script.calls(), 1);
    let log = d.log.lock().expect("log").clone();
    assert_eq!(
        (log.status, log.error_code.as_deref()),
        (502, Some("UPSTREAM"))
    );
    flush(h).await;
}

#[tokio::test]
async fn an_unknown_model_fails_before_any_attempt_and_writes_no_row() {
    let f = fixture(&["c0"]);
    let h = harness(&f, vec![]);
    let mut d = dispatch(h.deps.clone(), req("nope"));
    let events = drain(&mut d).await;
    match events.as_slice() {
        [
            StreamEvent::Error {
                code,
                message,
                retryable,
            },
        ] => {
            assert_eq!(*code, ErrorCode::NoCandidates);
            assert_eq!(
                message,
                "model \"nope\" is not a configured virtual model and its provider could not be inferred"
            );
            assert!(!retryable);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(h.script.calls(), 0);
    flush(h).await;
    assert!(rows(&f.path, "SELECT id FROM request_logs").is_empty());
}

#[tokio::test]
async fn three_hard_failures_open_the_breaker_and_send_a_transition() {
    let f = fixture(&["c0"]);
    let h = harness(&f, vec![Reply::Refused, Reply::Refused, Reply::Refused]);
    for _ in 0..3 {
        let mut d = dispatch(h.deps.clone(), req("m1"));
        drain(&mut d).await;
    }
    let snap = h.deps.holder.load();
    let hc = snap.routing.health_of("c0", "up0").expect("health");
    assert_eq!(hc.breaker_state, omni_store::BreakerState::Open);
    // Open now: the next request finds no candidate.
    let mut d = dispatch(h.deps.clone(), req("m1"));
    let events = drain(&mut d).await;
    assert!(matches!(
        events.as_slice(),
        [StreamEvent::Error {
            code: ErrorCode::NoCandidates,
            ..
        }]
    ));
    flush(h).await;
    assert_eq!(
        rows(
            &f.path,
            "SELECT breaker_state, consecutive_failures FROM credential_health"
        ),
        [["open", "3"]]
    );
}

#[tokio::test]
async fn a_success_after_a_failure_closes_the_row_through_the_writer() {
    let f = fixture(&["c0"]);
    let h = harness(&f, vec![Reply::Refused, sse_ok(1)]);
    let mut d = dispatch(h.deps.clone(), req("m1"));
    drain(&mut d).await;
    let mut d = dispatch(h.deps.clone(), req("m1"));
    drain(&mut d).await;
    assert_eq!(
        h.deps
            .holder
            .load()
            .routing
            .health_of("c0", "up0")
            .map(|x| x.consecutive_failures),
        Some(0)
    );
    flush(h).await;
    assert_eq!(
        rows(
            &f.path,
            "SELECT breaker_state, consecutive_failures FROM credential_health"
        ),
        [["closed", "0"]]
    );
}

#[tokio::test]
async fn a_429_parks_the_credential_with_its_retry_after() {
    let f = fixture(&["c0", "c1"]);
    let h = harness(
        &f,
        vec![
            Reply::Http(
                429,
                vec![("retry-after".into(), "7".into())],
                vec!["{}".into()],
            ),
            sse_ok(1),
        ],
    );
    let mut d = dispatch(h.deps.clone(), req("m1"));
    drain(&mut d).await;
    let snap = h.deps.holder.load();
    let hc = snap.routing.health_of("c0", "up0").expect("health");
    let until = hc.rate_limited_until.expect("parked");
    let now = omni_gateway::clock::now_ms() as f64;
    assert!(
        until > now + 6_000.0 && until < now + 8_000.0,
        "{until} vs {now}"
    );
    flush(h).await;
}

#[tokio::test]
async fn delayed_disable_cannot_undo_admin_reenable() {
    let f = fixture(&["c0"]);
    let h = harness(&f, vec![]);
    let db = omni_store::SqliteStore::open(&f.path, 0).expect("store");
    db.connection()
        .execute("UPDATE credentials SET enabled=0", [])
        .expect("disable");
    let _delayed = h
        .deps
        .refresher
        .store
        .credential(&key(), "c0")
        .await
        .expect("read")
        .expect("row");
    db.connection()
        .execute(
            "UPDATE credentials SET enabled=1,label='admin',weight=19",
            [],
        )
        .expect("admin edit");
    h.deps.holder.rebuild(&db).expect("rebuild");
    h.deps
        .holder
        .refresh_credential(h.deps.refresher.store.clone(), "c0".into())
        .await
        .expect("fresh publication");
    let snapshot = h.deps.holder.load();
    assert!(snapshot.routing.credentials[0].enabled);
    assert_eq!(snapshot.routing.credentials[0].label, "admin");
    assert_eq!(snapshot.routing.credentials[0].weight, 19.0);
    flush(h).await;
}

#[tokio::test]
async fn delayed_rebuild_and_equal_stamp_patch_cannot_restore_old_credential() {
    let f = fixture(&["c0"]);
    let h = harness(&f, vec![]);
    let store = omni_store::SqliteStore::open(&f.path, 0).expect("store");
    store
        .connection()
        .execute("UPDATE credentials SET enabled=0", [])
        .expect("same-stamp disable");
    h.deps
        .holder
        .refresh_credential(h.deps.refresher.store.clone(), "c0".into())
        .await
        .expect("publish");
    assert!(!h.deps.holder.load().routing.credentials[0].enabled);
    store
        .connection()
        .execute("DELETE FROM credentials", [])
        .expect("delete");
    h.deps
        .holder
        .refresh_credential(h.deps.refresher.store.clone(), "c0".into())
        .await
        .expect("publish deletion");
    assert!(h.deps.holder.load().routing.credentials.is_empty());
    // A targeted refresh never discovers a new row, even if it exists in DB.
    store.connection().execute("INSERT INTO credentials (id,provider,label,auth_type,enabled,tier,weight,provider_data,created_at,updated_at) VALUES ('c0','anthropic','new','oauth',1,1,1,'{}',0,0)", []).expect("reinsert");
    h.deps
        .holder
        .refresh_credential(h.deps.refresher.store.clone(), "c0".into())
        .await
        .expect("missing snapshot row");
    assert!(h.deps.holder.load().routing.credentials.is_empty());
    flush(h).await;
}

#[tokio::test]
async fn null_expiry_does_not_trigger_refresh() {
    let f = fixture(&["c0"]);
    let conn = rusqlite::Connection::open(&f.path).expect("db");
    conn.execute("UPDATE credentials SET provider='anthropic',provider_data='{}',auth_type='oauth',access_token=?,refresh_token=?,expires_at=NULL",rusqlite::params![omni_crypto::field::encrypt(&key(),"access"),omni_crypto::field::encrypt(&key(),"refresh")]).expect("oauth");
    let h = harness(
        &f,
        vec![Reply::Http(
            200,
            vec![],
            vec!["event: message_stop\ndata: {}\n\n".into()],
        )],
    );
    let mut d = dispatch(h.deps.clone(), req("claude-opus-5-5"));
    drain(&mut d).await;
    {
        let seen = h.script.seen.lock().expect("seen");
        assert_eq!(seen.len(), 1);
        assert!(seen[0].url.ends_with("/v1/messages"));
    }
    assert_eq!(h.deps.refresher.sweep(None).await.expect("sweep"), 0);
    flush(h).await;
}

#[tokio::test]
async fn concurrent_snapshot_publication_never_regresses_rotation() {
    let f = fixture(&["c0"]);
    let h = harness(&f, vec![]);
    let db = rusqlite::Connection::open(&f.path).expect("db");
    db.execute("UPDATE credentials SET token_version=2,updated_at=100", [])
        .expect("rotate");
    let a = h
        .deps
        .holder
        .refresh_credential(h.deps.refresher.store.clone(), "c0".into());
    let b = h
        .deps
        .holder
        .refresh_credential(h.deps.refresher.store.clone(), "c0".into());
    let (a, b) = tokio::join!(a, b);
    a.expect("first");
    b.expect("second");
    assert_eq!(h.deps.holder.load().routing.credentials[0].token_version, 2);
    assert_eq!(h.deps.holder.load().routing.credentials[0].updated_at, 100);
    flush(h).await;
}

#[tokio::test]
async fn refresh_waits_obey_dispatch_deadline() {
    for preemptive in [true, false] {
        let f = fixture(&["c0"]);
        set_setting(&f.path, "requestDeadlineMs", "150");
        let conn = rusqlite::Connection::open(&f.path).expect("db");
        conn.execute("UPDATE credentials SET provider='anthropic',provider_data='{}',auth_type='oauth',access_token=?,refresh_token=?,expires_at=?", rusqlite::params![omni_crypto::field::encrypt(&key(), "old"),omni_crypto::field::encrypt(&key(), "refresh"),if preemptive {1_i64} else {4102444800000}]).expect("oauth");
        let replies = if preemptive {
            vec![Reply::Hang]
        } else {
            vec![Reply::Http(401, vec![], vec!["{}".into()]), Reply::Hang]
        };
        let h = harness(&f, replies);
        let mut d = dispatch(h.deps.clone(), req("claude-opus-5-5"));
        let events = tokio::time::timeout(Duration::from_secs(2), drain(&mut d))
            .await
            .expect("refresh waiter must respect deadline");
        assert!(matches!(
            events.last(),
            Some(StreamEvent::Error {
                code: ErrorCode::Timeout,
                ..
            })
        ));
        drop(d);
        assert!(h.deps.load.counts().is_empty());
        flush(h).await;
    }
}

#[tokio::test]
async fn the_deadline_turns_a_hanging_upstream_into_a_timeout() {
    let f = fixture(&["c0"]);
    set_setting(&f.path, "requestDeadlineMs", "150");
    let h = harness(&f, vec![Reply::Hang]);
    let mut d = dispatch(h.deps.clone(), req("m1"));
    let started = std::time::Instant::now();
    let events = drain(&mut d).await;
    assert!(started.elapsed() < Duration::from_secs(2));
    match events.as_slice() {
        [StreamEvent::Error { code, message, .. }] => {
            assert_eq!(*code, ErrorCode::Timeout);
            assert_eq!(message, "request deadline exceeded");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(d.log.lock().expect("log").status, 504);
    flush(h).await;
}

#[tokio::test]
async fn dropping_the_stream_mid_attempt_releases_the_load_slot() {
    let f = fixture(&["c0"]);
    let h = harness(&f, vec![Reply::Hang]);
    let mut d = dispatch(h.deps.clone(), req("m1"));
    // The head slot is claimed at rank time.
    assert_eq!(h.deps.load.counts().get("c0::up0"), Some(&1.0));
    let pull = tokio::time::timeout(Duration::from_millis(50), d.events.next()).await;
    assert!(pull.is_err(), "the upstream hangs");
    drop(d);
    assert!(h.deps.load.counts().is_empty());
    flush(h).await;
}

#[tokio::test]
async fn a_load_burst_fans_out_across_score_ranked_credentials() {
    // Round robin reads in-flight counts: two concurrent requests pick two
    // credentials.
    let f = fixture(&["c0", "c1"]);
    let c = rusqlite::Connection::open(&f.path).expect("open");
    c.execute("UPDATE virtual_models SET strategy='roundRobin'", [])
        .expect("strategy");
    drop(c);
    let h = harness(&f, vec![Reply::Hang, Reply::Hang]);
    let a = dispatch(h.deps.clone(), req("m1"));
    let b = dispatch(h.deps.clone(), req("m1"));
    let counts = h.deps.load.counts();
    assert_eq!(counts.get("c0::up0"), Some(&1.0));
    assert_eq!(counts.get("c1::up1"), Some(&1.0));
    drop((a, b));
    flush(h).await;
}

#[tokio::test]
async fn a_codec_throw_after_the_commit_point_is_forwarded_in_stream() {
    let f = fixture(&["c0", "c1"]);
    let h = harness(
        &f,
        vec![
            Reply::Http(
                200,
                vec![],
                vec![
                    "data: {\"id\":\"u1\",\"model\":\"up\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"a\"}}]}\n\n".into(),
                    "data: {\"id\":\"u1\",\"model\":\"up\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[null]}}]}\n\n".into(),
                ],
            ),
            sse_ok(1),
        ],
    );
    let mut d = dispatch(h.deps.clone(), req("m1"));
    let events = drain(&mut d).await;
    match events.last() {
        Some(StreamEvent::Error {
            code,
            message,
            retryable,
        }) => {
            assert_eq!(*code, ErrorCode::Upstream);
            assert_eq!(message, "custom codec decode threw");
            assert!(!retryable);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(h.script.calls(), 1, "no failover after commit");
    assert_eq!(d.log.lock().expect("log").status, 502);
    flush(h).await;
}

#[tokio::test]
async fn a_codec_throw_before_the_commit_point_fails_over() {
    let f = fixture(&["c0", "c1"]);
    let h = harness(
        &f,
        vec![
            Reply::Http(
                200,
                vec![],
                vec!["data: {\"id\":\"u1\",\"model\":\"up\",\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[null]}}]}\n\n".into()],
            ),
            sse_ok(1),
        ],
    );
    let mut d = dispatch(h.deps.clone(), req("m1"));
    let events = drain(&mut d).await;
    assert!(matches!(events.last(), Some(StreamEvent::End { .. })));
    assert_eq!(h.script.calls(), 2);
    flush(h).await;
}

#[tokio::test]
async fn a_rebuild_before_the_health_write_lands_does_not_lose_the_failure() {
    let f = fixture(&["c0"]);
    let h = harness(&f, vec![Reply::Refused, Reply::Refused]);
    let mut d = dispatch(h.deps.clone(), req("m1"));
    drain(&mut d).await;
    // The refresher rebuilds from the store before the writer's batch
    // carrying the measurement has committed.
    let store = omni_store::SqliteStore::open(&f.path, 0).expect("store");
    h.deps.holder.rebuild(&store).expect("rebuild");
    let mut d = dispatch(h.deps.clone(), req("m1"));
    drain(&mut d).await;
    flush(h).await;
    assert_eq!(
        rows(
            &f.path,
            "SELECT consecutive_failures FROM credential_health"
        ),
        [["2"]]
    );
}

/// `n` tool calls with no arguments: block starts and ends but no delta, so
/// nothing commits; then the stream ends without `[DONE]` (retryable).
fn many_non_delta_events(n: usize) -> Reply {
    let mut body = Vec::new();
    for i in 0..n {
        body.push(format!(
            "data: {{\"id\":\"u1\",\"model\":\"up\",\"choices\":[{{\"index\":0,\"delta\":{{\"tool_calls\":[{{\"index\":{i},\"id\":\"call_{i}\",\"function\":{{\"name\":\"f\"}}}}]}}}}]}}\n\n"
        ));
    }
    Reply::Http(200, vec![], body)
}

#[tokio::test]
async fn pre_commit_buffering_is_capped_and_then_commits_without_failover() {
    let f = fixture(&["c0", "c1"]);
    let h = harness(&f, vec![many_non_delta_events(3000), sse_ok(1)]);
    let mut d = dispatch(h.deps.clone(), req("m1"));
    let events = drain(&mut d).await;
    // Past the cap the attempt committed: its failure is in-stream, and the
    // second candidate is never called.
    assert_eq!(h.script.calls(), 1);
    match events.last() {
        // The decoder's own terminal event, yielded as TS yields it.
        Some(StreamEvent::Error { code, message, .. }) => {
            assert_eq!(*code, ErrorCode::Upstream);
            assert_eq!(message, "upstream stream ended before [DONE]");
        }
        other => panic!("{other:?}"),
    }
    assert!(d.log.lock().expect("log").ttft_ms.is_some());
    flush(h).await;
}

#[tokio::test]
async fn a_few_non_delta_events_stay_buffered_and_fail_over() {
    let f = fixture(&["c0", "c1"]);
    let h = harness(&f, vec![many_non_delta_events(10), sse_ok(1)]);
    let mut d = dispatch(h.deps.clone(), req("m1"));
    let events = drain(&mut d).await;
    assert_eq!(h.script.calls(), 2);
    assert!(matches!(events.last(), Some(StreamEvent::End { .. })));
    flush(h).await;
}

/// A live upstream that commits (one delta) and then hangs.
async fn commits_then_hangs() -> u16 {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let l = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let port = l.local_addr().expect("addr").port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let mut b = [0u8; 65536];
                let _n = s.read(&mut b).await;
                let d = "data: {\"id\":\"u\",\"model\":\"up\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"x\"}}]}\n\n";
                let msg = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{d}\r\n",
                    d.len()
                );
                if s.write_all(msg.as_bytes()).await.is_ok() {
                    std::future::pending::<()>().await;
                }
            });
        }
    });
    port
}

#[tokio::test]
async fn a_cancel_after_commit_releases_the_slot_with_the_observed_ttft() {
    let port = commits_then_hangs().await;
    let f = fixture(&["c0"]);
    rusqlite::Connection::open(&f.path)
        .expect("open")
        .execute(
            "UPDATE credentials SET provider_data=?",
            rusqlite::params![format!(
                "{{\"endpointId\":\"e0\",\"origin\":\"http://127.0.0.1:{port}\",\"protocol\":\"chat_completions\"}}"
            )],
        )
        .expect("origin");
    let mut h = harness(&f, vec![]);
    std::sync::Arc::get_mut(&mut h.deps).expect("unique").http =
        std::sync::Arc::new(omni_providers::http::Client::new());
    let mut d = dispatch(h.deps.clone(), req("m1"));
    while let Some(ev) = d.events.next().await {
        if matches!(ev.expect("event"), StreamEvent::BlockDelta { .. }) {
            break;
        }
    }
    let ttft = d.log.lock().expect("log").ttft_ms.expect("committed");
    drop(d);
    assert!(h.deps.load.counts().is_empty());
    #[allow(clippy::cast_precision_loss)]
    let want = ttft as f64;
    assert_eq!(h.deps.load.recent()["c0::up0"].ewma_ttft_ms, Some(want));
    flush(h).await;
}

#[tokio::test]
async fn one_non_delta_event_over_the_byte_cap_commits_at_once() {
    // A single tool-call start whose name alone is over 1 MiB, then the
    // stream ends without `[DONE]`.
    let name = "n".repeat(omni_gateway::dispatch::PENDING_MAX_BYTES + 10);
    let f = fixture(&["c0", "c1"]);
    let h = harness(
        &f,
        vec![
            Reply::Http(
                200,
                vec![],
                vec![format!(
                    "data: {{\"id\":\"u1\",\"model\":\"up\",\"choices\":[{{\"index\":0,\"delta\":{{\"tool_calls\":[{{\"index\":0,\"id\":\"c\",\"function\":{{\"name\":\"{name}\"}}}}]}}}}]}}\n\n"
                )],
            ),
            sse_ok(1),
        ],
    );
    let mut d = dispatch(h.deps.clone(), req("m1"));
    let events = drain(&mut d).await;
    assert_eq!(h.script.calls(), 1, "committed: no failover");
    assert!(
        events
            .iter()
            .any(|e| matches!(e, StreamEvent::BlockStart { .. }))
    );
    assert!(matches!(events.last(), Some(StreamEvent::Error { .. })));
    flush(h).await;
}
