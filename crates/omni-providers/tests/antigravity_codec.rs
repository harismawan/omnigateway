#[test]
fn matches_app_headers_and_envelope_order_but_keeps_gateway_request_id() {
    use omni_providers::codec::{CodecInput, Credentials};
    let raw = include_str!("fixtures/antigravity-2.34.0.json");
    let fixture: serde_json::Value = serde_json::from_str(raw).expect("capture");
    let request =
        serde_json::from_str(r#"{"model":"gemini-pro-agent","messages":[],"stream":true}"#)
            .expect("canonical request");
    let mut credentials = Credentials {
        access_token: Some("at-1".into()),
        api_key: None,
        provider_data: Default::default(),
    };
    omni_ir::deep::insert(
        &mut credentials.provider_data,
        "projectId".into(),
        "p".into(),
    );
    let built = omni_providers::antigravity::codec::AntigravityCodec
        .build_request(&CodecInput {
            request: &request,
            model: "gemini-pro-agent",
            credentials: &credentials,
            request_id: Some("id"),
            auto_cache_enabled: None,
            max_output_tokens: None,
            request_started_at: None,
        })
        .expect("build")
        .request;
    let mut headers: Vec<(String, String)> =
        serde_json::from_value(fixture["headers"].clone()).expect("headers");
    headers.retain(|(name, _)| name != "Accept-Encoding");
    for (name, value) in &mut headers {
        if name == "Authorization" {
            *value = "Bearer at-1".into();
        }
    }
    assert_eq!(built.headers, headers);
    assert_eq!(
        built.body,
        r#"{"project":"p","requestId":"agent/id","request":{"contents":[]},"model":"gemini-pro-agent","userAgent":"antigravity","requestType":"agent"}"#
    );
}
