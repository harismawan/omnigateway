//! Screening dispatches revalidate locality and do not write parent pending rows.
mod common;

use common::*;
use futures_util::StreamExt as _;
use omni_gateway::dispatch::{DispatchOptions, Request, dispatch_with_options};
use omni_ir::error::ErrorCode;
use omni_ir::stream::StreamEvent;

fn request(model: &str) -> Request {
    Request {
        request: chat(model, false),
        request_id: "classifier-call".into(),
        api_key_id: Some("parent-key".into()),
        route_started_at: 1_000,
    }
}

fn screening() -> DispatchOptions {
    DispatchOptions {
        request_transforms: false,
        local_only: true,
        on_route: false,
    }
}

#[tokio::test]
async fn screening_local_model_dispatches_without_pending_row() {
    let f = fixture(&["c0"]);
    let h = harness(&f, vec![sse_ok(1)]);
    let mut d = dispatch_with_options(h.deps.clone(), request("m1"), screening());
    let mut terminal = false;
    while let Some(event) = d.events.next().await {
        terminal |= matches!(event.expect("event"), StreamEvent::End { .. });
    }
    assert!(terminal);
    assert_eq!(h.script.calls(), 1);
    assert_eq!(d.log.lock().expect("log").status, 200);
    h.writer.close().await.expect("close");
    assert!(rows(&f.path, "SELECT id FROM request_logs").is_empty());
}

#[tokio::test]
async fn screening_rejects_inferred_external_model_before_transport() {
    let f = fixture(&["c0"]);
    let h = harness(&f, vec![]);
    let mut d = dispatch_with_options(h.deps.clone(), request("gpt-6-astra"), screening());
    assert!(matches!(d.events.next().await, Some(Ok(StreamEvent::Error {
        code: ErrorCode::Internal, ref message, ..
    })) if message == "confidential routing is not configured"));
    assert!(d.events.next().await.is_none());
    assert_eq!(h.script.calls(), 0);
    {
        let log = d.log.lock().expect("log");
        assert_eq!(log.status, 500);
        assert_eq!(log.attempts, 0);
    }
    h.writer.close().await.expect("close");
}

#[tokio::test]
async fn screening_rejects_snapshot_with_new_external_target() {
    let f = fixture(&["c0"]);
    let conn = rusqlite::Connection::open(&f.path).expect("db");
    conn.execute("UPDATE virtual_models SET targets=json_insert(targets,'$[#]',json('{\"provider\":\"openai\",\"model\":\"gpt-6-astra\",\"tier\":2,\"weight\":1}')) WHERE id='m1'", []).expect("external target");
    let h = harness(&f, vec![]);
    let mut d = dispatch_with_options(h.deps.clone(), request("m1"), screening());
    assert!(matches!(
        d.events.next().await,
        Some(Ok(StreamEvent::Error {
            code: ErrorCode::Internal,
            ..
        }))
    ));
    assert_eq!(h.script.calls(), 0);
    h.writer.close().await.expect("close");
}

#[tokio::test]
async fn normal_options_still_write_pending_row() {
    let f = fixture(&["c0"]);
    let h = harness(&f, vec![sse_ok(1)]);
    let mut d = dispatch_with_options(h.deps.clone(), request("m1"), DispatchOptions::default());
    while let Some(event) = d.events.next().await {
        event.expect("event");
    }
    assert_eq!(h.script.calls(), 1);
    h.writer.close().await.expect("close");
    assert_eq!(
        rows(&f.path, "SELECT id FROM request_logs"),
        vec![vec!["classifier-call"]]
    );
}
