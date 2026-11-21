//! Crypto and hashing parity against vectors exported from the TS build.

use omni_crypto::{cloak, field};
use serde_json::Value;
#[test]
fn field_decrypt_rejects_malformed_values() {
    let key = field::derive_key("vector-only-encryption-key-0123456789");
    for bad in [
        "",
        "enc:v1",
        "enc:v1:00:00",
        "enc:v2:00:00:00",
        "enc:v1:AB:00:00",
        "enc:v1::00:00",
    ] {
        assert!(
            field::decrypt(&key, bad).is_err(),
            "{bad:?} must be refused"
        );
    }
}
/// `Bun.hash.xxHash64` itself (the TS gateway's hash) over every tail and
/// stripe boundary and four seeds; `tests/data/xxh64.json` names its Bun.
#[test]
fn xxhash64_matches_bun_on_every_length() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/data/xxh64.json");
    let data: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("xxh64 vectors")).expect("json");
    let cases = data["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), 1228);
    for case in cases {
        let hex = case[0].as_str().expect("hex");
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("hex byte"))
            .collect();
        let seed: u64 = case[1].as_str().expect("seed").parse().expect("u64");
        let want: u64 = case[2].as_str().expect("hash").parse().expect("u64");
        assert_eq!(
            cloak::xxh64(&bytes, seed),
            want,
            "len {} seed {seed}",
            bytes.len()
        );
    }
}
