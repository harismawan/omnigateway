use omni_providers::{
    anthropic::decode::AnthropicDecoder,
    codec::{Flow, StreamDecoder},
    sse::SseMessage,
};
use std::collections::VecDeque;

#[test]
fn retained_safeguards_depth_subprocess() {
    if std::env::var_os("OMNI_SAFEGUARDS_CHILD").is_some() {
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(|| {
                let mut decoder = AnthropicDecoder::default();
                let mut out = VecDeque::new();
                let nested = format!("{}0{}", "[".repeat(39995), "]".repeat(39995));
                for payload in [nested.clone(), nested, "null".into()] {
                    decoder
                        .message(
                            &SseMessage {
                                event: "message_delta".into(),
                                data: format!("{{\"safeguard_results\":{payload}}}"),
                            },
                            &mut out,
                        )
                        .expect("decode");
                }
                drop(decoder);
                // A cancellation before message_stop drops a retained deep verdict.
                let mut decoder = AnthropicDecoder::default();
                decoder
                    .message(
                        &SseMessage {
                            event: "message_delta".into(),
                            data: format!(
                                "{{\"safeguard_results\":{}0{}}}",
                                "[".repeat(39995),
                                "]".repeat(39995)
                            ),
                        },
                        &mut out,
                    )
                    .expect("decode");
                drop(decoder);
            })
            .expect("thread")
            .join()
            .expect("worker");
        return;
    }
    let run = std::process::Command::new(std::env::current_exe().expect("exe"))
        .args([
            "--exact",
            "retained_safeguards_depth_subprocess",
            "--nocapture",
        ])
        .env("OMNI_SAFEGUARDS_CHILD", "1")
        .output()
        .expect("subprocess");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
}

#[test]
fn deep_valid_events_are_not_silently_discarded() {
    let mut decoder = AnthropicDecoder::default();
    let mut out = VecDeque::new();
    let msg = SseMessage {
        event: "content_block_start".into(),
        data: format!(
            r#"{{"content_block":{{"type":"document","data":{}0{}}}}}"#,
            "[".repeat(140),
            "]".repeat(140)
        ),
    };
    decoder.message(&msg, &mut out).expect("valid JSON");
    assert_eq!(out.len(), 1);
    let msg = SseMessage {
        event: "ping".into(),
        data: format!("{}0{}", "[".repeat(40001), "]".repeat(40001)),
    };
    assert!(
        decoder.message(&msg, &mut out).is_err(),
        "depth policy must be explicit"
    );
}

#[test]
fn frozen_ts_decoder_generated_corpus() {
    let run = std::process::Command::new("bun")
        .arg("tests/anthropic-decode-reference.ts")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("Bun");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&run.stdout).expect("corpus");
    for (i, row) in rows.as_array().expect("rows").iter().enumerate() {
        let mut decoder = AnthropicDecoder::default();
        let mut out = VecDeque::new();
        let mut stopped = false;
        for msg in row["messages"].as_array().expect("messages") {
            let msg = SseMessage {
                event: msg["event"].as_str().expect("event").into(),
                data: msg["data"].as_str().expect("data").into(),
            };
            if decoder.message(&msg, &mut out).expect("decode") == Flow::Stop {
                stopped = true;
                break;
            }
        }
        if !stopped {
            decoder.finish(&mut out);
        }
        let actual: Vec<serde_json::Value> = out
            .iter()
            .map(|e| serde_json::from_str(&e.to_json()).expect("event JSON"))
            .collect();
        assert_eq!(
            serde_json::Value::Array(actual),
            row["events"],
            "case {i}: {}",
            row["messages"]
        );
    }
}
