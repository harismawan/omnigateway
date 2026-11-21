use omni_providers::antigravity::oauth;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::process::Command;

#[test]
fn authorization_matches_frozen() {
    let output = Command::new("bun")
        .args(["--no-env-file", "tests/antigravity_connect-reference.ts"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("reference");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows: Vec<Value> = serde_json::from_slice(&output.stdout).expect("rows");
    assert_eq!(rows.len(), 70);
    let start = oauth::start("verifier +🙂", "challenge", "state");
    assert_eq!(
        serde_json::to_value(&start).expect("start"),
        rows[0]["expected"]
    );
    for row in &rows[1..] {
        let mut requests = Vec::new();
        let mut responses = row["responses"].as_array().expect("responses").iter();
        let mut send = |request: omni_providers::oauth::AuthRequest, timeout: Option<u64>| {
            let mut value = serde_json::to_value(&request).expect("request");
            value["body"] = omni_crypto::hex_lower(&Sha256::digest(request.body.as_bytes())).into();
            if let Some(timeout) = timeout {
                value["timeoutMs"] = timeout.into();
            }
            requests.push(value);
            let response = responses.next().expect("scripted response");
            (
                response["status"].as_u64().expect("status") as u16,
                response["body"].as_str().expect("body"),
            )
        };
        let result = (|| {
            let req = oauth::exchange_request(row["code"].as_str().expect("code"), &start.pending)?;
            let (status, body) = send(req, None);
            let mut result = oauth::token_result(status, body, None, 1234.0, &json!({}))?;
            let access = String::from_utf16(&result.access_token).expect("access");
            let (status, body) = send(oauth::email_request(&access), Some(15000));
            result.account_email = oauth::email_result(status, body);
            let (status, body) = send(oauth::load_request(&access), None);
            let (mut project, tier) = oauth::project_result(status, body);
            if project.is_empty() {
                let (status, body) = send(oauth::onboard_request(&access, &tier), None);
                project = oauth::onboard_result(status, body);
            }
            result.provider_data = json!({"projectId":project,"tier":tier})
                .as_object()
                .expect("provider data")
                .clone();
            Ok::<_, omni_ir::error::GatewayError>(json!({
                "secrets":{"accessToken":access,"refreshToken":result.refresh_token.as_ref().map(scalar),"apiKey":null,"idToken":null},
                "expiresAt":result.expires_at,"accountEmail":result.account_email.as_ref().map(scalar),"providerData":result.provider_data
            }))
        })();
        assert_eq!(
            requests,
            row["requests"].as_array().expect("requests").clone(),
            "requests for {row}"
        );
        match result {
            Ok(result) => assert_eq!(
                omni_ir::jsjson::parse_js(&omni_ir::jsjson::to_string(&result)).expect("actual"),
                omni_ir::jsjson::parse_js(&omni_ir::jsjson::to_string(&row["result"]))
                    .expect("expected"),
                "result for {row}"
            ),
            Err(e) => assert_eq!(
                json!({"code":e.code.as_str(),"message":e.message}),
                row["error"]
            ),
        }
    }
}

fn scalar(value: &omni_ir::jsjson::JsValue) -> Value {
    serde_json::from_str(&omni_ir::jsjson::stringify(value).expect("scalar text"))
        .expect("scalar JSON")
}
