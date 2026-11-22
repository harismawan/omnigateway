//! Credential field encryption.
//!
//! PBKDF2-HMAC-SHA256 over the raw `OMNI_ENCRYPTION_KEY`, salt
//! `omnigateway-field-encryption-v1`, 210 000 iterations, 32 bytes; then
//! AES-256-GCM with a random 12-byte IV and no AAD, stored as
//! `enc:v1:<iv-hex>:<ciphertext-hex>:<tag-hex>` in lowercase hex.

use aes_gcm::aead::{Aead as _, KeyInit as _};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::Rng as _;

const KDF_SALT: &[u8] = b"omnigateway-field-encryption-v1";
const KDF_ITERATIONS: u32 = 210_000;
const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

/// The derived AES-256-GCM key. Deriving costs ~100 ms by design: do it once.
#[derive(Clone)]
pub struct FieldKey {
    raw: [u8; 32],
}

impl FieldKey {
    /// The raw 32 key bytes, for the body-artifact envelope that shares this key.
    pub fn bytes(&self) -> &[u8; 32] {
        &self.raw
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new((&self.raw).into())
    }
}

impl std::fmt::Debug for FieldKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FieldKey(..)")
    }
}

#[derive(Debug, Clone, Copy, thiserror::Error, PartialEq, Eq)]
pub enum FieldError {
    #[error("malformed ciphertext")]
    Malformed,
    #[error("ciphertext failed authentication")]
    Unauthentic,
    #[error("plaintext is not UTF-8")]
    NotUtf8,
}

pub fn derive_key(secret: &str) -> FieldKey {
    let mut raw = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(secret.as_bytes(), KDF_SALT, KDF_ITERATIONS, &mut raw);
    FieldKey { raw }
}

pub fn encrypt(key: &FieldKey, plaintext: &str) -> String {
    let mut iv = [0u8; IV_BYTES];
    rand::rng().fill_bytes(&mut iv);
    // Encryption with a 32-byte key and 12-byte nonce cannot fail for inputs
    // below GCM's 64 GiB limit; a credential field is never near it.
    let sealed = key
        .cipher()
        .encrypt(&Nonce::from(iv), plaintext.as_bytes())
        .unwrap_or_default();
    let split = sealed.len().saturating_sub(TAG_BYTES);
    let (body, tag) = sealed.split_at(split);
    format!(
        "enc:v1:{}:{}:{}",
        crate::hex_lower(&iv),
        crate::hex_lower(body),
        crate::hex_lower(tag)
    )
}

pub fn is_encrypted(value: &str) -> bool {
    value.starts_with("enc:v1:")
}

/// Lowercase hex only, even length.
pub(crate) fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let digit = |b: u8| match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    };
    s.as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| Some(digit(pair[0])? << 4 | digit(pair[1])?))
        .collect()
}

pub fn decrypt(key: &FieldKey, value: &str) -> Result<String, FieldError> {
    let parts: Vec<&str> = value.split(':').collect();
    let [scheme, version, iv_hex, body_hex, tag_hex] = parts.as_slice() else {
        return Err(FieldError::Malformed);
    };
    if *scheme != "enc" || *version != "v1" || iv_hex.is_empty() || tag_hex.is_empty() {
        return Err(FieldError::Malformed);
    }
    let iv = unhex(iv_hex).ok_or(FieldError::Malformed)?;
    let mut sealed = unhex(body_hex).ok_or(FieldError::Malformed)?;
    sealed.extend(unhex(tag_hex).ok_or(FieldError::Malformed)?);
    // aes-gcm's `Aes256Gcm` is fixed at a 12-byte IV, which is the only
    // length ever written to storage.
    if iv.len() != IV_BYTES {
        return Err(FieldError::Malformed);
    }
    let nonce = Nonce::try_from(iv.as_slice()).map_err(|_| FieldError::Malformed)?;
    let plain = key
        .cipher()
        .decrypt(&nonce, sealed.as_slice())
        .map_err(|_| FieldError::Unauthentic)?;
    String::from_utf8(plain).map_err(|_| FieldError::NotUtf8)
}
