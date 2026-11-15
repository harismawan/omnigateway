fn nested() -> serde_json::Value {
    let mut value = serde_json::Value::Null;
    for _ in 0..40000 {
        let mut m = serde_json::Map::new();
        omni_ir::deep::insert(&mut m, "items".into(), value);
        value = serde_json::Value::Object(m);
    }
    value
}

#[test]
fn response_schema_depth_matches_frozen() {
    let out = std::process::Command::new("bun")
        .args(["--no-env-file", "tests/antigravity_depth-reference.ts"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(out.status.success());
    let rows: serde_json::Value = serde_json::from_slice(&out.stdout).expect("oracle");
    assert_eq!(
        rows[0]["error"],
        "RangeError: Maximum call stack size exceeded."
    );
    assert_eq!(
        rows[2]["error"],
        "RangeError: Maximum call stack size exceeded."
    );
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(move || {
            let mut request: omni_ir::request::ChatRequest =
                serde_json::from_str(r#"{"model":"m","stream":true,"messages":[]}"#)
                    .expect("request");
            let mut value = nested();
            for key in ["schema", "json_schema", "response_format", "openai"] {
                let mut m = serde_json::Map::new();
                if key == "json_schema" {
                    omni_ir::deep::insert(&mut m, "type".into(), serde_json::json!("json_schema"));
                }
                omni_ir::deep::insert(&mut m, key.into(), value);
                value = serde_json::Value::Object(m);
            }
            request.vendor = value.as_object_mut().map(std::mem::take);
            let cloak = omni_providers::antigravity::cloak::ToolCloak::build(&request);
            let (body, notes) =
                omni_providers::antigravity::wire::to_wire(&request, "m", "p", "r", &cloak);
            assert_eq!(
                omni_ir::jsjson::to_string(&body),
                rows[1]["body"].as_str().expect("body")
            );
            assert_eq!(serde_json::json!(notes), rows[1]["notes"]);
            omni_ir::deep::drop(body);
        })
        .expect("spawn")
        .join()
        .expect("thread");
}

#[test]
#[ignore = "Unresolved depth parity: frozen JSON.stringify throws RangeError; Rust serialization overflows 2 MiB stack"]
fn retained_red_deep_tool_input_serialization() {
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(|| {
            let mut request: omni_ir::request::ChatRequest =
                serde_json::from_str(r#"{"model":"m","stream":true,"messages":[]}"#)
                    .expect("request");
            request.messages.push(omni_ir::request::Message {
                role: omni_ir::request::Role::Assistant,
                content: vec![omni_ir::request::ContentBlock::ToolUse(
                    omni_ir::request::ToolUseBlock {
                        id: "i".into(),
                        name: "tool".into(),
                        input: nested(),
                        cache_control: None,
                    },
                )],
            });
            let cloak = omni_providers::antigravity::cloak::ToolCloak::build(&request);
            let (body, _) =
                omni_providers::antigravity::wire::to_wire(&request, "m", "p", "r", &cloak);
            let serialized = omni_ir::jsjson::to_string(&body);
            omni_ir::deep::drop(body);
            panic!(
                "expected frozen RangeError, received {} bytes",
                serialized.len()
            );
        })
        .expect("spawn")
        .join()
        .expect("thread");
}
