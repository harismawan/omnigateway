mod common;
use common::*;
use omni_gateway::{
    dispatch::Request,
    screening::{SmartDecision, check_confidentiality},
};

async fn check(model: &str, configured: bool) -> (SmartDecision, usize) {
    let f = fixture(&["c0"]);
    if configured {
        set_setting(&f.path, "smartRouterClassifierModel", "\"m1\"");
        set_setting(&f.path, "smartRouterLocalModel", "\"m1\"");
    }
    let h = harness(&f, vec![]);
    let decision = check_confidentiality(
        h.deps.clone(),
        &Request {
            request: chat(model, false),
            request_id: "parent".into(),
            api_key_id: None,
            route_started_at: 1000,
        },
    )
    .await;
    let calls = h.script.calls();
    h.writer.close().await.expect("close");
    (decision, calls)
}

#[tokio::test]
async fn unconfigured_is_checked_before_already_local() {
    let (decision, calls) = check("m1", false).await;
    assert!(
        matches!(decision, SmartDecision::Refused(r) if r.notes == ["smart-router:unconfigured"])
    );
    assert_eq!(calls, 0);
}

#[tokio::test]
async fn already_local_bypasses_classifier() {
    let (decision, calls) = check("m1", true).await;
    assert!(
        matches!(decision, SmartDecision::Proceed { local_model: Some(m), notes } if m == "m1" && notes == ["smart-router:already-local"])
    );
    assert_eq!(calls, 0);
}

#[tokio::test]
async fn configured_external_classifier_is_rejected_without_transport() {
    let f = fixture(&["c0"]);
    set_setting(&f.path, "smartRouterClassifierModel", "\"gpt-4o\"");
    set_setting(&f.path, "smartRouterLocalModel", "\"m1\"");
    let h = harness(&f, vec![]);
    let decision = check_confidentiality(
        h.deps.clone(),
        &Request {
            request: chat("m1", false),
            request_id: "parent".into(),
            api_key_id: None,
            route_started_at: 1000,
        },
    )
    .await;
    assert!(
        matches!(decision, SmartDecision::Refused(r) if r.notes == ["smart-router:unconfigured"])
    );
    assert_eq!(h.script.calls(), 0);
    h.writer.close().await.expect("close");
}

#[tokio::test]
async fn public_verdict_is_cached_and_only_one_aggregate_row_is_written() {
    omni_gateway::clock::init_request_ids().expect("RNG");
    let f = fixture(&["c0"]);
    set_setting(&f.path, "smartRouterClassifierModel", "\"m1\"");
    set_setting(&f.path, "smartRouterLocalModel", "\"m1\"");
    let Reply::Http(status, headers, body) = sse_ok(1) else {
        unreachable!()
    };
    let h = harness(
        &f,
        vec![Reply::Http(
            status,
            headers,
            body.into_iter()
                .map(|s| s.replace("hi ", "PUBLIC"))
                .collect(),
        )],
    );
    let req = Request {
        request: chat("gpt-4o", false),
        request_id: "parent".into(),
        api_key_id: Some("parent-key".into()),
        route_started_at: 1000,
    };
    for _ in 0..2 {
        assert!(matches!(
            check_confidentiality(h.deps.clone(), &req).await,
            SmartDecision::Proceed {
                local_model: None,
                ..
            }
        ));
    }
    assert_eq!(h.script.calls(), 1);
    h.writer.close().await.expect("close");
    assert_eq!(
        rows(
            &f.path,
            "SELECT requested_model,status,attempts,input_tokens,output_tokens,degradations FROM request_logs"
        ),
        vec![vec![
            "m1",
            "200",
            "1",
            "10",
            "4",
            r#"["smart-router:classifier"]"#
        ]]
    );
}
