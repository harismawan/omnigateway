#![allow(clippy::unwrap_used)]
use omni_gateway::body_capture::{Collector, FrameSink};
use omni_ir::jsjson::{parse_js, stringify};
#[test]
fn client_capture_frames_exclude_sse_record_delimiters() {
    let fixture = common::fixture(&["c0"]);
    let mut capture = omni_gateway::body_capture::CaptureCompletion {
        collector: Collector::new(true),
        sink: FrameSink::default(),
        store: std::sync::Arc::new(omni_store::Store::Sqlite {
            store: std::sync::Arc::new(std::sync::Mutex::new(
                omni_store::SqliteStore::open(&fixture.path, 0).unwrap(),
            )),
            path: fixture.path.clone(),
            day_offset_minutes: 0,
        }),
        key: common::key(),
    };
    capture.frame("event: message\ndata: first\n\nevent: message\ndata: second\n\n");
    assert_eq!(
        capture.sink.frames,
        [
            "event: message\ndata: first",
            "event: message\ndata: second"
        ]
    );
}

mod common;

#[test]
fn attempts_record_wire_order_throw_and_buffered_response() {
    let c = Collector::new(true);
    c.request(parse_js(r#"{"original":"\ud800"}"#).unwrap());
    let first = c.attempt("anthropic", r#"{"tools":["cloaked"]}"#);
    let second = c.attempt("anthropic", "not json");
    c.text(second, "data: ok\r\n\r\ndata: done\n\n");
    c.response(parse_js("42").unwrap());
    assert_eq!(
        stringify(&c.artifact("req_1", 123, None)).unwrap(),
        r#"{"schemaVersion":1,"requestId":"req_1","at":123,"client":{"request":{"original":"\ud800"},"response":42,"truncated":false},"attempts":[{"attempt":1,"provider":"anthropic","request":{"tools":["cloaked"]},"response":null,"streamChunks":null,"truncated":false},{"attempt":2,"provider":"anthropic","request":"not json","response":"data: ok\r\n\r\ndata: done\n\n","streamChunks":["data: ok","data: done"],"truncated":false}],"error":null}"#
    );
    assert_eq!(first, 0);
}

#[test]
fn frames_evict_head_but_keep_one_oversize_frame_and_count_code_units() {
    let mut s = FrameSink::default();
    s.write(&"😀".repeat(262_144));
    s.write("end");
    assert!(s.truncated);
    assert_eq!(s.frames, vec!["end"]);
    let mut s = FrameSink::default();
    s.write(&"a".repeat(524_289));
    assert!(!s.truncated);
    assert_eq!(s.frames.len(), 1);
}

#[test]
fn stream_cap_is_soft_drops_later_bytes_and_preserves_decoder_state() {
    let c = Collector::new(true);
    let a = c.attempt("openai", "");
    c.chunk(a, &[0xef, 0xbb]);
    c.chunk(a, &[0xbf, 0xf0, 0x9f]);
    c.chunk(a, &[0x98, 0x80]);
    c.chunk(a, &vec![b'x'; 524_288]);
    c.chunk(a, b"discard");
    c.end(a, false);
    let text = stringify(&c.artifact("req_1", 0, None)).unwrap();
    assert!(text.contains("\"response\":\"😀xxx"));
    assert!(!text.contains("discard"));
    assert!(!text.contains('\u{feff}'));
    assert!(text.contains("\"truncated\":true"));
}

#[test]
fn failed_drain_keeps_partial_without_flushing_incomplete_utf8() {
    let c = Collector::new(true);
    let a = c.attempt("openai", "");
    c.chunk(a, &[b'a', 0xf0, 0x9f]);
    c.end(a, true);
    c.truncated();
    let text = stringify(&c.artifact("req_1", 0, Some(("AUTH", 401)))).unwrap();
    assert!(text.contains("\"response\":\"a\",\"streamChunks\":[\"a\"],\"truncated\":true"));
    assert!(text.contains("\"client\":{\"request\":null,\"response\":null,\"truncated\":true}"));
    assert!(text.ends_with("\"error\":{\"code\":\"AUTH\",\"status\":401}}"));
}
