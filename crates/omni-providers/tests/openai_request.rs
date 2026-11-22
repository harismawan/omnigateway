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
