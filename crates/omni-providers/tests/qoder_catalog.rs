//! The catalog and credential boundaries pinned against `qoderCatalog.test.ts`:
//! public projection without vendor secrets or guessed prices, strict roots,
//! row caps, and a credential parse that rejects raw bearer tokens outright.

use omni_ir::jsjson::JsValue;
use omni_providers::qoder::credential::{Bundle, InvalidCredential, parse};
use omni_providers::qoder::model_catalog::{
    InvalidCatalog, QoderModel, bundle_rows, inference_rows, parse_model_catalog,
    public_model_catalog,
};
use serde_json::{Value, json};

fn js(value: Value) -> JsValue {
    JsValue::from(&value)
}

#[test]
fn catalog_projects_assistant_models_without_vendor_secrets_or_guessed_prices() {
    let rows = parse_model_catalog(&js(json!({
        "assistant": [
            {
                "key": "synthetic",
                "display_name": "Synthetic",
                "is_vl": true,
                "is_reasoning": false,
                "max_input_tokens": 1234,
                "api_key": "never-public",
                "url": "https://evil.test",
                "model": "internal"
            },
            {"key": "disabled", "display_name": "Disabled", "enable": "0"},
            {"key": "disabled2", "display_name": "Disabled", "enable": false},
            {"key": "bad\nname", "display_name": "Bad"},
            {"key": "minimal", "display_name": "Minimal", "max_input_tokens": -1}
        ],
        "quest": [{"key": "not-assistant", "display_name": "Other scene"}]
    })))
    .expect("catalog");
    assert_eq!(
        rows,
        [
            QoderModel {
                key: "synthetic".into(),
                display_name: "Synthetic".into(),
                images: true,
                reasoning: false,
                max_input_tokens: Some(1234.0),
            },
            QoderModel {
                key: "minimal".into(),
                display_name: "Minimal".into(),
                images: false,
                reasoning: false,
                max_input_tokens: None,
            },
        ]
    );
    assert_eq!(
        Value::Object(public_model_catalog(&rows)),
        json!({
            "version": 1,
            "models": [
                {"id": "synthetic", "name": "Synthetic", "pricing": null, "limits": {"contextWindow": 1234.0}},
                {"id": "minimal", "name": "Minimal", "pricing": null, "limits": {}}
            ]
        })
    );
    // The bundle rows carry the credential's camelCase vocabulary; the
    // inference rows keep the vendor's snake_case one, minus the secrets.
    assert_eq!(
        bundle_rows(&rows),
        json!([
            {"key": "synthetic", "displayName": "Synthetic", "images": true, "reasoning": false, "maxInputTokens": 1234.0},
            {"key": "minimal", "displayName": "Minimal", "images": false, "reasoning": false}
        ])
    );
    assert_eq!(
        inference_rows(&rows),
        json!([
            {"key": "synthetic", "display_name": "Synthetic", "is_vl": true, "is_reasoning": false, "max_input_tokens": 1234.0},
            {"key": "minimal", "display_name": "Minimal", "is_vl": false, "is_reasoning": false}
        ])
    );
}

#[test]
fn catalog_distinguishes_valid_empty_responses_from_malformed_roots_and_caps_rows() {
    assert_eq!(
        parse_model_catalog(&js(json!({"assistant": []}))).expect("empty"),
        []
    );
    for bad in [
        json!(null),
        json!([]),
        json!({}),
        json!({"assistant": {}}),
        json!({"assistant": null}),
    ] {
        assert_eq!(
            parse_model_catalog(&js(bad.clone())),
            Err(InvalidCatalog),
            "accepted {bad:?}"
        );
    }
    let row = json!({"key": "synthetic", "display_name": "Synthetic"});
    assert_eq!(
        parse_model_catalog(&js(json!({"assistant": [row, row]})))
            .expect("dedupe")
            .len(),
        1
    );
    let many: Vec<Value> = (0..600)
        .map(|i| json!({"key": format!("synthetic-{i}"), "display_name": "Synthetic"}))
        .collect();
    assert_eq!(
        parse_model_catalog(&js(json!({"assistant": many})))
            .expect("cap")
            .len(),
        500
    );
}

fn bundle_json() -> Value {
    json!({
        "version": 1,
        "deviceToken": "dummy-token",
        "uid": "user-1",
        "machineId": "synthetic-device",
        "encryptUserInfo": "encrypted-envelope",
        "key": "wrapped-key",
        "issuedAt": 1700000000000.0,
        "origin": "https://api2.qoder.sh",
        "models": [{"key": "synthetic", "displayName": "Synthetic", "images": false, "reasoning": true}]
    })
}

#[test]
fn credential_parsing_rejects_raw_bearer_tokens_hostile_origins_and_malformed_metadata() {
    let text = serde_json::to_string(&bundle_json()).expect("bundle json");
    assert_eq!(
        parse(&text).expect("bundle"),
        Bundle {
            device_token: "dummy-token".into(),
            uid: "user-1".into(),
            machine_id: "synthetic-device".into(),
            encrypt_user_info: "encrypted-envelope".into(),
            key: "wrapped-key".into(),
            issued_at: 1_700_000_000_000.0,
            origin: "https://api2.qoder.sh".into(),
            models: vec![QoderModel {
                key: "synthetic".into(),
                display_name: "Synthetic".into(),
                images: false,
                reasoning: true,
                max_input_tokens: None,
            }],
        }
    );
    let mut variants = vec!["raw-token".to_owned(), "null".to_owned()];
    for bad in [
        json!({"version": 2}),
        json!({"origin": "https://evil.test"}),
        json!({"deviceToken": ""}),
        json!({"models": [{}]}),
        json!({"issuedAt": null}),
    ] {
        let mut v = bundle_json();
        let patch = bad.as_object().expect("patch");
        for (k, val) in patch {
            v[k] = val.clone();
        }
        variants.push(serde_json::to_string(&v).expect("variant"));
    }
    for bad in variants {
        assert_eq!(parse(&bad), Err(InvalidCredential), "accepted {bad:?}");
    }
    assert_eq!(InvalidCredential.to_string(), "Invalid Qoder credential");
}
