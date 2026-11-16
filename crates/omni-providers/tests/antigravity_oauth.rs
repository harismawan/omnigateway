use omni_providers::antigravity::oauth;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::process::Command;

fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}

#[test]
fn refresh_matches_frozen() {
    let output = Command::new("bun")
        .args(["--no-env-file", "tests/antigravity_oauth-reference.ts"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("reference");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: Vec<Value> = serde_json::from_slice(&output.stdout).expect("rows");
    assert_eq!(rows.len(), 273);
    for row in rows {
        if row["kind"] == "request" {
            let req = oauth::refresh_request(row["refreshToken"].as_str().expect("token"));
            let fields: Vec<_> = url::form_urlencoded::parse(req.body.as_bytes()).collect();
            assert_eq!(hash(&fields[1].1), row["clientId"]);
            assert_eq!(hash(&fields[2].1), row["clientSecret"]);
            let mut actual = serde_json::to_value(&req).expect("request");
            actual["body"] = hash(&req.body).into();
            assert_eq!(actual, row["expected"], "request digest/headers");
        } else {
            let result = oauth::token_result(
                row["status"].as_u64().expect("status") as u16,
                row["body"].as_str().expect("body"),
                Some("fallback"),
                1234.0,
                &row["providerData"],
            );
            let actual = match result {
                Ok(r) => {
                    let access = omni_ir::jsjson::JsValue::String(r.access_token.clone());
                    let refresh = r
                        .refresh_token
                        .clone()
                        .unwrap_or(omni_ir::jsjson::JsValue::Null);
                    let text = format!(
                        "{{\"secrets\":{{\"accessToken\":{},\"refreshToken\":{},\"apiKey\":null,\"idToken\":null}},\"expiresAt\":{},\"accountEmail\":null,\"providerData\":{}}}",
                        omni_ir::jsjson::stringify(&access).expect("access"),
                        omni_ir::jsjson::stringify(&refresh).expect("refresh"),
                        omni_ir::jsjson::to_string(&json!(r.expires_at)),
                        omni_ir::jsjson::to_string(&Value::Object(r.provider_data.clone()))
                    );
                    // Compare JS values so lone surrogates and numeric representation survive.
                    assert_eq!(
                        omni_ir::jsjson::parse_js(&text).expect("actual"),
                        omni_ir::jsjson::parse_js(row["expected"].as_str().expect("expected text"))
                            .expect("expected")
                    );
                    continue;
                }
                Err(e) => json!({"code":e.code.as_str(),"message":e.message}),
            };
            assert_eq!(actual, row["error"]);
        }
    }
}
