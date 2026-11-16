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
