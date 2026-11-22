mod common;
use common::*;
use omni_gateway::{dispatch::Request, screening::judge};

#[tokio::test]
async fn pending_failover_is_attributed_sweepable_and_completed_once_on_cancel() {
    omni_gateway::clock::init_request_ids().expect("RNG");
    let f = fixture(&["c0", "c1"]);
    set_setting(&f.path, "guardrailModel", "\"m1\"");
    let h = harness(&f, vec![status(503, "unavailable"), Reply::Hang]);
    let req = Request {
        request: chat("m1", false),
        request_id: "pending-parent".into(),
        api_key_id: Some("pending-key".into()),
        route_started_at: 1000,
    };
    let mut call = Box::pin(judge(h.deps.clone(), &req, "pending-failover-policy", None));
    std::future::poll_fn(|cx| {
        assert!(std::future::Future::poll(call.as_mut(), cx).is_pending());
        std::task::Poll::Ready(())
    })
    .await;
    h.deps.writer.flush().await.expect("flush");
    assert_eq!(h.script.calls(), 2);
    assert_eq!(
        rows(
            &f.path,
            "SELECT requested_model,status,api_key_id,credential_id,state FROM request_logs"
        ),
        vec![vec!["m1", "0", "pending-key", "c1", "pending"]]
    );
    // The ordinary A11 dead-node sweep must see the classifier pending row.
    let conn = rusqlite::Connection::open(&f.path).expect("db");
    let swept =
        omni_store::usage::sweep_pending(&conn, "replacement-node", i64::MAX / 2).expect("sweep");
    assert_eq!(swept.len(), 1);
    assert_eq!(swept[0].status, 499);
    assert_eq!(swept[0].api_key_id.as_deref(), Some("pending-key"));
    drop(call);
    h.writer.close().await.expect("close");
    assert_eq!(
        rows(&f.path, "SELECT status,error_code,state FROM request_logs"),
        vec![vec!["499", "interrupted", "done"]]
    );
}

#[tokio::test]
async fn capped_surrogate_is_preserved_in_classifier_wire_bytes() {
    omni_gateway::clock::init_request_ids().expect("RNG");
    let f = fixture(&["c0"]);
    set_setting(&f.path, "guardrailModel", "\"m1\"");
    let h = harness(&f, vec![sse_ok(1)]);
    let text = format!("{}😀{}", "a".repeat(3991), "z".repeat(9000));
    let mut chat = chat("m1", false);
    chat.system = Some(
        serde_json::from_value(serde_json::json!([{"type":"text","text":text}])).expect("system"),
    );
    let req = Request {
        request: chat,
        request_id: "parent".into(),
        api_key_id: Some("surrogate-key".into()),
        route_started_at: 1000,
    };
    let (_, notes) = judge(h.deps.clone(), &req, "policy", None).await;
    assert!(notes.contains(&"guardrail:truncated".into()));
    let wire = h.script.seen.lock().expect("seen")[0].body.clone();
    assert!(wire.contains("\\ud83d"));
    assert!(!wire.contains("__omni_judge_utf16_"));
    h.writer.close().await.expect("close");
}

#[tokio::test]
async fn unconfigured_never_dispatches() {
    let f = fixture(&["c0"]);
    let h = harness(&f, vec![]);
    let req = Request {
        request: chat("m1", false),
        request_id: "parent".into(),
        api_key_id: Some("key".into()),
        route_started_at: 1000,
    };
    let (refusal, notes) = judge(h.deps.clone(), &req, "policy", None).await;
    assert_eq!(
        refusal.expect("refused").message,
        "usage policy check is not configured"
    );
    assert_eq!(notes, ["guardrail:unconfigured"]);
    assert_eq!(h.script.calls(), 0);
    h.writer.close().await.expect("close");
}

#[tokio::test]
async fn allow_and_deny_are_cached_and_independently_logged() {
    omni_gateway::clock::init_request_ids().expect("RNG");
    for (word, note) in [("ALLOW", "allowed"), ("DENY", "denied")] {
        let f = fixture(&["c0"]);
        set_setting(&f.path, "guardrailModel", "\"m1\"");
        let Reply::Http(status, headers, body) = sse_ok(1) else {
            unreachable!()
        };
        let h = harness(
            &f,
            vec![Reply::Http(
                status,
                headers,
                body.into_iter().map(|s| s.replace("hi ", word)).collect(),
            )],
        );
        let req = Request {
            request: chat("m1", false),
            request_id: "parent".into(),
            api_key_id: Some(format!("key-{word}")),
            route_started_at: 1000,
        };
        for _ in 0..2 {
            let (refusal, notes) = judge(h.deps.clone(), &req, "policy", None).await;
            assert_eq!(refusal.is_some(), word == "DENY");
            assert_eq!(notes, [format!("guardrail:{note}")]);
        }
        assert_eq!(h.script.calls(), 1);
        h.writer.close().await.expect("close");
        assert_eq!(
            rows(&f.path, "SELECT status,degradations FROM request_logs"),
            vec![vec!["200", r#"["guardrail:classifier"]"#]]
        );
    }
}
