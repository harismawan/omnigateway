#![allow(clippy::unwrap_used)]
use omni_gateway::body_capture::{Collector, FrameSink};
use omni_ir::jsjson::{parse_js, stringify};
use std::io::Write as _;
use std::process::{Command, Stdio};

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

fn reference(input: &serde_json::Value) -> serde_json::Value {
    let mut child = Command::new("bun")
        .args([
            "--no-env-file",
            "conformance/store/body-capture-reference.ts",
        ])
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("frozen oracle");
    let input = serde_json::to_vec(input).unwrap();
    // Input and output may exceed pipe capacity: feed concurrently.
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let out = child.wait_with_output().unwrap();
    writer.join().unwrap().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).unwrap()
}

#[test]
fn frame_sink_matches_frozen_oracle() {
    use serde_json::json;
    let mut cases = vec![
        vec![],
        vec!["".to_owned()],
        vec!["a".to_owned(), "b".to_owned()],
    ];
    for n in [524_287, 524_288, 524_289] {
        for ch in ["a", "😀"] {
            cases.push(vec![ch.repeat(n), "end".to_owned()]);
            cases.push(vec!["head".to_owned(), ch.repeat(n)]);
        }
    }
    let expected = reference(&json!({"sinks":cases}));
    for (i, writes) in cases.iter().enumerate() {
        let mut sink = FrameSink::default();
        for write in writes {
            sink.write(write);
        }
        assert_eq!(
            json!({"frames":sink.frames,"truncated":sink.truncated}),
            expected[i],
            "sink {i}"
        );
    }
    eprintln!("frozen frame sink differential cases={}", cases.len());
}

#[test]
fn collector_matches_frozen_oracle() {
    use serde_json::json;
    let mut cases = Vec::new();
    for capture_frames in [false, true] {
        for text in [
            "",
            "null",
            "42",
            "{\"x\":1}",
            "\"\\ud800\"",
            "data: x\r\n\r\ndata: y\n\n",
            "\u{feff}null",
        ] {
            cases.push(json!({"captureFrames":capture_frames,"client":"{\"original\":\"\\ud800\"}","response":"null","attempts":[
                {"provider":"anthropic","request":"{\"tools\":[\"cloaked\"]}","mode":"throw"},
                {"provider":"anthropic","request":"not json","mode":"text","text":text}
            ]}));
        }
        for bytes in [
            vec![],
            vec![0xef, 0xbb, 0xbf, b'a'],
            vec![0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf],
            vec![0xf0, 0x9f, 0x98, 0x80],
            vec![0xf0, 0x9f],
            vec![0xe0, 0x80, 0xaf],
            vec![0xed, 0xa0, 0x80],
            vec![0xff, b'a'],
            b"data: a\r\n\r\ndata: b\n\n".to_vec(),
        ] {
            for chunks in [
                vec![bytes.clone()],
                bytes.iter().map(|b| vec![*b]).collect(),
            ] {
                cases.push(json!({"captureFrames":capture_frames,"client":"null","response":"[]","attempts":[
                    {"provider":"openai","request":"","mode":"stream","chunks":chunks}
                ]}));
            }
        }
        for n in [524_287, 524_288, 524_289] {
            cases.push(json!({"captureFrames":capture_frames,"client":"true","response":"{}","attempts":[
                {"provider":"openai","request":format!("\"{}\"","a".repeat(n)),"mode":"text","text":"😀".repeat(n/2+1)}
            ]}));
            cases.push(json!({"captureFrames":capture_frames,"client":"null","response":"null","attempts":[
                {"provider":"openai","request":"{}","mode":"stream","chunks":[vec![b'x'; n],vec![b'y'; 8], vec![b'z';8]]}
            ]}));
        }
        cases.push(
            json!({"captureFrames":capture_frames,"client":"null","response":"null","attempts":[
                {"provider":"openai","request":"{}","mode":"stream","chunks":[],"fail":true}
            ]}),
        );
    }
    let expected: Vec<String> = serde_json::from_value(reference(&json!(cases))).unwrap();
    for (index, (case, want)) in cases.iter().zip(expected).enumerate() {
        let c = Collector::new(case["captureFrames"].as_bool().unwrap());
        c.request(parse_js(case["client"].as_str().unwrap()).unwrap());
        c.response(parse_js(case["response"].as_str().unwrap()).unwrap());
        for a in case["attempts"].as_array().unwrap() {
            let i = c.attempt(
                a["provider"].as_str().unwrap(),
                a["request"].as_str().unwrap(),
            );
            match a["mode"].as_str().unwrap() {
                "text" => c.text(i, a["text"].as_str().unwrap()),
                "stream" => {
                    for chunk in a["chunks"].as_array().unwrap() {
                        let bytes: Vec<u8> = chunk
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|b| u8::try_from(b.as_u64().unwrap()).unwrap())
                            .collect();
                        c.chunk(i, &bytes);
                    }
                    c.end(i, a["fail"].as_bool().unwrap_or(false));
                }
                "throw" => {}
                _ => panic!("bad fixture"),
            }
        }
        assert_eq!(
            stringify(&c.artifact("req_1", 123, None)).unwrap(),
            want,
            "case {index}"
        );
    }
    eprintln!("frozen collector differential cases={}", cases.len());
}
