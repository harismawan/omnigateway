#![allow(clippy::unwrap_used)]
use omni_providers::codec::{CodecInput, Credentials};
use omni_providers::openai::build_api_key_request;
#[test]
fn missing_token_is_auth() {
    let request = serde_json::from_str(r#"{"model":"m","stream":false,"messages":[]}"#).unwrap();
    let credentials = Credentials::default();
    let err = build_api_key_request(CodecInput {
        request: &request,
        model: "m",
        credentials: &credentials,
        request_id: None,
        auto_cache_enabled: None,
        max_output_tokens: None,
        request_started_at: None,
    })
    .expect_err("missing token");
    assert_eq!(err.code, omni_ir::error::ErrorCode::Auth);
    assert_eq!(err.message, "openai credential has no token");
}
#[test]
fn captured_literal_and_small_stack() {
    if std::env::var_os("OPENAI_DEPTH_CHILD").is_none() {
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "captured_literal_and_small_stack"])
            .env("OPENAI_DEPTH_CHILD", "1")
            .status()
            .unwrap();
        assert!(status.success());
        return;
    }
    std::thread::Builder::new().stack_size(2*1024*1024).spawn(|| {
        let mut request:omni_ir::request::ChatRequest=serde_json::from_str(r#"{"model":"pool","stream":false,"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}"#).unwrap();
        let credentials=Credentials{api_key:Some("sk-oa".into()),access_token:None,provider_data:Default::default()};
        let build=|request: &omni_ir::request::ChatRequest|build_api_key_request(CodecInput{request,model:"gpt-5-codex",credentials:&credentials,request_id:None,auto_cache_enabled:None,max_output_tokens:None,request_started_at:None}).unwrap();
        assert_eq!(build(&request).request.body,r#"{"model":"gpt-5-codex","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"store":false,"prompt_cache_key":"019b86b5-42c0-7505-b36d-80ccdd119119"}"#);
        let mut value=serde_json::Value::Null;
        for _ in 0..39990 {value=serde_json::Value::Array(vec![value]);}
        let mut bag=serde_json::Map::new();omni_ir::deep::insert(&mut bag,"input".into(),value);
        let mut vendor=serde_json::Map::new();omni_ir::deep::insert(&mut vendor,"openai".into(),serde_json::Value::Object(bag));
        request.vendor=Some(vendor);
        assert!(build(&request).request.body.len()>79000);
    }).unwrap().join().unwrap();
}
#[test]
fn api_key_codec_matches_frozen_ts() {
    let out = std::process::Command::new("bun")
        .arg("tests/openai-request-reference.ts")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    for (i, row) in rows.as_array().unwrap().iter().enumerate() {
        let request = if let Some(dialect) = row["dialect"].as_str() {
            use omni_dialects::ingress::{Headers, IngressOptions, Surface, ingest};
            let surface = match dialect {
                "anthropic" => Surface::Anthropic,
                "openai" => Surface::OpenAi,
                _ => Surface::Responses,
            };
            ingest(
                surface,
                &row["client"].to_string(),
                &Headers::new(),
                &mut IngressOptions {
                    new_tool_use_id: &mut || "fixed".into(),
                },
            )
            .unwrap()
            .request
        } else {
            serde_json::from_value(row["request"].clone()).unwrap()
        };
        let credentials = Credentials {
            api_key: Some("sk-oa".into()),
            access_token: None,
            provider_data: Default::default(),
        };
        let before = omni_ir::jsjson::to_string(&serde_json::to_value(&request).unwrap());
        let got = build_api_key_request(CodecInput {
            request: &request,
            model: row["model"].as_str().unwrap(),
            credentials: &credentials,
            request_id: None,
            auto_cache_enabled: None,
            max_output_tokens: None,
            request_started_at: None,
        })
        .unwrap();
        assert_eq!(
            before,
            omni_ir::jsjson::to_string(&serde_json::to_value(&request).unwrap()),
            "request mutated {i}"
        );
        assert_eq!(got.request.url, "https://api.openai.com/v1/responses");
        assert!(got.request.body_encoding.is_none());
        assert_eq!(
            got.request.body,
            row["codec"]["body"].as_str().unwrap(),
            "body {i}"
        );
        assert_eq!(
            serde_json::json!(got.request.headers),
            row["codec"]["headers"],
            "headers {i}"
        );
        assert_eq!(
            serde_json::json!(got.degradations),
            row["notes"],
            "notes {i}"
        );
        assert_eq!(
            got.decode_state,
            row["state"]["nativeReasoning"].as_bool().unwrap()
        );
    }
    eprintln!("{} codec comparisons", rows.as_array().unwrap().len());
}
