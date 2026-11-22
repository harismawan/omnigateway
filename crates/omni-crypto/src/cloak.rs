//! xxHash64 and the tool-name cloak suffixes built on it.

const P1: u64 = 0x9E37_79B1_85EB_CA87;
const P2: u64 = 0xC2B2_AE3D_27D4_EB4F;
const P3: u64 = 0x1656_67B1_9E37_79F9;
const P4: u64 = 0x85EB_CA77_C2B2_AE63;
const P5: u64 = 0x27D4_EB2F_1656_67C5;

fn round(acc: u64, lane: u64) -> u64 {
    acc.wrapping_add(lane.wrapping_mul(P2))
        .rotate_left(31)
        .wrapping_mul(P1)
}
fn merge(acc: u64, v: u64) -> u64 {
    (acc ^ round(0, v)).wrapping_mul(P1).wrapping_add(P4)
}
fn u64_at(b: &[u8], i: usize) -> u64 {
    let mut word = [0u8; 8];
    word.copy_from_slice(&b[i..i + 8]);
    u64::from_le_bytes(word)
}
fn u32_at(b: &[u8], i: usize) -> u64 {
    let mut word = [0u8; 4];
    word.copy_from_slice(&b[i..i + 4]);
    u64::from(u32::from_le_bytes(word))
}

/// xxHash64 of `input`: the reference algorithm (`XXH64` in xxhash.h).
/// Pinned by `tests/data/xxh64.json`.
pub fn xxh64(input: &[u8], seed: u64) -> u64 {
    let len = input.len();
    let mut i = 0;
    let mut h = if len >= 32 {
        let mut v = [
            seed.wrapping_add(P1).wrapping_add(P2),
            seed.wrapping_add(P2),
            seed,
            seed.wrapping_sub(P1),
        ];
        while i + 32 <= len {
            for (lane, acc) in v.iter_mut().enumerate() {
                *acc = round(*acc, u64_at(input, i + lane * 8));
            }
            i += 32;
        }
        let mut h = v[0]
            .rotate_left(1)
            .wrapping_add(v[1].rotate_left(7))
            .wrapping_add(v[2].rotate_left(12))
            .wrapping_add(v[3].rotate_left(18));
        for lane in v {
            h = merge(h, lane);
        }
        h
    } else {
        seed.wrapping_add(P5)
    };
    h = h.wrapping_add(len as u64);
    while i + 8 <= len {
        h = (h ^ round(0, u64_at(input, i)))
            .rotate_left(27)
            .wrapping_mul(P1)
            .wrapping_add(P4);
        i += 8;
    }
    if i + 4 <= len {
        h = (h ^ u32_at(input, i).wrapping_mul(P1))
            .rotate_left(23)
            .wrapping_mul(P2)
            .wrapping_add(P3);
        i += 4;
    }
    for &byte in &input[i..] {
        h = (h ^ u64::from(byte).wrapping_mul(P5))
            .rotate_left(11)
            .wrapping_mul(P1);
    }
    h ^= h >> 33;
    h = h.wrapping_mul(P2);
    h ^= h >> 29;
    h = h.wrapping_mul(P3);
    h ^ (h >> 32)
}

/// xxHash64 of `s`'s UTF-8 bytes.
pub fn xxh64_utf8(s: &str, seed: u64) -> u64 {
    xxh64(s.as_bytes(), seed)
}

const SUFFIX_MASK: u64 = 0xff_ffff;

/// Anthropic's alias suffix: six hex digits of the name, first one uppercased.
pub fn anthropic_suffix(name: &str) -> String {
    let mut hex = format!("{:06x}", xxh64_utf8(name, 0) & SUFFIX_MASK);
    if let Some(first) = hex.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    hex
}

/// Antigravity's alias suffix: six lowercase hex digits.
pub fn antigravity_suffix(name: &str) -> String {
    format!("{:06x}", xxh64_utf8(name, 0) & SUFFIX_MASK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_file_suffix_matches_the_recorded_ts_alias() {
        // `read_file` → `ReadFileEa70ad`: the recorded alias.
        assert_eq!(anthropic_suffix("read_file"), "Ea70ad");
        assert_eq!(antigravity_suffix("read_file"), "ea70ad");
    }
}
