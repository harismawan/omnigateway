//! xxHash64, as `Bun.hash.xxHash64`, and the tool-name cloak suffixes built on it.

use xxhash_rust::xxh64::xxh64;

/// `Bun.hash.xxHash64(Buffer.from(s, "utf8"), seed)`.
pub fn xxh64_utf8(s: &str, seed: u64) -> u64 {
    xxh64(s.as_bytes(), seed)
}

const SUFFIX_MASK: u64 = 0xff_ffff;

/// Anthropic's alias suffix: six hex digits of the name, first one uppercased
/// (`anthropic/cloak.ts` `suffixFor`).
pub fn anthropic_suffix(name: &str) -> String {
    let mut hex = format!("{:06x}", xxh64_utf8(name, 0) & SUFFIX_MASK);
    if let Some(first) = hex.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    hex
}

/// Antigravity's alias suffix: six lowercase hex digits (`antigravity/cloak.ts`).
pub fn antigravity_suffix(name: &str) -> String {
    format!("{:06x}", xxh64_utf8(name, 0) & SUFFIX_MASK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_file_suffix_matches_the_recorded_ts_alias() {
        // `read_file` → `ReadFileEa70ad` in the TS build.
        assert_eq!(anthropic_suffix("read_file"), "Ea70ad");
        assert_eq!(antigravity_suffix("read_file"), "ea70ad");
    }
}
