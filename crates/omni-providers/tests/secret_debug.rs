use omni_providers::{
    anthropic::oauth::refresh_request,
    codec::{CodecHttpRequest, Credentials},
    http::{Headers, HttpRequest, HttpResponse, ResponseBody},
};
fn redacted(value: &impl std::fmt::Debug) {
    for text in [format!("{value:?}"), format!("{value:#?}")] {
        assert!(
            !text.contains("B1_REFRESH_SECRET"),
            "secret leaked in Debug"
        );
    }
}
#[test]
fn request_and_response_debug_never_contains_secrets() {
    let auth = refresh_request("B1_REFRESH_SECRET");
    redacted(&auth);
    let headers = vec![
        ("Authorization".into(), "B1_REFRESH_SECRET".into()),
        ("x-api-key".into(), "B1_REFRESH_SECRET".into()),
        ("Cookie".into(), "B1_REFRESH_SECRET".into()),
    ];
    redacted(&HttpRequest {
        provider: "anthropic".into(),
        url: "B1_REFRESH_SECRET".into(),
        method: "POST".into(),
        headers: headers.clone(),
        body: auth.body.clone(),
        body_encoding: None,
        request_id: None,
    });
    redacted(&CodecHttpRequest {
        url: "B1_REFRESH_SECRET".into(),
        method: "POST".into(),
        headers,
        body: auth.body,
        body_encoding: None,
    });
    redacted(&Credentials {
        access_token: Some("B1_REFRESH_SECRET".into()),
        api_key: Some("B1_REFRESH_SECRET".into()),
        provider_data: Default::default(),
    });
    let mut headers = Headers::new();
    headers.append_received("set-cookie", "B1_REFRESH_SECRET");
    redacted(&headers);
    redacted(&HttpResponse {
        status: 200,
        headers,
        body: ResponseBody::from_bytes("B1_REFRESH_SECRET"),
    });
}
