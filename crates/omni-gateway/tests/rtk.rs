//! RTK in dispatch: applied once per request when `rtkEnabled` and
//! `request_transforms`, the same transformed request on every attempt, and
//! the report on whichever path completes the row. The classifier half: a
//! guardrail judges the request as received.

mod common;

use common::*;
use futures_util::StreamExt as _;
use omni_gateway::dispatch::{
    DispatchOptions, Dispatched, Request, dispatch, dispatch_with_options,
};
use omni_gateway::finish::Finisher;
use omni_ir::request::{ChatRequest, ContentBlock};
use omni_ir::stream::StreamEvent;
use omni_rtk::{RtkConfig, transform_request};

fn tool_chat(stream: bool) -> ChatRequest {
    serde_json::from_value(serde_json::json!({
        "model": "m1",
        "stream": stream,
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "run the tests"}]},
            {"role": "assistant", "content": [{"type": "toolUse", "id": "call-1", "name": "bash", "input": {"command": "bun test"}}]},
            {"role": "user", "content": [{"type": "toolResult", "toolUseId": "call-1", "content": bun_output()}]},
            {"role": "user", "content": [{"type": "text", "text": "thanks"}]},
        ],
    }))
    .expect("request")
}

/// What `omni-rtk` alone makes of the fixture: the text and the report the
/// wire and the row must carry.
fn expected() -> (String, Vec<String>) {
    let input = tool_chat(true);
    let out = transform_request(&input, &RtkConfig { enabled: true });
    assert!(out.report.applied, "the fixture is one RTK compresses");
    let text = match out.request.messages[2].content.first() {
        Some(ContentBlock::ToolResult(r)) => r.content.clone(),
        other => panic!("{other:?}"),
    };
    let r = &out.report;
    #[allow(clippy::cast_possible_truncation)]
    let saved = r.estimated_tokens_saved as i64;
    let filters = serde_json::to_string(&r.filters.iter().map(|f| f.as_str()).collect::<Vec<_>>())
        .expect("filters");
    let row = vec![
        "1".to_owned(),
        r.filter_hits.to_string(),
        r.original_code_units.to_string(),
        r.compressed_code_units.to_string(),
        saved.to_string(),
        filters,
    ];
    (text, row)
}

fn zero_report() -> Vec<String> {
    ["0", "0", "0", "0", "0", "[]"].map(str::to_owned).to_vec()
}

fn req(stream: bool) -> Request {
    Request {
        request: tool_chat(stream),
        request_id: "req_rtk".into(),
        api_key_id: Some("k1".into()),
        route_started_at: 1_000,
    }
}

/// The tool message's content in one recorded upstream body.
fn sent_tool_result(h: &Harness, call: usize) -> String {
    let body = h.script.seen.lock().expect("seen")[call].body.clone();
    let v: serde_json::Value = serde_json::from_str(&body).expect("body");
    v["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .find(|m| m["role"] == "tool")
        .and_then(|m| m["content"].as_str())
        .expect("tool message")
        .to_owned()
}

fn finisher(h: &Harness, d: &Dispatched) -> Finisher {
    let mut fin = Finisher::new(
        h.deps.writer.clone(),
        "req_rtk".into(),
        1_000,
        "openai",
        omni_gateway::clock::now_ms,
    );
    fin.outcome = Some(d.log.clone());
    fin.streaming();
    fin
}

/// Status and the six `rtk_*` columns of the one row.
async fn the_row(h: Harness, f: &Fixture) -> (String, Vec<String>) {
    h.writer.close().await.expect("close");
    let rows = rows(
        &f.path,
        "SELECT status, rtk_applied, rtk_filter_hits, rtk_original_code_units, \
         rtk_compressed_code_units, rtk_estimated_tokens_saved, rtk_filters FROM request_logs",
    );
    assert_eq!(rows.len(), 1, "{rows:?}");
    let mut row = rows.into_iter().next().expect("row");
    let status = row.remove(0);
    (status, row)
}

/// Drains the events the way a route does and completes the row.
async fn drain_and_complete(h: &Harness, mut d: Dispatched) {
    let mut fin = finisher(h, &d);
    while let Some(ev) = d.events.next().await {
        ev.expect("no throw");
    }
    fin.complete(false, None);
}

#[tokio::test]
async fn rtk_off_sends_the_tool_result_as_received_with_a_zero_report() {
    let f = fixture(&["c0"]);
    let h = harness(&f, vec![sse_ok(1)]);
    drain_and_complete(&h, dispatch(h.deps.clone(), req(true))).await;
    assert_eq!(sent_tool_result(&h, 0), bun_output());
    let (status, row) = the_row(h, &f).await;
    assert_eq!((status.as_str(), row), ("200", zero_report()));
}

#[tokio::test]
async fn rtk_on_sends_the_compressed_text_and_records_the_report() {
    let (text, report) = expected();
    for stream in [true, false] {
        let f = fixture(&["c0"]);
        set_setting(&f.path, "rtkEnabled", "true");
        let h = harness(&f, vec![sse_ok(1)]);
        drain_and_complete(&h, dispatch(h.deps.clone(), req(stream))).await;
        let sent = sent_tool_result(&h, 0);
        assert_eq!(sent, text, "stream={stream}");
        assert!(sent.encode_utf16().count() < bun_output().encode_utf16().count());
        let (status, row) = the_row(h, &f).await;
        assert_eq!(status, "200");
        assert_eq!(row, report, "stream={stream}");
        let hits: i64 = row[1].parse().expect("hits");
        let original: i64 = row[2].parse().expect("original");
        let compressed: i64 = row[3].parse().expect("compressed");
        assert!(hits >= 1 && compressed < original, "{row:?}");
        assert_ne!(row[5], "[]");
    }
}

#[tokio::test]
async fn every_failover_attempt_carries_the_same_compressed_text_and_one_report() {
    let (text, report) = expected();
    for first in [
        status(500, "{\"error\":{\"message\":\"boom\"}}"),
        Reply::Refused,
    ] {
        let f = fixture(&["c0", "c1"]);
        set_setting(&f.path, "rtkEnabled", "true");
        let h = harness(&f, vec![first, sse_ok(1)]);
        let d = dispatch(h.deps.clone(), req(true));
        let log = d.log.clone();
        drain_and_complete(&h, d).await;
        assert_eq!(h.script.calls(), 2);
        assert_eq!(sent_tool_result(&h, 0), text);
        assert_eq!(sent_tool_result(&h, 1), text);
        assert_eq!(log.lock().expect("log").attempts, 2);
        let (status, row) = the_row(h, &f).await;
        assert_eq!((status.as_str(), row), ("200", report.clone()));
    }
}

#[tokio::test]
async fn a_post_commit_error_still_carries_the_report() {
    let (_, report) = expected();
    let f = fixture(&["c0", "c1"]);
    set_setting(&f.path, "rtkEnabled", "true");
    let h = harness(&f, vec![sse_breaks_after_commit(), sse_ok(1)]);
    drain_and_complete(&h, dispatch(h.deps.clone(), req(true))).await;
    assert_eq!(h.script.calls(), 1, "committed: no failover");
    let (status, row) = the_row(h, &f).await;
    assert_eq!((status.as_str(), row), ("502", report));
}

#[tokio::test]
async fn a_client_cancel_after_commit_still_carries_the_report() {
    let (_, report) = expected();
    let f = fixture(&["c0"]);
    set_setting(&f.path, "rtkEnabled", "true");
    let h = harness(&f, vec![sse_ok(3)]);
    let mut d = dispatch(h.deps.clone(), req(true));
    let fin = finisher(&h, &d);
    while let Some(ev) = d.events.next().await {
        if matches!(ev.expect("event"), StreamEvent::BlockDelta { .. }) {
            break;
        }
    }
    // The client hangs up: the response body (and its finisher) is dropped.
    drop(d);
    drop(fin);
    let (status, row) = the_row(h, &f).await;
    assert_eq!((status.as_str(), row), ("499", report));
}

#[tokio::test]
async fn request_transforms_off_leaves_the_request_untouched_with_rtk_on() {
    let f = fixture(&["c0"]);
    set_setting(&f.path, "rtkEnabled", "true");
    let h = harness(&f, vec![sse_ok(1)]);
    let d = dispatch_with_options(
        h.deps.clone(),
        req(true),
        DispatchOptions {
            request_transforms: false,
            ..DispatchOptions::default()
        },
    );
    drain_and_complete(&h, d).await;
    assert_eq!(sent_tool_result(&h, 0), bun_output());
    let (status, row) = the_row(h, &f).await;
    assert_eq!((status.as_str(), row), ("200", zero_report()));
}

/// The guardrail's classifier judges the request as received; the parent
/// dispatch after it is compressed.
#[tokio::test]
async fn a_guardrail_classifier_sees_the_original_tool_result_with_rtk_on() {
    omni_gateway::clock::init_request_ids().expect("RNG");
    let (text, report) = expected();
    let f = fixture(&["c0"]);
    set_setting(&f.path, "rtkEnabled", "true");
    set_setting(&f.path, "guardrailModel", "\"m1\"");
    let Reply::Http(code, headers, body) = sse_ok(1) else {
        unreachable!()
    };
    let allow = Reply::Http(
        code,
        headers,
        body.into_iter()
            .map(|s| s.replace("hi ", "ALLOW"))
            .collect(),
    );
    let h = harness(&f, vec![allow, sse_ok(1)]);
    let mut d = omni_gateway::screening::screen_first(
        h.deps.clone(),
        req(true),
        Some("no secrets".into()),
        false,
        "openai",
        [None, None],
        None,
    );
    let mut fin = finisher(&h, &d);
    let events: Vec<StreamEvent> = d
        .events
        .by_ref()
        .map(|e| e.expect("no throw"))
        .collect()
        .await;
    assert!(
        matches!(events.last(), Some(StreamEvent::End { .. })),
        "{events:?}"
    );
    {
        let seen = h.script.seen.lock().expect("seen");
        assert_eq!(seen.len(), 2);
        // The classifier's prompt quotes the result as JSON text inside its
        // user turn: one distinctive line count stands for the original.
        assert_eq!(
            seen[0].body.matches("case passed").count(),
            300,
            "classifier judged the received request"
        );
    }
    assert_eq!(sent_tool_result(&h, 1), text);
    // The screened parent's row carries the parent dispatch's report; the
    // classifier files its own row, judged as received.
    fin.complete(false, None);
    drop(d);
    h.writer.close().await.expect("close");
    let cols = "status, rtk_applied, rtk_filter_hits, rtk_original_code_units, \
         rtk_compressed_code_units, rtk_estimated_tokens_saved, rtk_filters";
    let parent = rows(
        &f.path,
        &format!("SELECT {cols} FROM request_logs WHERE id = 'req_rtk'"),
    );
    let mut want = vec!["200".to_owned()];
    want.extend(report);
    assert_eq!(parent, vec![want]);
    let classifier = rows(
        &f.path,
        &format!("SELECT {cols} FROM request_logs WHERE id <> 'req_rtk'"),
    );
    let mut zero = vec!["200".to_owned()];
    zero.extend(zero_report());
    assert_eq!(classifier, vec![zero]);
}

/// The deadline's completion path: a hanging upstream past
/// `requestDeadlineMs` is the gateway's timeout (504), not a client cancel
/// (499), and its row carries the report.
#[tokio::test]
async fn a_deadline_timeout_still_carries_the_report() {
    let (_, report) = expected();
    let f = fixture(&["c0"]);
    set_setting(&f.path, "rtkEnabled", "true");
    set_setting(&f.path, "requestDeadlineMs", "150");
    let h = harness(&f, vec![Reply::Hang]);
    let mut d = dispatch(h.deps.clone(), req(true));
    let mut fin = finisher(&h, &d);
    let events: Vec<StreamEvent> = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        d.events.by_ref().map(|e| e.expect("no throw")).collect(),
    )
    .await
    .expect("the deadline ends the stream");
    match events.as_slice() {
        [StreamEvent::Error { code, message, .. }] => {
            assert_eq!(*code, omni_ir::error::ErrorCode::Timeout);
            assert_eq!(message, "request deadline exceeded");
        }
        other => panic!("{other:?}"),
    }
    fin.complete(false, None);
    drop(d);
    let (status, row) = the_row(h, &f).await;
    assert_eq!((status.as_str(), &row), ("504", &report));
    let code = rows(&f.path, "SELECT error_code FROM request_logs");
    assert_eq!(code, vec![vec!["TIMEOUT".to_owned()]]);
    assert!(
        row_num(&row, 1) >= 1 && row_num(&row, 3) < row_num(&row, 2),
        "{row:?}"
    );
    assert_ne!(row[5], "[]");
}

fn row_num(row: &[String], i: usize) -> i64 {
    row[i].parse().expect("number")
}
