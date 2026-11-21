#![allow(clippy::unwrap_used)]
use omni_dialects::ingress::{Headers, IngressOptions, Surface, ingest};
use omni_providers::codec::{CodecInput, Credentials, ProviderCodec};
use omni_providers::openai::OpenAiCodec;

#[test]
fn oauth_codec_matches_ts() {
    let out = std::process::Command::new("bun")
        .arg("--no-env-file")
        .arg("tests/openai-oauth-request-reference.ts")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let rows: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(rows.as_array().unwrap().len(), 577);
    let mut note_mismatches = Vec::new();
    for (i, row) in rows.as_array().unwrap().iter().enumerate() {
        let request = if let Some(dialect) = row["dialect"].as_str() {
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
        let credentials = if row.get("credentials").is_some() {
            Credentials {
                api_key: row["credentials"]["apiKey"].as_str().map(str::to_owned),
                access_token: row["credentials"]["accessToken"]
                    .as_str()
                    .map(str::to_owned),
                provider_data: serde_json::from_value(row["credentials"]["providerData"].clone())
                    .unwrap(),
            }
        } else {
            Credentials {
                access_token: Some("oauth-token".into()),
                provider_data: serde_json::from_str(r#"{"accountId":"account"}"#).unwrap(),
                api_key: None,
            }
        };
        let got = OpenAiCodec
            .build_request(&CodecInput {
                request: &request,
                model: row["model"].as_str().unwrap(),
                credentials: &credentials,
                request_id: row
                    .get("requestId")
                    .map_or(Some("fixed-oauth-request"), serde_json::Value::as_str),
                request_started_at: row
                    .get("requestStartedAt")
                    .map_or(Some(1794000000123.0), serde_json::Value::as_f64),
                auto_cache_enabled: None,
                max_output_tokens: None,
            })
            .unwrap_or_else(|err| panic!("OAuth row {i}: {err:?}"));
        assert_eq!(
            got.request.url,
            row["codec"]["url"].as_str().unwrap(),
            "url {i}"
        );
        assert_eq!(
            got.request.body,
            row["codec"]["body"].as_str().unwrap(),
            "body {i}: {} {} {}",
            row["category"],
            row["model"],
            row["label"]
        );
        assert_eq!(
            serde_json::json!(got.request.headers),
            row["codec"]["headers"],
            "headers {i}"
        );
        let encoding = got.request.body_encoding.map(|encoding| match encoding {
            omni_providers::http::BodyEncoding::Zstd => "zstd",
        });
        assert_eq!(
            encoding,
            row["codec"]["bodyEncoding"].as_str(),
            "encoding {i}"
        );
        if serde_json::json!(got.degradations) != row["notes"] {
            note_mismatches.push(format!(
                "notes {i}: Rust {:?}; TS {}",
                got.degradations, row["notes"]
            ));
        }
        assert_eq!(
            got.decode_state,
            row["state"]["nativeReasoning"].as_bool().unwrap(),
            "state {i}"
        );
    }
    assert!(note_mismatches.is_empty(), "{}", note_mismatches.join("\n"));
}
