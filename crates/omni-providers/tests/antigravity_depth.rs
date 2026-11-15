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
