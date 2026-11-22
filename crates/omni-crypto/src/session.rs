//! Console session tokens.
//!
//! A token is unpadded base64url of 32 CSPRNG bytes. It is never stored:
//! sessions are keyed on `sess:<kind>:<sha256hex(token)>`, the digest taken
//! over the token's UTF-8 bytes, so the key schema is shared with a later
//! cluster coordinator.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::Rng as _;

/// `PREFIX`: every session key starts with it.
pub const PREFIX: &str = "sess:";

/// A fresh session token.
pub fn token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `sessionKey(kind, token)`.
pub fn key(kind: &str, token: &str) -> String {
    format!("{PREFIX}{kind}:{}", crate::apikey::hash(token))
}

/// The prefix that holds every session of one kind (`dropKind`).
pub fn kind_prefix(kind: &str) -> String {
    format!("{PREFIX}{kind}:")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_unpadded_base64url_of_32_bytes() {
        let a = token();
        assert_eq!(a.len(), 43);
        assert!(
            a.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        );
        assert_ne!(a, token());
    }

    #[test]
    fn keys_are_the_ts_schema() {
        // sha256("abc")
        assert_eq!(
            key("admin", "abc"),
            "sess:admin:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // UTF-8 of the string, as `CryptoHasher.update(string)` hashes it.
        assert_eq!(
            key("viewer", "é"),
            format!("sess:viewer:{}", crate::apikey::hash("é"))
        );
        assert_eq!(kind_prefix("client"), "sess:client:");
    }
}
