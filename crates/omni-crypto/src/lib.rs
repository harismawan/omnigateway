//! Byte-exact crypto and hashing contracts shared with the TS build.
//!
//! Every function here has vectors exported from TypeScript
//! (`conformance/vectors/vectors.json`). A difference is a wire or storage
//! incompatibility, never a style choice.

pub mod apikey;
pub mod cch;
pub mod cloak;
pub mod codex;
pub mod field;
pub mod qoder;

pub(crate) fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from(HEX[usize::from(b >> 4)]));
        out.push(char::from(HEX[usize::from(b & 0xf)]));
    }
    out
}
