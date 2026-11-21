//! Crypto and hashing parity against vectors exported from the TS build.

use omni_crypto::{apikey, cch, cloak, codex, field, qoder};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/vectors/vectors.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("vectors")).expect("json")
}

fn utf16(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .expect("units")
        .iter()
        .map(|u| u16::try_from(u.as_u64().expect("unit")).expect("u16"))
        .collect()
}

fn s(value: &Value) -> &str {
    value.as_str().expect("string")
}

#[test]
fn field_encryption_decrypts_every_ts_ciphertext() {
    let all = vectors();
    let enc = &all["encryption"];
    let key = field::derive_key(s(&enc["secret"]));
    for v in enc["vectors"].as_array().expect("vectors") {
        let plain = field::decrypt(&key, s(&v["ciphertext"])).expect("decrypts");
        assert_eq!(plain, s(&v["plaintext"]));
        // And our own output is readable by our own reader, in the same format.
        let sealed = field::encrypt(&key, s(&v["plaintext"]));
        assert!(sealed.starts_with("enc:v1:"));
        assert_eq!(
            field::decrypt(&key, &sealed).expect("round trip"),
            s(&v["plaintext"])
        );
    }
}

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

#[test]
fn api_key_hash_and_prefix_match_ts() {
    for v in vectors()["apiKeys"].as_array().expect("keys") {
        assert_eq!(apikey::hash(s(&v["raw"])), s(&v["hash"]));
        assert_eq!(apikey::prefix(s(&v["raw"])), s(&v["prefix"]));
    }
    let minted = apikey::generate();
    assert_eq!(minted.len(), 51);
    assert!(minted.starts_with("sk-omni-"));
}

#[test]
fn xxhash64_matches_bun_hash() {
    for v in vectors()["xxhash"].as_array().expect("cases") {
        let text = String::from_utf16_lossy(&utf16(&v["utf16"]));
        assert_eq!(cloak::xxh64_utf8(&text, 0).to_string(), s(&v["seed0"]));
        assert_eq!(
            cloak::xxh64_utf8(&text, cch::CCH_SEED).to_string(),
            s(&v["seedCch"])
        );
    }
}

#[test]
fn cch_signing_matches_ts() {
    for v in vectors()["cch"].as_array().expect("cases") {
        assert_eq!(cch::compute(s(&v["body"])), s(&v["computeCch"]));
        assert_eq!(cch::sign_anthropic_body(s(&v["body"])), s(&v["signed"]));
    }
}

#[test]
fn cc_version_suffix_indexes_utf16_like_js() {
    for v in vectors()["ccVersionSuffix"].as_array().expect("cases") {
        assert_eq!(
            cch::cc_version_suffix(&utf16(&v["utf16"]), cch::DEFAULT_CLI_VERSION),
            s(&v["suffix"]),
            "{v}"
        );
    }
}

#[test]
fn codex_identity_matches_ts() {
    let all = vectors();
    let c = &all["codexIdentity"];
    for v in c["uuidV5"].as_array().expect("v5") {
        let name = String::from_utf16_lossy(&utf16(&v["utf16"]));
        assert_eq!(codex::uuid_v5(s(&v["namespace"]), &name), s(&v["output"]));
    }
    for v in c["uuidV4From"].as_array().expect("v4") {
        let seed = String::from_utf16_lossy(&utf16(&v["utf16"]));
        assert_eq!(codex::uuid_v4_from(&seed), s(&v["output"]));
    }
    for v in c["uuidV7From"].as_array().expect("v7") {
        let ts = v["timestampMs"].as_f64().expect("ts");
        assert_eq!(codex::uuid_v7_from(s(&v["seed"]), ts), s(&v["output"]));
    }
    for v in c["threadIdFrom"].as_array().expect("thread") {
        let seed = String::from_utf16_lossy(&utf16(&v["utf16"]));
        assert_eq!(codex::thread_id_from(&seed), s(&v["output"]));
    }
    for v in c["threadInstant"].as_array().expect("instant") {
        let now = v["now"].as_f64().expect("now");
        assert_eq!(
            codex::thread_instant(s(&v["threadId"]), now),
            v["output"].as_f64().expect("out")
        );
    }
    for v in c["keyed"].as_array().expect("keyed") {
        assert_eq!(
            codex::keyed(v["salt"].as_str(), s(&v["seed"])),
            s(&v["output"])
        );
    }
    for v in c["prefixNamespace"].as_array().expect("ns") {
        assert_eq!(codex::prefix_namespace(s(&v["threadId"])), s(&v["output"]));
    }
}

#[test]
fn qoder_protocol_matches_ts() {
    let all = vectors();
    let q = &all["qoder"];
    for v in q["encodeBody"].as_array().expect("encode") {
        assert_eq!(qoder::encode_body(s(&v["plain"])), s(&v["encoded"]));
        assert_eq!(
            qoder::decode_body(s(&v["encoded"])).expect("decodes"),
            s(&v["plain"])
        );
    }
    for v in q["decodeBodyErrors"].as_array().expect("errors") {
        let got = qoder::decode_body(s(&v["encoded"]));
        if v["error"].as_bool() == Some(true) {
            assert!(got.is_err(), "{v}");
        } else {
            assert_eq!(got.expect("decodes"), s(&v["decoded"]));
        }
    }
    let a = &q["signAuth"]["input"];
    assert_eq!(
        qoder::sign_auth(
            s(&a["authBase64"]),
            s(&a["key"]),
            s(&a["date"]),
            s(&a["body"]),
            s(&a["path"])
        ),
        s(&q["signAuth"]["output"])
    );
    for v in q["signAnonymous"].as_array().expect("anon") {
        assert_eq!(qoder::sign_anonymous(s(&v["date"])), s(&v["output"]));
    }
    let aes = &q["aes"];
    assert_eq!(
        qoder::encrypt_user_info(s(&aes["userJson"]), s(&aes["key"])).expect("key ok"),
        s(&aes["encryptUserInfo"])
    );
    assert!(qoder::encrypt_user_info("{}", "NOT-HEX-KEY-0000").is_err());
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
