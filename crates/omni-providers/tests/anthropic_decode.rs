use omni_providers::{
    anthropic::decode::AnthropicDecoder,
    codec::{Flow, StreamDecoder},
    sse::SseMessage,
};
use std::collections::VecDeque;

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
