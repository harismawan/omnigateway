//! Byte-exact crypto and hashing contracts shared with the TS build.
//!
//! A difference from the TS output is a wire or storage incompatibility,
//! never a style choice.

pub mod apikey;
pub mod cch;
pub mod cloak;
pub mod codex;
pub mod field;
pub mod password;
pub mod qoder;
pub mod session;

pub(crate) fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from(HEX[usize::from(b >> 4)]));
        out.push(char::from(HEX[usize::from(b & 0xf)]));
    }
    out
}
