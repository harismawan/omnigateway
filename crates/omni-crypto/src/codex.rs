//! Codex's derived identifiers (`packages/providers/src/openai/codexIdentity.ts`).

use hmac::{Hmac, KeyInit as _, Mac as _};
use sha1::Sha1;
use sha2::{Digest as _, Sha256};

pub const NAMESPACE_OID: &str = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";

/// `Date.UTC(2026, 9, 1)`: the end of the window derived v7 instants fall in.
const WINDOW_END_MS: u64 = 1_790_812_800_000;
const WINDOW_MS: u64 = 365 * 24 * 60 * 60 * 1000;

fn format_uuid(b: &[u8; 16]) -> String {
    let h = crate::hex_lower(b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn with_version(bytes: &[u8], version: u8) -> [u8; 16] {
    let mut out = [0u8; 16];
    out.copy_from_slice(&bytes[..16]);
    out[6] = (out[6] & 0x0f) | (version << 4);
    out[8] = (out[8] & 0x3f) | 0x80;
    out
}

fn sha256(seed: &str) -> [u8; 32] {
    Sha256::digest(seed.as_bytes()).into()
}

/// The first six bytes, big-endian, as `Buffer.readUIntBE(0, 6)`.
fn read_u48(bytes: &[u8]) -> u64 {
    bytes[..6]
        .iter()
        .fold(0u64, |acc, b| (acc << 8) | u64::from(*b))
}

/// RFC 4122 UUIDv5. `namespace` is hex-decoded after stripping dashes, as TS does.
pub fn uuid_v5(namespace: &str, name: &str) -> String {
    let ns_hex: String = namespace.chars().filter(|c| *c != '-').collect();
    let ns = crate::field::unhex(&ns_hex.to_ascii_lowercase()).unwrap_or_default();
    let mut hasher = Sha1::new();
    hasher.update(&ns);
    hasher.update(name.as_bytes());
    format_uuid(&with_version(&hasher.finalize(), 5))
}

/// `crypto.randomUUID()`: a random v4 UUID in lowercase hex.
pub fn random_uuid_v4() -> String {
    format_uuid(&with_version(&rand::random::<[u8; 16]>(), 4))
}

/// A UUIDv4-shaped digest of `seed`.
pub fn uuid_v4_from(seed: &str) -> String {
    format_uuid(&with_version(&sha256(seed), 4))
}

/// A UUIDv7-shaped id: `timestamp_ms` in the first 48 bits, the rest from a
/// digest of `seed`. `timestamp_ms` is a JS number; negatives clamp to 0 and
/// fractions floor, as `Math.max(0, Math.floor(ts))` does.
pub fn uuid_v7_from(seed: &str, timestamp_ms: f64) -> String {
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&sha256(seed)[..16]);
    let mut ts = timestamp_ms.floor().max(0.0);
    for i in (0..6).rev() {
        // `ts % 256` is an integral value in 0..256.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        {
            bytes[i] = (ts % 256.0) as u8;
        }
        ts = (ts / 256.0).floor();
    }
    format_uuid(&with_version(&bytes, 7))
}

/// A stable thread id for a conversation seed, its instant drawn into the past window.
pub fn thread_id_from(seed: &str) -> String {
    let digest = sha256(&format!("thread:{seed}"));
    let offset = read_u48(&digest) % WINDOW_MS;
    #[allow(clippy::cast_precision_loss)]
    let instant = (WINDOW_END_MS - WINDOW_MS + offset) as f64;
    uuid_v7_from(seed, instant)
}

/// The instant a thread id names: a past v7 is used as is, anything else derived.
pub fn thread_instant(thread_id: &str, now: f64) -> f64 {
    let hex: String = thread_id.chars().filter(|c| *c != '-').collect();
    let is_v7 = hex.as_bytes().get(12) == Some(&b'7');
    // `Number.parseInt(hex.slice(0, 12), 16)` reads the leading hex digits.
    let head: String = hex
        .chars()
        .take(12)
        .take_while(char::is_ascii_hexdigit)
        .collect();
    if is_v7
        && !head.is_empty()
        && let Ok(ts) = u64::from_str_radix(&head, 16)
    {
        #[allow(clippy::cast_precision_loss)]
        let ts = ts as f64;
        if ts <= now {
            return ts;
        }
    }
    let digest = sha256(&format!("thread:{thread_id}"));
    #[allow(clippy::cast_precision_loss)]
    let derived = (WINDOW_END_MS - WINDOW_MS + read_u48(&digest) % WINDOW_MS) as f64;
    derived
}

/// `seed` keyed with the credential's salt: HMAC-SHA256 hex with the salt's
/// **ASCII bytes** as the key (`new Bun.CryptoHasher("sha256", salt)`).
pub fn keyed(salt: Option<&str>, seed: &str) -> String {
    let Some(salt) = salt else {
        return seed.to_owned();
    };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(salt.as_bytes()) else {
        return seed.to_owned();
    };
    mac.update(seed.as_bytes());
    crate::hex_lower(&mac.finalize().into_bytes())
}

/// Codex's per-thread namespace: UUIDv5 of the thread id under `NAMESPACE_OID`.
pub fn prefix_namespace(thread_id: &str) -> String {
    uuid_v5(NAMESPACE_OID, thread_id)
}

#[cfg(test)]
mod random_tests {
    #[test]
    fn random_v4_has_the_rfc_shape_and_differs() {
        let a = super::random_uuid_v4();
        assert_eq!(a.len(), 36);
        assert_eq!(a.matches('-').count(), 4);
        assert_eq!(&a[14..15], "4");
        assert!(matches!(&a[19..20], "8" | "9" | "a" | "b"));
        assert!(
            a.bytes()
                .all(|b| b == b'-' || b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        );
        assert_ne!(a, super::random_uuid_v4());
    }
}
