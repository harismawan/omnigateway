//! Gateway API keys.
//!
//! `sk-omni-` + unpadded base64url of 32 CSPRNG bytes. Stored as an unsalted
//! SHA-256 hex digest: the key is 256 bits of entropy, so a slow hash would buy
//! nothing and cost every proxied request.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::Rng as _;
use sha2::{Digest as _, Sha256};

pub const PREFIX: &str = "sk-omni-";
/// `api_keys.prefix` holds this many leading characters of the raw key.
pub const PREFIX_COLUMN_CHARS: usize = 12;

/// A fresh key, shown to the operator once.
pub fn generate() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(bytes))
}

/// `api_keys.hash`: lowercase hex SHA-256 of the UTF-8 key.
pub fn hash(raw: &str) -> String {
    crate::hex_lower(&Sha256::digest(raw.as_bytes()))
}

/// `api_keys.prefix`: the first 12 UTF-16 code units of the raw key.
pub fn prefix(raw: &str) -> String {
    let units: Vec<u16> = raw.encode_utf16().take(PREFIX_COLUMN_CHARS).collect();
    String::from_utf16_lossy(&units)
}
