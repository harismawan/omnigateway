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

/// `crypto.timingSafeEqual` after a length check: unequal lengths are
/// `false` at once (the length is not secret), equal lengths are compared in
/// time independent of where they differ. `black_box` keeps the optimizer from
/// turning the folded difference into an early exit.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let diff = a
        .iter()
        .zip(b)
        .fold(0u8, |acc, (x, y)| std::hint::black_box(acc | (x ^ y)));
    std::hint::black_box(diff) == 0
}

/// Lowercase hex of `bytes` (`Buffer.toString("hex")`).
pub fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from(HEX[usize::from(b >> 4)]));
        out.push(char::from(HEX[usize::from(b & 0xf)]));
    }
    out
}

#[cfg(test)]
mod ct_tests {
    #[test]
    fn constant_time_eq_matches_equality() {
        assert!(super::ct_eq(b"Bearer abc", b"Bearer abc"));
        assert!(!super::ct_eq(b"Bearer abc", b"Bearer abd"));
        assert!(!super::ct_eq(b"Bearer abc", b"Bearer ab"));
        assert!(!super::ct_eq(b"x", b""));
        assert!(super::ct_eq(b"", b""));
        // A difference in the first byte only still fails.
        assert!(!super::ct_eq(b"\x00rest", b"\x01rest"));
    }
}
