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
    let raw = if case == "ignored_provider_tool" {
        json!({"model":"m","stream":false,"messages":[],"tools":[{"kind":"provider","provider":"openai","type":"future","name":"f","wire":{}}]})
    } else if case == "ordinary_input" {
        json!({"model":"m","stream":false,"messages":[{"role":"assistant","content":[{"type":"toolUse","id":"call","name":"f","input":null}]}]})
    } else if case.starts_with("ordinary_result") {
        json!({"model":"m","stream":false,"messages":[{"role":"user","content":[{"type":"toolResult","toolUseId":"call","content":"result","native":[{"provider":"anthropic","blockType":"future","data":{}}]}]}]})
    } else if case == "tool_schema" || case == "nonlite_schema" {
        json!({"model":"m","stream":false,"messages":[],"tools":[{"kind":"portable","name":"f","inputSchema":null}]})
    } else if case.starts_with("native_")
        || case == "cache_fallback"
        || case.starts_with("ignored_")
    {
        json!({"model":"m","stream":false,"messages":[{"role":"assistant","content":[{"type":"providerNative","provider":"openai","blockType":"reasoning","data":{}}]}]})
    } else {
        json!({"model":"m","stream":false,"messages":[],"vendor":{"openai":{}}})
    };
    let mut req: ChatRequest = serde_json::from_value(raw).expect("shallow fixture");
    let mut value = Value::Null;
    for _ in 0..39_990 {
        value = Value::Array(vec![value]);
    }
    let mut credentials = Credentials {
        access_token: Some("token".into()),
        api_key: None,
        provider_data: Default::default(),
    };
    if let Some(field) = case.strip_prefix("credential_") {
        deep::insert(&mut credentials.provider_data, field.into(), value);
    } else if case == "ignored_provider_tool" {
        if let ToolDef::Provider(tool) = &mut req.tools.as_mut().expect("tools")[0] {
            deep::insert(&mut tool.wire, "payload".into(), value);
        }
    } else if case == "ignored_foreign" || case == "ignored_system" {
        if let ContentBlock::ProviderNative(n) = &mut req.messages[0].content[0] {
            n.provider = "anthropic".into();
            deep::insert(&mut n.data, "payload".into(), value);
        }
        if case == "ignored_system" {
            req.system = Some(std::mem::take(&mut req.messages[0].content));
        }
    } else if case.starts_with("ordinary_result") {
        if let ContentBlock::ToolResult(result) = &mut req.messages[0].content[0] {
            if case == "ordinary_result_native" {
                deep::insert(
                    &mut result.native.as_mut().expect("native")[0].data,
                    "payload".into(),
                    value,
                );
            } else {
                // Portable result text/media have no arbitrary JSON field. Carry
                // the same nested JSON as text, plus a deep ignored native owner.
                result.content = format!("{}null{}", "[".repeat(39_990), "]".repeat(39_990));
                deep::insert(
                    &mut result.native.as_mut().expect("native")[0].data,
                    "payload".into(),
                    value,
                );
                if case == "ordinary_result_media" {
                    result.images = Some(
                        serde_json::from_value(
                            json!([{"mediaType":"image/png","data":"aGVsbG8="}]),
                        )
                        .expect("images"),
                    );
                    result.files = Some(serde_json::from_value(json!([{"mediaType":"application/pdf","data":"aGVsbG8=","filename":"a.pdf"}])).expect("files"));
                }
            }
        }
        req.conversation_id = Some("depth-conversation".into());
    } else if case == "ordinary_input" {
        if let ContentBlock::ToolUse(tool) = &mut req.messages[0].content[0] {
            deep::replace(&mut tool.input, value);
        }
        req.conversation_id = Some("depth-conversation".into());
    } else if case == "tool_schema" || case == "nonlite_schema" {
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
                "native_name" => {
                    n.block_type = "function_call".into();
                    "name"
                }
                "native_call_id" => {
                    n.block_type = "function_call".into();
                    "call_id"
                }
                "native_output_id" => {
                    n.block_type = "function_call_output".into();
                    "call_id"
                }
                "native_annotations" => {
                    n.block_type = "message".into();
                    deep::insert(&mut n.data, "role".into(), json!("assistant"));
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
            if case == "native_annotations" {
                let mut part = json!({"type":"output_text","text":"answer"});
                deep::insert(
                    part.as_object_mut().expect("part"),
                    "annotations".into(),
                    value,
                );
                deep::insert(&mut n.data, field.into(), Value::Array(vec![part]));
            } else {
                deep::insert(&mut n.data, field.into(), value);
            }
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
            "format_schema" => {
                let mut schema = json!({"type":"object"});
                deep::insert(
                    schema.as_object_mut().expect("schema"),
                    "default".into(),
                    value,
                );
                let mut spec = json!({"name":"depth"});
                deep::insert(spec.as_object_mut().expect("spec"), "schema".into(), schema);
                let mut format = json!({"type":"json_schema"});
                deep::insert(
                    format.as_object_mut().expect("format"),
                    "json_schema".into(),
                    spec,
                );
                deep::insert(bag, "response_format".into(), format);
            }
            "format_replace" => {
                let mut text = json!({});
                deep::insert(text.as_object_mut().expect("text"), "format".into(), value);
                deep::insert(bag, "text".into(), text);
                deep::insert(bag, "response_format".into(), json!({"type":"json_object"}));
            }
            "format_text_drop" => {
                deep::insert(bag, "text".into(), value);
            }
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
    if case == "nonlite_schema" {
        credentials.access_token = None;
        credentials.api_key = Some("key".into());
    }
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
        "metadata"
            | "input_replace"
            | "stream_replace"
            | "native_metadata"
            | "ordinary_result_native"
            | "format_replace"
            | "format_text_drop"
            | "native_annotations"
            | "ignored_foreign"
            | "ignored_system"
            | "ignored_provider_tool"
            | "credential_accountId"
            | "credential_installationId"
            | "credential_idSalt"
            | "credential_extension"
    ) {
        assert!(built.request.body.len() < 4000);
    } else {
        assert!(built.request.body.len() > 79_000);
    }
    drop(built);
    drop(req);
    if case.starts_with("credential_") {
        drop(credentials.clone());
    }
    drop(credentials);
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
        "nonlite_schema",
        "ordinary_input",
        "ordinary_result_native",
        "ordinary_result_string",
        "ordinary_result_media",
        "format_schema",
        "format_replace",
        "format_text_drop",
        "native_annotations",
        "native_name",
        "native_call_id",
        "native_output_id",
        "ignored_foreign",
        "ignored_system",
        "ignored_provider_tool",
        "credential_accountId",
        "credential_installationId",
        "credential_idSalt",
        "credential_extension",
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
