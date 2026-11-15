//! Each fixture is assembled shallow first, then receives an iterative deep
//! payload. Fixture deserialization must not be the operation under test.
use omni_ir::{
    deep,
    request::{ChatRequest, ContentBlock, ToolDef},
};
use omni_providers::{
    codec::{CodecInput, Credentials},
    openai::build_api_key_request,
};
use serde_json::{Value, json};

fn nested() -> Value {
    let mut value = Value::Null;
    for _ in 0..39_990 {
        value = Value::Array(vec![value]);
    }
    value
}

fn exercise(case: &str) {
    let raw = match case {
        "tool_input" => {
            json!({"model":"m","stream":false,"messages":[{"role":"assistant","content":[{"type":"toolUse","id":"c","name":"f","input":null}]}]})
        }
        "tool_schema" => {
            json!({"model":"m","stream":false,"messages":[],"tools":[{"kind":"portable","name":"f","inputSchema":null}]})
        }
        "native" | "native_drop" => {
            json!({"model":"m","stream":false,"messages":[{"role":"assistant","content":[{"type":"providerNative","provider":if case=="native" {"openai"} else {"anthropic"},"blockType":"reasoning","data":{}}]}]})
        }
        _ => json!({"model":"m","stream":false,"messages":[],"vendor":{"openai":{}}}),
    };
    let mut req: ChatRequest = serde_json::from_value(raw).expect("shallow fixture");
    let value = nested();
    match case {
        "tool_input" => {
            if let ContentBlock::ToolUse(t) = &mut req.messages[0].content[0] {
                deep::replace(&mut t.input, value);
            }
        }
        "tool_schema" => {
            if let ToolDef::Portable(t) = &mut req.tools.as_mut().expect("tools")[0] {
                deep::replace(&mut t.input_schema, value);
            }
        }
        "native" | "native_drop" => {
            if let ContentBlock::ProviderNative(n) = &mut req.messages[0].content[0] {
                deep::insert(&mut n.data, "payload".into(), value);
            }
        }
        _ => {
            let bag = req
                .vendor
                .as_mut()
                .expect("vendor")
                .get_mut("openai")
                .expect("bag")
                .as_object_mut()
                .expect("object");
            match case {
                "vendor" => {
                    deep::insert(bag, "extension".into(), value);
                }
                "vendor_replace" => {
                    deep::insert(bag, "stream".into(), value);
                }
                "format_drop" => {
                    deep::insert(bag, "text".into(), value);
                }
                "format_schema" => {
                    // Arbitrary data under a shallow schema, not 40k schema
                    // steps (which TS's separate schema-depth policy rejects).
                    let mut schema = serde_json::Map::new();
                    deep::insert(&mut schema, "default".into(), value);
                    let mut spec = serde_json::Map::new();
                    deep::insert(&mut spec, "schema".into(), Value::Object(schema));
                    let mut format = serde_json::Map::new();
                    deep::insert(&mut format, "type".into(), json!("json_schema"));
                    deep::insert(&mut format, "json_schema".into(), Value::Object(spec));
                    deep::insert(bag, "response_format".into(), Value::Object(format));
                }
                _ => panic!("unknown case"),
            }
        }
    }
    let credentials = Credentials {
        api_key: Some("key".into()),
        access_token: None,
        provider_data: Default::default(),
    };
    let result = build_api_key_request(CodecInput {
        request: &req,
        model: "m",
        credentials: &credentials,
        request_id: None,
        auto_cache_enabled: None,
        max_output_tokens: None,
        request_started_at: None,
    })
    .expect("build");
    if matches!(case, "vendor_replace" | "format_drop" | "native_drop") {
        assert!(result.request.body.len() < 1000);
    } else {
        assert!(result.request.body.len() > 79_000);
    }
    drop(result);
    drop(req);
}

#[test]
fn carriers_on_small_stack() {
    if let Ok(case) = std::env::var("OPENAI_CARRIER") {
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(move || exercise(&case))
            .expect("thread")
            .join()
            .expect("join");
        return;
    }
    for case in [
        "vendor",
        "vendor_replace",
        "tool_input",
        "tool_schema",
        "native",
        "native_drop",
        "format_schema",
        "format_drop",
    ] {
        let output = std::process::Command::new(std::env::current_exe().expect("exe"))
            .args(["--exact", "carriers_on_small_stack", "--nocapture"])
            .env("OPENAI_CARRIER", case)
            .output()
            .expect("child");
        assert!(
            output.status.success(),
            "{case}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        eprintln!("{case}: passed (39990 levels, 2 MiB)");
    }
}
