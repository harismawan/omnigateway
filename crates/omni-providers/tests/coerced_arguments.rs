use omni_ir::stream::{Delta, StreamEvent};
use omni_providers::{codec::StreamDecoder, custom::decode::ResponsesDecoder, sse::SseMessage};
use serde_json::json;
use std::collections::VecDeque;

#[test]
fn responses_coerced_arguments_match_scanned_text() {
    let oracle = std::process::Command::new("bun")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../conformance/coerced-tool-oracle.ts"
        ))
        .output()
        .expect("mandatory real TS oracle");
    assert!(
        oracle.status.success(),
        "{}",
        String::from_utf8_lossy(&oracle.stderr)
    );
    for string in [false, true] {
        let deltas = if string {
            vec![json!(["\""]), json!("[".repeat(40001)), json!("\"")]
        } else {
            vec![
                json!(["[".repeat(40001)]),
                json!("0"),
                json!(["]".repeat(40001)]),
            ]
        };
        let mut decoder = ResponsesDecoder::new();
        let mut emitted = String::new();
        for delta in deltas {
            let mut out = VecDeque::new();
            let result = decoder.message(
                &SseMessage {
                    event: "response.function_call_arguments.delta".into(),
                    data: json!({"output_index":0,"delta":delta}).to_string(),
                },
                &mut out,
            );
            if !string {
                assert!(
                    result.is_err(),
                    "coerced overflow must fail before emission"
                );
                assert!(out.is_empty());
                break;
            }
            result.expect("valid JSON string");
            for e in out {
                if let StreamEvent::BlockDelta {
                    delta: Delta::ToolJson { partial },
                    ..
                } = e
                {
                    emitted.push_str(&partial);
                }
            }
        }
        if string {
            assert_eq!(
                serde_json::from_str::<String>(&emitted).unwrap(),
                "[".repeat(40001)
            );
        }
    }
}
