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
