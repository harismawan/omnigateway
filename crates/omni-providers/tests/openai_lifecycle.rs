use omni_providers::{
    oauth::PendingFlow,
    openai::oauth::{exchange_request, refresh_request, token_result},
};
use serde_json::{Value, json};
#[test]
fn frozen_lifecycle_comparison() {
    let out = std::process::Command::new("bun")
        .arg("crates/omni-providers/tests/openai-lifecycle-reference.ts")
        .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
        .output()
        .expect("oracle");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let rows: Vec<Value> = serde_json::from_slice(&out.stdout).expect("rows");
    assert_eq!(rows.len(), 152);
    for (index, row) in rows.iter().enumerate() {
        let refresh = row["mode"] == "refresh";
        let request = if refresh {
            refresh_request("old")
        } else {
            exchange_request(
                " code #s",
                &PendingFlow {
                    verifier: "v".into(),
                    challenge: "c".into(),
                    state: "s".into(),
                    redirect_uri: "http://localhost/callback".into(),
                },
            )
            .expect("exchange")
        };
        let expected = &row["request"];
        assert_eq!(request.url, expected["url"], "request {index}");
        assert_eq!(request.body, expected["body"], "request {index}");
        assert_eq!(
            json!(request.headers),
            expected["headers"],
            "headers {index}"
        );
        let actual = token_result(
            row["status"]
                .as_u64()
                .expect("status")
                .try_into()
                .expect("u16"),
            row["body"].as_str().expect("body"),
            refresh.then_some("old"),
            1000.0,
            &row["prior"],
        );
        match actual {
            Err(error) => assert_eq!(
                json!({"code":error.code.as_str(),"message":error.message}),
                row["error"],
                "error {index}"
            ),
            Ok(result) => {
                let mut actual = json!({"secrets":{"accessToken":String::from_utf16_lossy(&result.access_token),"refreshToken":result.refresh_token.as_ref().and_then(omni_ir::jsjson::stringify).and_then(|v| serde_json::from_str::<Value>(&v).ok()),"apiKey":null,"idToken":result.id_token.as_ref().map(|s|String::from_utf16_lossy(s))},"expiresAt":result.expires_at,"accountEmail":result.account_email.as_ref().and_then(omni_ir::jsjson::stringify).and_then(|v|serde_json::from_str::<Value>(&v).ok()),"providerData":result.provider_data});
                let expected = &row["result"];
                for key in ["installationId", "idSalt"] {
                    let prior = row["prior"][key].as_str();
                    let valid = prior.is_some_and(|s| {
                        if key == "idSalt" {
                            s.len() == 64
                                && s.bytes()
                                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                        } else {
                            s.len() == 36
                        }
                    });
                    if !valid {
                        let minted = actual["providerData"][key].as_str().expect("minted");
                        if key == "idSalt" {
                            assert_eq!(minted.len(), 64);
                            assert!(
                                minted
                                    .bytes()
                                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                            );
                        } else {
                            assert_eq!(minted.len(), 36);
                            assert_eq!(&minted[14..15], "4");
                        }
                        actual["providerData"][key] = expected["providerData"][key].clone();
                    }
                }
                // JSON numeric representation is irrelevant to the millisecond carrier.
                assert_eq!(actual["expiresAt"].as_f64(), expected["expiresAt"].as_f64());
                actual["expiresAt"] = expected["expiresAt"].clone();
                assert_eq!(actual, *expected, "row {index}");
            }
        }
    }
}
