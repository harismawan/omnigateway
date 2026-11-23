//! The RSA half of Qoder's auth envelope. The AES half, the body encoding and
//! the signatures live in [`omni_crypto::qoder`]; only the randomized PKCS#1
//! v1.5 key wrapping needs the embedded public key, so it lives here.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use rsa::pkcs8::DecodePublicKey as _;
use rsa::{Pkcs1v15Encrypt, RsaPublicKey};

/// Public wrapping key shipped in Qoder CLI 1.1.82 (not the profile-storage key).
pub const QODER_PUBLIC_KEY: &str = "-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----";

/// The auth envelope: the AES-encrypted user info and the wrapped AES key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope {
    pub encrypt_user_info: String,
    pub key: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptoError {
    #[error("Invalid Qoder encryption key")]
    InvalidKey,
    #[error("Invalid Qoder public key")]
    InvalidPublicKey,
}

/// `encryptAuth`: AES-128-CBC with key = IV (the CLI's wire protocol, not a
/// general-purpose scheme), then the 16 key bytes wrapped with RSA PKCS#1 v1.5.
pub fn encrypt_auth(user_json: &str, key: &str) -> Result<Envelope, CryptoError> {
    let encrypt_user_info = omni_crypto::qoder::encrypt_user_info(user_json, key)
        .map_err(|_| CryptoError::InvalidKey)?;
    Ok(Envelope {
        encrypt_user_info,
        key: wrap_key_with_pem(QODER_PUBLIC_KEY, key)?,
    })
}

/// `wrap_key` against the shipped public key.
pub fn wrap_key(key: &str) -> Result<String, CryptoError> {
    wrap_key_with_pem(QODER_PUBLIC_KEY, key)
}

/// The wrapping under a caller-supplied PEM, so tests can round-trip against
/// a private key they hold. The payload is the key's 16 ASCII bytes, exactly
/// what the CLI encrypts.
pub fn wrap_key_with_pem(pem: &str, key: &str) -> Result<String, CryptoError> {
    if key.len() != 16
        || !key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(CryptoError::InvalidKey);
    }
    let public =
        RsaPublicKey::from_public_key_pem(pem).map_err(|_| CryptoError::InvalidPublicKey)?;
    let mut rng = rsa::rand_core::OsRng;
    let wrapped = public
        .encrypt(&mut rng, Pkcs1v15Encrypt, key.as_bytes())
        .map_err(|_| CryptoError::InvalidPublicKey)?;
    Ok(B64.encode(wrapped))
}
