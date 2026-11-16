mod common;
use common::*;
use omni_gateway::{
    dispatch::Request,
    screening::{SmartDecision, check_confidentiality},
};
use omni_providers::http::{HttpClient, HttpError, HttpRequest, HttpResponse};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

struct Together {
    ready: tokio::sync::Barrier,
    calls: AtomicUsize,
}

impl HttpClient for Together {
    fn send(
        &self,
        req: HttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, HttpError>> + Send + '_>,
    > {
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.ready.wait().await;
            let verdict = if req.body.contains(&"c".repeat(100)) {
                "CONFIDENTIAL"
            } else {
                "PUBLIC"
            };
            let Reply::Http(status, headers, body) = sse_ok(1) else {
                unreachable!()
            };
            let script = Script::new(vec![Reply::Http(
                status,
                headers,
                body.into_iter()
                    .map(|s| s.replace("hi ", verdict))
                    .collect(),
            )]);
            script.send(req).await
        })
    }
}

#[tokio::test]
async fn stopped_ready_sibling_is_counted_and_cached() {
    omni_gateway::clock::init_request_ids().expect("RNG");
    let f = fixture(&["c0"]);
    set_setting(&f.path, "smartRouterClassifierModel", "\"m1\"");
    set_setting(&f.path, "smartRouterLocalModel", "\"m1\"");
    set_setting(&f.path, "smartRouterPolicy", "\"ready-sibling-test\"");
    let mut h = harness(&f, vec![]);
    let transport = Arc::new(Together {
        ready: tokio::sync::Barrier::new(2),
        calls: AtomicUsize::new(0),
    });
    Arc::get_mut(&mut h.deps).expect("unique deps").http = transport.clone();
    let mut ir = serde_json::to_value(chat("gpt-4o", false)).expect("IR");
    let public = "p".repeat(7993);
    ir["messages"][0]["content"][0]["text"] =
        format!("{public}[user]\n{}", "c".repeat(7993)).into();
    let mut req = Request {
        request: serde_json::from_value(ir).expect("IR"),
        request_id: "ready-parent".into(),
        api_key_id: None,
        route_started_at: 1000,
    };
    assert!(matches!(
        check_confidentiality(h.deps.clone(), &req).await,
        SmartDecision::Proceed {
            local_model: Some(_),
            ..
        }
    ));
    // Both replies were ready before stop, including the public sibling.
    let mut ir = serde_json::to_value(&req.request).expect("IR");
    ir["messages"][0]["content"][0]["text"] = public.into();
    req.request = serde_json::from_value(ir).expect("IR");
    assert!(matches!(
        check_confidentiality(h.deps.clone(), &req).await,
        SmartDecision::Proceed {
            local_model: None,
            ..
        }
    ));
    assert_eq!(transport.calls.load(Ordering::SeqCst), 2);
    h.writer.close().await.expect("close");
    assert_eq!(
        rows(
            &f.path,
            "SELECT attempts,input_tokens,output_tokens FROM request_logs"
        ),
        vec![vec!["2", "20", "8"]]
    );
}

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
        matches!(decision, SmartDecision::Proceed { local_model: Some(m), notes, .. } if m == "m1" && notes == ["smart-router:already-local"])
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
