use std::collections::VecDeque;

#[test]
fn request_cloak_round_trip() {
    use omni_providers::codec::{CodecInput, Credentials, ProviderCodec};
    let request=serde_json::from_value(serde_json::json!({"model":"test","stream":true,"messages":[],"tools":[{"kind":"portable","name":"original / tool","description":"test","inputSchema":{"type":"object"}}]})).expect("request");
    let mut credentials = Credentials::default();
    credentials.access_token = Some("token".into());
    credentials
        .provider_data
        .insert("projectId".into(), serde_json::json!("project"));
    let input = CodecInput {
        request: &request,
        model: "test",
        credentials: &credentials,
        request_id: None,
        auto_cache_enabled: None,
        max_output_tokens: None,
        request_started_at: None,
    };
    let codec = omni_providers::antigravity::codec::AntigravityCodec;
    let built = ProviderCodec::build_request(&codec, &input).expect("build request");
    let wire = built.decode_state.cloak.name("original / tool").to_owned();
    assert_ne!(wire, "original / tool");
    assert!(built.request.body.contains(&wire));
    let mut decoder = codec.decoder(built.decode_state, &Default::default());
    let mut out = VecDeque::new();
    decoder.message(&omni_providers::sse::SseMessage{event:"message".into(),data:serde_json::json!({"response":{"candidates":[{"content":{"parts":[{"functionCall":{"name":wire}}]},"finishReason":"STOP"}]}}).to_string()},&mut out).expect("decode");
    assert!(out.iter().any(|e|matches!(e,omni_ir::stream::StreamEvent::BlockStart{block:omni_ir::stream::ContentBlockStart::ToolUse{name,..},..} if name=="original / tool")));
}
