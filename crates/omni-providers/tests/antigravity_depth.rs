use omni_ir::{deep, request::ChatRequest};
use omni_providers::{
    antigravity::codec::AntigravityCodec,
    codec::{CodecInput, Credentials},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn body(kind: &str, depth: usize) -> String {
    let nested = "null";
    let text = match kind {
        "input" => format!(
            r#"{{"model":"m","stream":true,"messages":[{{"role":"assistant","content":[{{"type":"toolUse","id":"i","name":"tool","input":{nested}}}]}}]}}"#
        ),
        "vendor" => format!(
            r#"{{"model":"m","stream":true,"messages":[],"vendor":{{"antigravity":{{"extra":{nested}}}}}}}"#
        ),
        "schema" => format!(
            r#"{{"model":"m","stream":true,"messages":[],"vendor":{{"openai":{{"response_format":{{"type":"json_schema","json_schema":{{"schema":{nested}}}}}}}}}}}"#
        ),
        "tool" => format!(
            r#"{{"model":"m","stream":true,"messages":[],"tools":[{{"kind":"portable","name":"tool","inputSchema":{nested}}}]}}"#
        ),
        _ => unreachable!(),
    };
    let mut request: ChatRequest = serde_json::from_str(&text).expect("depth fixture");
    let mut nested = Value::Null;
    for _ in 0..depth {
        let mut m = serde_json::Map::new();
        deep::insert(&mut m, "items".into(), nested);
        nested = Value::Object(m);
    }
    match kind {
        "input" => {
            if let omni_ir::request::ContentBlock::ToolUse(t) = &mut request.messages[0].content[0]
            {
                t.input = nested;
            }
        }
        "vendor" => {
            request
                .vendor
                .as_mut()
                .expect("vendor")
                .get_mut("antigravity")
                .expect("antigravity")["extra"] = nested
        }
        "schema" => {
            request
                .vendor
                .as_mut()
                .expect("vendor")
                .get_mut("openai")
                .expect("openai")["response_format"]["json_schema"]["schema"] = nested
        }
        "tool" => {
            if let omni_ir::request::ToolDef::Portable(t) =
                &mut request.tools.as_mut().expect("tools")[0]
            {
                t.input_schema = nested;
            }
        }
        _ => unreachable!(),
    }
    let credentials = Credentials {
        access_token: Some("token".into()),
        api_key: None,
        provider_data: json!({"projectId":"p"})
            .as_object()
            .expect("object")
            .clone(),
    };
    AntigravityCodec
        .build_request(&CodecInput {
            request: &request,
            model: "m",
            credentials: &credentials,
            request_id: Some("r"),
            auto_cache_enabled: None,
            max_output_tokens: None,
            request_started_at: None,
        })
        .expect("build request")
        .request
        .body
}

fn compare(kind: &'static str) {
    let out = std::process::Command::new("bun")
        .args(["--no-env-file", "tests/antigravity_depth-reference.ts"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let rows: Value = serde_json::from_slice(&out.stdout).expect("oracle JSON");
    let row = rows
        .as_array()
        .expect("rows")
        .iter()
        .find(|r| r["kind"] == kind)
        .expect("row")
        .clone();
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(move || {
            let body = body(kind, 39_990);
            assert_eq!(json!(body.len()), row["length"], "{kind}");
            assert_eq!(
                format!("{:x}", Sha256::digest(body.as_bytes())),
                row["sha256"],
                "{kind}"
            );
        })
        .expect("spawn")
        .join()
        .expect("join");
}

#[test]
fn input_depth_matches_frozen() {
    compare("input");
}
#[test]
fn vendor_depth_matches_frozen() {
    compare("vendor");
}
#[test]
fn response_schema_depth_matches_frozen() {
    compare("schema");
}
#[test]
fn tool_schema_depth_matches_frozen() {
    compare("tool");
}
#[test]
fn input_engine_threshold_band() {
    // Documented difference: Rust stack growth is not JSC's stringify stack limit.
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(|| {
            assert!(body("input", 39_996).len() > 390_000);
        })
        .expect("spawn")
        .join()
        .expect("join");
}

#[test]
fn shallow_builds_do_not_grow_stack() {
    std::thread::Builder::new()
        .stack_size(2 * 1024 * 1024)
        .spawn(|| {
            let before = deep::grows();
            for _ in 0..1000 {
                std::hint::black_box(body("input", 0));
            }
            assert_eq!(deep::grows(), before);
        })
        .expect("fixture")
        .join()
        .expect("fixture");
}

#[test]
fn opaque_positions_on_small_stack() {
    for position in [
        "options",
        "native",
        "system_native",
        "result_native",
        "provider_tool",
        "headers",
        "citations",
        "schema_free",
        "response_free",
    ] {
        std::thread::Builder::new()
            .stack_size(2 * 1024 * 1024)
            .spawn(move || {
                use omni_ir::request::*;
                let mut request: ChatRequest = serde_json::from_value(
                    json!({"model":"m","stream":true,"messages":[],"tools":[]}),
                )
                .expect("fixture");
                let mut nested = Value::Null;
                for _ in 0..39_990 {
                    nested = Value::Array(vec![nested]);
                }
                let mut map = serde_json::Map::new();
                deep::insert(&mut map, "x".into(), nested);
                let native = |data| ProviderNativeBlock {
                    provider: "p".into(),
                    block_type: "x".into(),
                    data,
                    cache_control: None,
                };
                let block = match position {
                    "native" | "system_native" => Some(ContentBlock::ProviderNative(native(map))),
                    "result_native" => Some(ContentBlock::ToolResult(ToolResultBlock {
                        tool_use_id: "i".into(),
                        content: "".into(),
                        images: None,
                        files: None,
                        native: Some(vec![native(map)]),
                        is_error: None,
                        cache_control: None,
                    })),
                    "citations" => Some(ContentBlock::Text(TextBlock {
                        text: "".into(),
                        cache_control: None,
                        citations: Some(vec![Value::Object(map)]),
                    })),
                    "options" | "schema_free" => {
                        let mut schema = serde_json::Map::new();
                        if position == "schema_free" {
                            deep::insert(
                                &mut schema,
                                "default".into(),
                                Value::Object(deep::clone_map(&map)),
                            );
                        }
                        request
                            .tools
                            .as_mut()
                            .expect("fixture")
                            .push(ToolDef::Portable(CustomToolDef {
                                name: "n".into(),
                                description: None,
                                input_schema: Value::Object(schema),
                                cache_control: None,
                                options: Some(map),
                            }));
                        None
                    }
                    "provider_tool" => {
                        request
                            .tools
                            .as_mut()
                            .expect("fixture")
                            .push(ToolDef::Provider(ProviderToolDef {
                                provider: "p".into(),
                                tool_type: "x".into(),
                                name: "n".into(),
                                wire: map,
                                cache_control: None,
                                family: None,
                            }));
                        None
                    }
                    "headers" => {
                        request.provider_headers = Some(map);
                        None
                    }
                    "response_free" => {
                        let mut value = Value::Object(map);
                        for key in ["default", "schema", "json_schema"] {
                            let mut m = serde_json::Map::new();
                            deep::insert(&mut m, key.into(), value);
                            value = Value::Object(m);
                        }
                        deep::insert(
                            value.as_object_mut().expect("fixture"),
                            "type".into(),
                            json!("json_schema"),
                        );
                        for key in ["response_format", "openai"] {
                            let mut m = serde_json::Map::new();
                            deep::insert(&mut m, key.into(), value);
                            value = Value::Object(m);
                        }
                        if let Value::Object(m) = value {
                            request.vendor = Some(m);
                        }
                        None
                    }
                    _ => unreachable!(),
                };
                if let Some(block) = block {
                    if position == "system_native" {
                        request.system = Some(vec![block]);
                    } else {
                        request.messages.push(Message {
                            role: Role::User,
                            content: vec![block],
                        });
                    }
                }
                let credentials = Credentials {
                    access_token: Some("t".into()),
                    api_key: None,
                    provider_data: json!({"projectId":"p"})
                        .as_object()
                        .expect("fixture")
                        .clone(),
                };
                let result = AntigravityCodec
                    .build_request(&CodecInput {
                        request: &request,
                        model: "m",
                        credentials: &credentials,
                        request_id: Some("r"),
                        auto_cache_enabled: None,
                        max_output_tokens: None,
                        request_started_at: None,
                    })
                    .expect("fixture");
                drop(result);
                drop(request);
                drop(credentials);
            })
            .expect("fixture")
            .join()
            .expect("fixture");
    }
}
