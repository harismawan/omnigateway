//! Crypto and hashing parity against vectors exported from the TS build.

use omni_crypto::field;
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
