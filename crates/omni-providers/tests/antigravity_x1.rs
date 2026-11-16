fn compare(label: &str) {
    let out = std::process::Command::new("bun")
        .args(["--no-env-file", "tests/antigravity_x1-reference.ts"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("fixture");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&out.stdout).expect("fixture");
    let row = rows
        .as_array()
        .expect("fixture")
        .iter()
        .find(|r| r["label"] == label)
        .expect("fixture");
    // The oracle envelope escapes the raw input so Rust never normalizes it.
    let input: serde_json::Value = serde_json::from_str(row["input"].as_str().expect("fixture"))
        .expect("X1: raw request must remain representable (UTF-16 / out-of-double-range number)");
    let request = serde_json::from_value(input["request"].clone()).expect("fixture");
    let credentials = omni_providers::codec::Credentials {
        access_token: Some("t".into()),
        api_key: None,
        provider_data: serde_json::json!({"projectId":input["project"]})
            .as_object()
            .expect("fixture")
            .clone(),
    };
    let result = omni_providers::antigravity::codec::AntigravityCodec
        .build_request(&omni_providers::codec::CodecInput {
            request: &request,
            model: "m",
            credentials: &credentials,
            request_id: input["requestId"].as_str(),
            auto_cache_enabled: None,
            max_output_tokens: None,
            request_started_at: None,
        })
        .expect("fixture");
    assert_eq!(
        result.request.body,
        row["expected"].as_str().expect("fixture"),
        "X1: frozen request bytes"
    );
}
macro_rules! retained {
    ($name:ident, $label:literal) => {
        #[test]
        #[ignore = "X1: shared JSON/IR representation gap; paired frozen expectation"]
        fn $name() {
            compare($label);
        }
    };
}
// Minimal vendor: {"vendor":{"antigravity":"🙂"}}; frozen keys 0/1 hold \ud83d/\ude42.
retained!(x1_vendor_non_bmp, "vendor");
// Minimal tool name: {"name":"\ud800","inputSchema":{}}; frozen hashes its UTF-8 replacement.
retained!(x1_tool_name, "name");
// Minimal toolUse: {"id":"\ud800","name":"t","input":{}}; frozen accepts the id.
retained!(x1_tool_id, "id");
// Minimal toolUse.input: {"x":"\ud800"}; frozen serializes the escaped surrogate.
retained!(x1_opaque_value, "value");
// Minimal toolUse.input: {"\ud800":1}; frozen serializes the escaped key.
retained!(x1_opaque_key, "key");
// Minimal system text: "\ud800"; frozen serializes the escaped surrogate.
retained!(x1_system, "system");
// Minimal projectId: "\ud800", absent requestId; frozen hashes replacement UTF-8 and escapes body.
retained!(x1_project_hash_and_body, "project");
// Minimal requestId: "\ud800"; frozen escapes body.
retained!(x1_request_id_body, "request_id");
// Raw 1e309 becomes Infinity in frozen, then args:null on serialization.
retained!(x1_overflow_input, "overflow_input");
// The same raw token in a nested opaque input becomes args:{"x":null}.
retained!(x1_overflow_nested_input, "overflow_nested_input");
// Schema free fields retain Infinity until serialization emits default:null.
retained!(x1_overflow_schema_default, "overflow_schema_default");
