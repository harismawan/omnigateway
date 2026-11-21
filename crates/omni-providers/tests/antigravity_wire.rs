#[test]
fn x1_lone_surrogate_text_retained_red() {
    let input = r#"{"model":"m","stream":true,"messages":[{"role":"user","content":[{"type":"text","text":"\ud800"}]}]}"#;
    let request = omni_ir::request::CanonicalRequest::parse(input).expect("canonical request");
    let built = omni_providers::antigravity::codec::AntigravityCodec
        .build_canonical(&request, "m", "t", &"p".into(), Some(&"r".into()))
        .expect("wire");
    assert!(built.request.body.contains(r#""text":"\ud800""#));
}
