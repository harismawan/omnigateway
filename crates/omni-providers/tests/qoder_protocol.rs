//! Qoder's wire protocol pinned against the TS adapter's own tests
//! (`qoderProtocol.test.ts`): the independent CLI WASM encoding vectors, the
//! newline-joined MD5 signatures, the deterministic AES half of the auth
//! envelope, and a real RSA round-trip against a private key the test holds.

use aes::cipher::{BlockModeDecrypt as _, KeyIvInit as _, block_padding::Pkcs7};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use omni_crypto::qoder::{decode_body, encode_body, sign_anonymous, sign_auth};
use omni_ir::jsjson::{self, JsValue};
use omni_providers::qoder::crypto::{
    CryptoError, QODER_PUBLIC_KEY, encrypt_auth, wrap_key, wrap_key_with_pem,
};
use omni_providers::qoder::endpoint::trusted_inference_origin;
use omni_providers::qoder::oauth::decode_server_json;
use rsa::pkcs8::{DecodePublicKey as _, EncodePublicKey as _, LineEnding};
use rsa::traits::PublicKeyParts as _;
use rsa::{Pkcs1v15Encrypt, RsaPrivateKey, RsaPublicKey};
use serde_json::{Value, json};

/// The captured model-list response, verbatim from the TS fixture.
const CATALOG: &str = include_str!("fixtures/qoder-catalog.json");

fn fixture() -> (String, String) {
    let v: Value = serde_json::from_str(CATALOG).expect("fixture");
    (
        v["plain"].as_str().expect("plain").to_owned(),
        v["encoded"].as_str().expect("encoded").to_owned(),
    )
}

#[test]
fn encoding_matches_independent_cli_wasm_vectors_including_utf8_and_padding() {
    let (plain, encoded) = fixture();
    let pairs = [
        ("", ""),
        ("a", "$p$#"),
        ("abc", "MSK#"),
        ("{}", "$kwm"),
        ("こんにちは 👋", "bBvoez#r$IHUIIHiIIHIIH@IIc@I"),
        (plain.as_str(), encoded.as_str()),
    ];
    for (plain, encoded) in pairs {
        assert_eq!(encode_body(plain), encoded, "encode {plain:?}");
        assert_eq!(decode_body(encoded).expect("decode"), plain);
    }
}

#[test]
fn model_responses_decode_encoded_and_plaintext_json_never_corrupt_data() {
    let (plain, encoded) = fixture();
    let want =
        JsValue::from(&json!({"assistant": [{"key": "synthetic", "display_name": "Synthetic"}]}));
    assert_eq!(decode_server_json(&encoded).expect("encoded"), want);
    assert_eq!(decode_server_json(&plain).expect("plain"), want);
    for bad in ["?", "____!", "$", "####", "not JSON", " "] {
        assert!(decode_server_json(bad).is_err(), "accepted {bad:?}");
    }
    for bad in ["?", "$", "__$_", "____!", "dd$$"] {
        assert!(decode_body(bad).is_err(), "accepted {bad:?}");
    }
}

const PATH: &str = "/api/v2/service/pro/sse/agent_chat_generation";

#[test]
fn signing_uses_newline_separated_auth_fields_and_the_callers_canonical_path() {
    let base = sign_auth("AUTH", "WRAPPED", "1700000000", "$kwm", PATH);
    assert_eq!(base, "aa21f94d650f341ef2a16398f177bac7");
    assert_ne!(
        sign_auth(
            "AUTH",
            "WRAPPED",
            "1700000000",
            "$kwm",
            &format!("/algo{PATH}")
        ),
        base
    );
    assert_ne!(sign_auth("AUTH", "WRAPPED", "1700000000", "{}", PATH), base);
    assert_eq!(
        sign_anonymous("Wed, 04 Nov 2026 09:22:34 GMT"),
        "262acb17c8b21474294be0f4248d2895"
    );
}

#[test]
fn encrypts_utf8_auth_with_aes128_cbc_iv_key_and_wraps_16_key_bytes_with_pkcs1() {
    let key = "0123456789abcdef";
    let result = encrypt_auth(r#"{"uid":"synthetic"}"#, key).expect("encrypt");
    assert_eq!(
        result.encrypt_user_info,
        "vO6rh9vE6tQPG+ndo73xUDgTsZ672flhfoBQBFyFIWU="
    );
    let public = RsaPublicKey::from_public_key_pem(QODER_PUBLIC_KEY).expect("shipped key");
    assert_eq!(public.n().bits(), 1024);
    assert_eq!(B64.decode(&result.key).expect("wrapped key").len(), 128);
    // The random PKCS1 padding must differ; the deterministic AES output stays fixed.
    let again = encrypt_auth(r#"{"uid":"synthetic"}"#, key).expect("encrypt again");
    assert_eq!(again.encrypt_user_info, result.encrypt_user_info);
    assert_ne!(again.key, result.key);
    assert_ne!(wrap_key(key).expect("wrap"), result.key);
    for bad in ["", "short", "0123456789abcdeg", &"界".repeat(16)] {
        assert_eq!(
            encrypt_auth("secret", bad),
            Err(CryptoError::InvalidKey),
            "accepted {bad:?}"
        );
    }
}

/// AES-128-CBC with key = IV, the decrypt direction the CLI's server uses.
fn aes_decrypt(cipher_b64: &str, key: &[u8]) -> String {
    let key: [u8; 16] = key.try_into().expect("16 key bytes");
    let bytes = B64.decode(cipher_b64).expect("cipher base64");
    let plain = cbc::Decryptor::<aes::Aes128>::new(&key.into(), &key.into())
        .decrypt_padded_vec::<Pkcs7>(&bytes)
        .expect("pkcs7");
    String::from_utf8(plain).expect("utf8")
}

#[test]
fn rsa_wrapping_decrypts_to_the_actual_aes_key_with_pkcs1_v15_padding() {
    // A test key pair the test holds the private half of: the real helper
    // runs under a caller-supplied PEM, exactly the TS boundary injection.
    let private = RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 1024).expect("keygen");
    let pem = private
        .to_public_key()
        .to_public_key_pem(LineEnding::LF)
        .expect("pem");
    let key = "0123456789abcdef";
    let wrapped = wrap_key_with_pem(&pem, key).expect("wrap");
    // `Pkcs1v15Encrypt` decryption verifies the `00 02 … 00` padding shape
    // (including the >= 8 nonzero pad bytes) before releasing the payload.
    let recovered = private
        .decrypt(Pkcs1v15Encrypt, &B64.decode(&wrapped).expect("b64"))
        .expect("pkcs1 v1.5 decrypt");
    assert_eq!(recovered, key.as_bytes());
    let encrypted = omni_crypto::qoder::encrypt_user_info("synthetic 雪", key).expect("aes");
    assert_eq!(aes_decrypt(&encrypted, &recovered), "synthetic 雪");
    // The pinned envelope from the shipped-key test decrypts the same way.
    let pinned = encrypt_auth(r#"{"uid":"synthetic"}"#, key).expect("encrypt");
    assert_eq!(
        aes_decrypt(&pinned.encrypt_user_info, key.as_bytes()),
        r#"{"uid":"synthetic"}"#
    );
}

#[test]
fn inference_origins_reject_credentials_ports_paths_and_hostile_suffixes() {
    for host in ["api1", "api2", "api3"] {
        let value = JsValue::from(&json!(format!("https://{host}.qoder.sh/")));
        assert_eq!(
            trusted_inference_origin(&value).as_deref(),
            Some(format!("https://{host}.qoder.sh").as_str())
        );
    }
    for bad in [
        json!(null),
        json!(1),
        json!("http://api1.qoder.sh"),
        json!("https://api1.qoder.sh.evil.test"),
        json!("https://evil.test/api1.qoder.sh"),
        json!("https://user@api1.qoder.sh"),
        json!("https://api1.qoder.sh:444"),
        json!("https://api1.qoder.sh/path"),
        json!("https://api1.qoder.sh?x"),
        json!("https://api1.qoder.sh#x"),
        json!("https://api1.qoder.sh\n"),
        json!("https://api1.qoder.sh/../"),
        json!("https://api1.qoder.sh?"),
    ] {
        assert_eq!(
            trusted_inference_origin(&JsValue::from(&bad)),
            None,
            "accepted {bad:?}"
        );
    }
    // The server-json helper is the same one the finish chain reads; a
    // lossless parse must keep the record's own key order.
    let parsed = decode_server_json(r#"{"b":1,"a":2}"#).expect("plain");
    assert_eq!(
        jsjson::stringify(&parsed).as_deref(),
        Some(r#"{"b":1,"a":2}"#)
    );
}
