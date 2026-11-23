use omni_ir::error::ErrorCode;
use omni_providers::anthropic::oauth::{exchange_request, refresh_request, start, token_result};
use omni_providers::oauth::{PendingFlow, token_error};

#[test]
fn pkce_matches_rfc7636_and_state_is_unpredictable() {
    use omni_providers::oauth::{pkce, pkce_challenge, random_state};
    assert_eq!(
        pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    let (verifier, challenge) = pkce();
    assert_eq!(verifier.len(), 43);
    assert_eq!(pkce_challenge(&verifier), challenge);
    assert_ne!(random_state(), random_state());
}

#[test]
fn exchange_preserves_wire_order_and_checks_pasted_state() {
    let p = PendingFlow {
        verifier: "v".into(),
        challenge: "c".into(),
        state: "s".into(),
        redirect_uri: "r".into(),
        device_code: None,
        interval: None,
        extra: serde_json::Map::new(),
    };
    let sent = exchange_request(" auth-code #s", &p).expect("exchange");
    assert_eq!(
        sent.body,
        r#"{"grant_type":"authorization_code","code":"auth-code","redirect_uri":"r","code_verifier":"v","state":"s","client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}"#
    );
    assert_eq!(
        sent.headers[0],
        ("Accept".into(), "application/json".into())
    );
    assert_eq!(
        sent.headers[1],
        ("Content-Type".into(), "application/json".into())
    );
    assert_eq!(
        exchange_request("c#wrong", &p).expect_err("state").code,
        ErrorCode::Auth
    );
    let s = start("v", "c", "s");
    assert!(
        s.authorize_url
            .contains("scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference")
    );
    assert_eq!(
        s.pending.redirect_uri,
        "https://platform.claude.com/oauth/code/callback"
    );
}

#[test]
fn refresh_rotates_or_preserves_and_errors_do_not_leak() {
    assert_eq!(
        refresh_request("old").body,
        r#"{"grant_type":"refresh_token","refresh_token":"old","client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}"#
    );
    let result = token_result(
        200,
        r#"{"access_token":"new","expires_in":60}"#,
        Some("old"),
        1000.0,
    )
    .expect("tokens");
    assert_eq!(
        result.refresh_token,
        Some(omni_ir::jsjson::JsValue::String(
            "old".encode_utf16().collect()
        ))
    );
    assert_eq!(result.expires_at, Some(61000.0));
    let result = token_result(
        200,
        r#"{"access_token":"new","refresh_token":"rotated"}"#,
        Some("old"),
        0.0,
    )
    .expect("tokens");
    assert_eq!(
        result.refresh_token,
        Some(omni_ir::jsjson::JsValue::String(
            "rotated".encode_utf16().collect()
        ))
    );
    for (status, code) in [
        (400, ErrorCode::Auth),
        (429, ErrorCode::RateLimit),
        (503, ErrorCode::Upstream),
    ] {
        let e = token_error(
            status,
            &serde_json::json!({"error":"secret value", "error_description":"secret"}),
        );
        assert_eq!(e.code, code);
        assert_eq!(
            e.message,
            format!("token endpoint rejected the request: http_{status}")
        );
    }
    assert_eq!(
        token_result(200, "{}", None, 0.0)
            .err()
            .expect("missing")
            .code,
        ErrorCode::Auth
    );
}

#[test]
fn pending_flow_old_json_round_trips_byte_stable() {
    let old = r#"{"verifier":"v","challenge":"c","state":"s","redirectUri":"r"}"#;
    let flow: PendingFlow = serde_json::from_str(old).expect("old json");
    assert!(flow.device_code.is_none());
    assert!(flow.interval.is_none());
    assert!(flow.extra.is_empty());
    assert_eq!(serde_json::to_string(&flow).expect("json"), old);
}

#[test]
fn pending_flow_device_fields_serialize_only_when_present() {
    let device = PendingFlow {
        verifier: "v".into(),
        challenge: "c".into(),
        state: "s".into(),
        redirect_uri: "r".into(),
        device_code: Some("dc".into()),
        interval: Some(3.0),
        extra: serde_json::json!({"deviceId":"machine"})
            .as_object()
            .cloned()
            .expect("map"),
    };
    let json = serde_json::to_string(&device).expect("json");
    assert_eq!(
        json,
        r#"{"verifier":"v","challenge":"c","state":"s","redirectUri":"r","deviceCode":"dc","interval":3.0,"extra":{"deviceId":"machine"}}"#
    );
    let back: PendingFlow = serde_json::from_str(&json).expect("round trip");
    assert_eq!(serde_json::to_string(&back).expect("json"), json);
    let partial = PendingFlow {
        device_code: Some("dc".into()),
        interval: None,
        extra: serde_json::Map::new(),
        ..device
    };
    let json = serde_json::to_string(&partial).expect("json");
    assert_eq!(
        json,
        r#"{"verifier":"v","challenge":"c","state":"s","redirectUri":"r","deviceCode":"dc"}"#
    );
}

#[test]
fn authorize_start_user_code_serializes_only_when_present() {
    let mut start = start("v", "c", "s");
    let json = serde_json::to_string(&start).expect("json");
    assert!(!json.contains("userCode"));
    start.user_code = Some("ABCD-1234".into());
    let value: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&start).expect("json")).expect("json");
    assert_eq!(value["userCode"], "ABCD-1234");
}

#[test]
fn device_error_wraps_gateway_errors_and_pending_is_distinct() {
    use omni_providers::oauth::DeviceError;
    fn poll() -> Result<(), DeviceError> {
        Err(omni_ir::error::GatewayError::new(ErrorCode::Auth, "denied"))?;
        Ok(())
    }
    match poll() {
        Err(DeviceError::Gateway(e)) => {
            assert_eq!(e.code, ErrorCode::Auth);
            assert_eq!(e.message, "denied");
        }
        other => panic!("From<GatewayError> must wrap, got {other:?}"),
    }
    let pending = DeviceError::Pending;
    assert!(matches!(pending, DeviceError::Pending));
}
