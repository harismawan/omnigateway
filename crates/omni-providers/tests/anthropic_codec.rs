use omni_providers::codec::{CodecInput, Credentials, ProviderCodec};
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
#[test]
fn frozen_ts_codec_wire_bytes() {
    let run = std::process::Command::new("bun")
        .arg("tests/anthropic-codec-reference.ts")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun");
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&run.stdout).expect("corpus");
    for row in rows.as_array().expect("rows") {
        let req = serde_json::from_value(row["request"].clone()).expect("IR");
        let credentials = Credentials {
            access_token: row["credentials"]["accessToken"]
                .as_str()
                .map(str::to_owned),
            api_key: row["credentials"]["apiKey"].as_str().map(str::to_owned),
            provider_data: Default::default(),
        };
        let result = omni_providers::anthropic::codec::AnthropicCodec
            .build_request(&CodecInput {
                request: &req,
                model: row["model"].as_str().expect("model"),
                credentials: &credentials,
                request_id: None,
                auto_cache_enabled: None,
                max_output_tokens: None,
                request_started_at: None,
            })
            .expect("codec");
        assert_eq!(
            result.request.body,
            row["wire"]["body"].as_str().expect("body")
        );
        assert_eq!(
            serde_json::json!(result.request.headers),
            row["wire"]["headers"]
        );
        assert_eq!(serde_json::json!(result.degradations), row["degradations"]);
        assert_eq!(serde_json::json!(result.cloaked_tools), row["cloakedTools"]);
    }
}
