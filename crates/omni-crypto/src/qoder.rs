//! Qoder's wire encoding and signatures (`packages/providers/src/qoder/`).
//!
//! The RSA half of the `Cosy-Key` wrapping is randomised PKCS#1 v1.5 padding
//! and lives with the provider, where the embedded public key is.

use aes::cipher::{BlockModeEncrypt as _, KeyIvInit as _, block_padding::Pkcs7};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use md5::{Digest as _, Md5};

const STANDARD: &[u8; 65] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const QODER: &[u8; 65] = b"_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!$";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("Invalid Qoder encoding")]
pub struct InvalidEncoding;

/// Moves the last third to the front: `last n + middle + first n`. Its own inverse.
fn swap_thirds(value: &[u8]) -> Vec<u8> {
    let n = value.len() / 3;
    if n == 0 {
        return value.to_vec();
    }
    let len = value.len();
    let mut out = Vec::with_capacity(len);
    out.extend_from_slice(&value[len - n..]);
    out.extend_from_slice(&value[n..len - n]);
    out.extend_from_slice(&value[..n]);
    out
}

fn translate(input: &[u8], from: &[u8; 65], to: &[u8; 65]) -> Result<Vec<u8>, InvalidEncoding> {
    input
        .iter()
        .map(|c| {
            from.iter()
                .position(|f| f == c)
                .map(|i| to[i])
                .ok_or(InvalidEncoding)
        })
        .collect()
}

pub fn encode_body(plain: &str) -> String {
    let base64 = B64.encode(plain.as_bytes());
    let swapped = translate(base64.as_bytes(), STANDARD, QODER).unwrap_or_default();
    String::from_utf8(swap_thirds(&swapped)).unwrap_or_default()
}

/// The inverse of [`encode_body`], strict: the base64 must be canonical and
/// the bytes valid UTF-8, as the TS decoder requires.
pub fn decode_body(encoded: &str) -> Result<String, InvalidEncoding> {
    if !encoded.len().is_multiple_of(4) {
        return Err(InvalidEncoding);
    }
    let chars = translate(&swap_thirds(encoded.as_bytes()), QODER, STANDARD)?;
    // `=` may only appear as one or two trailing pads.
    let body_len = chars.iter().rposition(|c| *c != b'=').map_or(0, |i| i + 1);
    if chars[..body_len].contains(&b'=') || chars.len() - body_len > 2 {
        return Err(InvalidEncoding);
    }
    let bytes = B64.decode(&chars).map_err(|_| InvalidEncoding)?;
    if B64.encode(&bytes).as_bytes() != chars.as_slice() {
        return Err(InvalidEncoding);
    }
    String::from_utf8(bytes).map_err(|_| InvalidEncoding)
}

fn md5_hex(input: &str) -> String {
    crate::hex_lower(&Md5::digest(input.as_bytes()))
}

/// The request signature: MD5 hex over the five fields joined by `\n`.
pub fn sign_auth(auth_base64: &str, key: &str, date: &str, body: &str, path: &str) -> String {
    md5_hex(&[auth_base64, key, date, body, path].join("\n"))
}

/// The anonymous endpoint-election signature the shipped CLI uses.
pub fn sign_anonymous(date: &str) -> String {
    md5_hex(&format!("cosy&d2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==&{date}"))
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("Invalid Qoder encryption key")]
pub struct InvalidKey;

/// `encryptUserInfo`: AES-128-CBC/PKCS#7 with key = IV = the 16 ASCII hex
/// characters of `key`, base64. The CLI's protocol, not a sound scheme.
pub fn encrypt_user_info(user_json: &str, key: &str) -> Result<String, InvalidKey> {
    let valid = key.len() == 16
        && key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !valid {
        return Err(InvalidKey);
    }
    let bytes: [u8; 16] = key.as_bytes().try_into().map_err(|_| InvalidKey)?;
    let cipher = cbc::Encryptor::<aes::Aes128>::new(&bytes.into(), &bytes.into());
    Ok(B64.encode(cipher.encrypt_padded_vec::<Pkcs7>(user_json.as_bytes())))
}
