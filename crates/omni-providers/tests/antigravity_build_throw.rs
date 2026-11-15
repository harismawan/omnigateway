use omni_providers::{
    adapter::{AdapterRequest, SendError, send},
    antigravity::codec::AntigravityCodec,
    codec::{CodecInput, Credentials, ProviderCodec},
    http::{HttpClient, HttpError, HttpRequest, HttpResponse},
};
use std::{future::Future, pin::Pin};

struct NoHttp;
impl HttpClient for NoHttp {
    fn send(
        &self,
        _: HttpRequest,
    ) -> Pin<Box<dyn Future<Output = Result<HttpResponse, HttpError>> + Send + '_>> {
        panic!("build failure must not send HTTP")
    }
}

#[tokio::test]
async fn build_throw_and_classified_refusal() {
    let request = serde_json::from_value(serde_json::json!({"model":"m","stream":true,"messages":[],"tools":[{"kind":"portable","name":"t","inputSchema":null}]})).expect("fixture");
    for token in [Some("t".to_owned()), None] {
        let has_token = token.is_some();
        let credentials = Credentials {
            access_token: token,
            api_key: None,
            provider_data: serde_json::json!({"projectId":"p"})
                .as_object()
                .expect("fixture")
                .clone(),
        };
        let error = match send(
            &AntigravityCodec,
            "antigravity",
            AdapterRequest::new(&request, "m", &credentials),
            &NoHttp,
        )
        .await
        {
            Err(SendError::Gateway(e)) => e,
            _ => panic!("expected gateway error"),
        };
        assert_eq!(error.provider.as_deref(), Some("antigravity"));
        assert_eq!(error.gateway_authored, has_token);
        assert_eq!(
            error.code.as_str(),
            if has_token { "UPSTREAM" } else { "AUTH" }
        );
        assert_eq!(
            error.message,
            if has_token {
                "antigravity codec buildRequest threw"
            } else {
                "antigravity credential has no access token"
            }
        );
    }
}

#[test]
fn null_schema_root_throws() {
    assert_eq!(
        omni_providers::antigravity::schema::try_prune(&serde_json::Value::Null),
        Err(omni_providers::codec::BuildError::Throw)
    );
}

#[tokio::test]
async fn compatibility_throw_equals_adapter_all_fields_for_two_rows() {
    for with_notes in [false, true] {
        let request = serde_json::from_value(serde_json::json!({
            "model":"m", "stream":true,
            "messages": if with_notes {
                serde_json::json!([{"role":"system","content":[{"type":"thinking","text":"secret"}]}])
            } else { serde_json::json!([]) },
            "tools":[{"kind":"portable","name":if with_notes { "read file" } else { "t" },"inputSchema":null}]
        })).expect("fixture");
        let credentials = Credentials {
            access_token: Some("t".into()),
            api_key: None,
            provider_data: serde_json::json!({"projectId":"p"})
                .as_object()
                .expect("fixture")
                .clone(),
        };
        let direct = ProviderCodec::build_request(
            &AntigravityCodec,
            &CodecInput {
                request: &request,
                model: "m",
                credentials: &credentials,
                request_id: None,
                auto_cache_enabled: None,
                max_output_tokens: None,
                request_started_at: None,
            },
        )
        .err()
        .expect("null schema must throw");
        let wrapped = match send(
            &AntigravityCodec,
            "antigravity",
            AdapterRequest::new(&request, "m", &credentials),
            &NoHttp,
        )
        .await
        {
            Err(SendError::Gateway(error)) => error,
            _ => panic!("expected gateway error"),
        };
        assert_eq!(direct, wrapped, "with_notes={with_notes}");
        assert_eq!(direct.code, omni_ir::error::ErrorCode::Upstream);
        assert_eq!(direct.message, "antigravity codec buildRequest threw");
        assert_eq!(direct.provider.as_deref(), Some("antigravity"));
        assert!(direct.gateway_authored);
        assert!(direct.retryable);
        assert!(direct.degradations.is_empty());
        assert_eq!(direct.upstream_status, None);
        assert_eq!(direct.retry_after_ms, None);
    }
}
