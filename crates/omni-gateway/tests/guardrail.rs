mod common;
use common::*;
use omni_gateway::{dispatch::Request, screening::judge};

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
