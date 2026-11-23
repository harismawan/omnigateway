//! The synthetic device identity, mirroring `kimiDevice.test.ts`: a stable
//! shape that is never the operator's real machine, frozen onto the
//! credential, with `"unknown"` fallbacks for credentials that predate the
//! descriptive fields.

use omni_providers::kimi::device::{from_data, headers, mint};
use serde_json::{Map, Value, json};

fn map(value: Value) -> Map<String, Value> {
    value.as_object().cloned().expect("object")
}

#[test]
fn mint_produces_a_stable_shaped_synthetic_identity() {
    let d = mint();
    // A lowercase UUID: 8-4-4-4-12 hex digits.
    assert_eq!(d.device_id.len(), 36);
    for (i, c) in d.device_id.chars().enumerate() {
        if [8, 13, 18, 23].contains(&i) {
            assert_eq!(c, '-', "{}", d.device_id);
        } else {
            assert!(
                c.is_ascii_hexdigit() && !c.is_ascii_uppercase(),
                "{}",
                d.device_id
            );
        }
    }
    // Never the operator's real machine name: the values are made up once.
    assert_eq!(d.device_name, "MacBook-Pro");
    assert_eq!(d.device_model, "MacBookPro18,3");
    assert_eq!(d.os_version, "15.3.1");
    assert_ne!(mint().device_id, d.device_id);
}

#[test]
fn device_headers_emits_all_four_headers() {
    let h = headers(&map(json!({
        "deviceId": "abc", "deviceName": "n", "deviceModel": "m", "osVersion": "o"
    })));
    assert_eq!(
        h,
        [
            ("X-Msh-Device-Id".into(), "abc".into()),
            ("X-Msh-Device-Name".into(), "n".into()),
            ("X-Msh-Device-Model".into(), "m".into()),
            ("X-Msh-Os-Version".into(), "o".into()),
        ]
    );
}

#[test]
fn device_headers_fills_defaults_for_credentials_that_predate_the_fields() {
    let h = headers(&map(json!({"deviceId": "abc"})));
    assert_eq!(
        h,
        [
            ("X-Msh-Device-Id".into(), "abc".into()),
            ("X-Msh-Device-Name".into(), "unknown".into()),
            ("X-Msh-Device-Model".into(), "unknown".into()),
            ("X-Msh-Os-Version".into(), "unknown".into()),
        ]
    );
}

#[test]
fn device_headers_emits_nothing_when_there_is_no_device_id() {
    assert!(headers(&Map::new()).is_empty());
    assert!(headers(&map(json!({"deviceId": ""}))).is_empty());
    assert!(headers(&map(json!({"deviceId": 7}))).is_empty());
    assert!(headers(&map(json!({"deviceName": "n"}))).is_empty());
}

#[test]
fn from_data_reads_a_persisted_identity_and_mints_only_what_is_missing() {
    let stored = map(json!({
        "deviceId": "11111111-2222-3333-4444-555555555555",
        "deviceName": "MacBook-Pro",
        "deviceModel": "MacBookPro18,3",
        "osVersion": "15.3.1"
    }));
    let d = from_data(Some(&stored));
    assert_eq!(d.map(), stored);

    // A credential carrying only `deviceId` keeps it and takes the frozen
    // values for the rest — not the header fallbacks, which are "unknown".
    let legacy = from_data(Some(&map(json!({"deviceId": "abc"}))));
    assert_eq!(legacy.device_id, "abc");
    assert_eq!(legacy.device_name, "MacBook-Pro");
    assert_eq!(legacy.device_model, "MacBookPro18,3");
    assert_eq!(legacy.os_version, "15.3.1");

    // Absent or blank ids mint a fresh identity rather than claiming none.
    assert_ne!(from_data(None).device_id, from_data(None).device_id);
    assert_ne!(from_data(Some(&map(json!({"deviceId": ""})))).device_id, "");
}
