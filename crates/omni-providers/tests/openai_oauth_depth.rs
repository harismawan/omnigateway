//! OAuth vendor ownership boundaries, independently isolated per carrier.
use omni_ir::{
    deep,
    request::{ChatRequest, ContentBlock, ToolDef},
};
use omni_providers::{
    codec::{CodecInput, Credentials, ProviderCodec},
    openai::OpenAiCodec,
};
use serde_json::{Value, json};

fn exercise(case: &str) {
    let raw = if case == "tool_schema" {
        json!({"model":"m","stream":false,"messages":[],"tools":[{"kind":"portable","name":"f","inputSchema":null}]})
    } else if case.starts_with("native_") || case == "cache_fallback" {
        json!({"model":"m","stream":false,"messages":[{"role":"assistant","content":[{"type":"providerNative","provider":"openai","blockType":"reasoning","data":{}}]}]})
    } else {
        json!({"model":"m","stream":false,"messages":[],"vendor":{"openai":{}}})
    };
    let mut req: ChatRequest = serde_json::from_value(raw).expect("shallow fixture");
    let mut value = Value::Null;
    for _ in 0..39_990 {
        value = Value::Array(vec![value]);
    }
    if case == "tool_schema" {
        if let ToolDef::Portable(tool) = &mut req.tools.as_mut().expect("tools")[0] {
            deep::replace(&mut tool.input_schema, value);
        }
    } else if case.starts_with("native_") || case == "cache_fallback" {
        if let ContentBlock::ProviderNative(n) = &mut req.messages[0].content[0] {
            let field = match case {
                "native_metadata" => "internal_chat_message_metadata_passthrough",
                "native_message" => {
                    n.block_type = "message".into();
                    deep::insert(&mut n.data, "role".into(), json!("user"));
                    "content"
                }
                "native_call" => {
                    n.block_type = "function_call".into();
                    "arguments"
                }
                "native_output" => {
                    n.block_type = "function_call_output".into();
                    "output"
                }
                "native_unknown" => {
                    n.block_type = "future".into();
                    "payload"
                }
                _ => "payload",
            };
            deep::insert(&mut n.data, field.into(), value);
        }
        // Only the cache case uses the first-item fallback; other native cases
        // isolate lite handling from that earlier deep copy.
        if case != "cache_fallback" {
            req.conversation_id = Some("depth-conversation".into());
        }
    } else {
        let bag = req
            .vendor
            .as_mut()
            .expect("vendor")
            .get_mut("openai")
            .expect("bag")
            .as_object_mut()
            .expect("object");
        match case {
            "text_merge" | "reasoning_merge" => {
                let mut fields = serde_json::Map::new();
                deep::insert(&mut fields, "extension".into(), value);
                deep::insert(
                    bag,
                    case.trim_end_matches("_merge").into(),
                    Value::Object(fields),
                );
            }
            "scalar" => {
                deep::insert(bag, "reasoning".into(), value);
            }
            "metadata" => {
                deep::insert(bag, "client_metadata".into(), value);
            }
            "input_replace" => {
                deep::insert(bag, "input".into(), value);
            }
            "stream_replace" => {
                deep::insert(bag, "stream".into(), value);
            }
            _ => panic!("unknown carrier"),
        }
    }
    let credentials = Credentials {
        access_token: Some("token".into()),
        ..Default::default()
    };
    let built = OpenAiCodec
        .build_request(&CodecInput {
            request: &req,
            model: "gpt-6-astra",
            credentials: &credentials,
            request_id: Some("depth"),
            request_started_at: Some(1794000000123.0),
            auto_cache_enabled: None,
            max_output_tokens: None,
        })
        .expect("OAuth build");
    if matches!(
        case,
        "metadata" | "input_replace" | "stream_replace" | "native_metadata"
    ) {
        assert!(built.request.body.len() < 4000);
    } else {
        assert!(built.request.body.len() > 79_000);
    }
    drop(built);
    drop(req);
}

#[test]
fn vendor_carriers_on_small_stack() {
    if let Ok(case) = std::env::var("OPENAI_OAUTH_CARRIER") {
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(move || exercise(&case))
            .expect("thread")
            .join()
            .expect("join");
        return;
    }
    for case in [
        "text_merge",
        "reasoning_merge",
        "scalar",
        "metadata",
        "input_replace",
        "stream_replace",
        "tool_schema",
        "native_reasoning",
        "native_metadata",
        "native_message",
        "native_call",
        "native_output",
        "native_unknown",
        "cache_fallback",
    ] {
        let output = std::process::Command::new(std::env::current_exe().expect("exe"))
            .arg("--exact")
            .arg("vendor_carriers_on_small_stack")
            .arg("--nocapture")
            .env("OPENAI_OAUTH_CARRIER", case)
            .output()
            .expect("child");
        assert!(
            output.status.success(),
            "{case}: {:?}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
        eprintln!("{case}: passed (39990 levels, 2 MiB)");
    }
}
