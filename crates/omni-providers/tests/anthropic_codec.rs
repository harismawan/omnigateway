use omni_providers::codec::ProviderCodec;
#[test]
fn fingerprint_hook_preserves_hints_and_only_matches_http_400() {
    use omni_ir::error::{ErrorCode, GatewayError};
    use omni_providers::{
        anthropic::{cloak::ToolCloak, codec::AnthropicCodec},
        codec::CodecErrorInput,
        http::Headers,
    };
    let headers = Headers::new();
    let cloak = ToolCloak::default();
    let notes = vec!["anthropic:tool-names-cloaked".into()];
    let fallback = GatewayError::new(ErrorCode::BadRequest, "You're out of extra usage")
        .with_status(400)
        .with_retry_after_ms(Some(1234.5));
    for status in [400, 413, 422, 429, 500] {
        let error = AnthropicCodec.classify_error(&CodecErrorInput {
            status,
            body: "ignored",
            headers: &headers,
            degradations: &notes,
            decode_state: &cloak,
            fallback: &fallback,
        });
        if status == 400 {
            let e = error.expect("fingerprint");
            assert_eq!(e.code, ErrorCode::FingerprintRefused);
            assert!(!e.retryable);
            assert_eq!(e.upstream_status, Some(400));
            assert_eq!(e.retry_after_ms, Some(1234.5));
            assert_eq!(e.degradations, notes);
            assert_eq!(e.message, fallback.message);
        } else {
            assert!(error.is_none());
        }
    }
    let ordinary = GatewayError::new(ErrorCode::BadRequest, "invalid max_tokens");
    assert!(
        AnthropicCodec
            .classify_error(&CodecErrorInput {
                status: 400,
                body: "out of extra usage",
                headers: &headers,
                degradations: &notes,
                decode_state: &cloak,
                fallback: &ordinary
            })
            .is_none()
    );
}
