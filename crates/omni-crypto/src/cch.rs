//! The Claude CLI's billing checksum and `cc_version` suffix
//! (`packages/providers/src/body.ts`).

use crate::cloak::xxh64_utf8;
use sha2::{Digest as _, Sha256};

pub const CCH_SEED: u64 = 0x6e52_736a_c806_831e;
const CCH_MASK: u64 = 0xf_ffff;
pub const CCH_PLACEHOLDER: &str = "00000";
const CCV_SALT: &str = "59cf53e54c78";
/// `ANTHROPIC_CLI_VERSION` without an `OMNI_ANTHROPIC_CLI_VERSION` override.
pub const DEFAULT_CLI_VERSION: &str = "2.1.296";
pub const BILLING_PREFIX: &str = "x-anthropic-billing-header:";

/// xxHash64 of the body, masked to 20 bits, as five zero-padded hex digits.
pub fn compute(body: &str) -> String {
    format!("{:05x}", xxh64_utf8(body, CCH_SEED) & CCH_MASK)
}

/// Replaces the placeholder inside the system billing block with the token
/// computed over the body *containing* the placeholder. Both are five
/// characters, so the hashed bytes are the bytes sent.
///
/// Only the occurrence after the billing anchor is replaced: a tool result
/// quoting `cch=00000;` earlier in `messages` must keep its text.
pub fn sign_anthropic_body(json: &str) -> String {
    let anchor = format!("\"system\":[{{\"type\":\"text\",\"text\":\"{BILLING_PREFIX}");
    let needle = format!("cch={CCH_PLACEHOLDER};");
    let Some(anchor_at) = json.find(&anchor) else {
        return json.to_owned();
    };
    let Some(relative) = json[anchor_at..].find(&needle) else {
        return json.to_owned();
    };
    let at = anchor_at + relative;
    let token = compute(json);
    let mut out = String::with_capacity(json.len());
    out.push_str(&json[..at]);
    out.push_str("cch=");
    out.push_str(&token);
    out.push(';');
    out.push_str(&json[at + needle.len()..]);
    out
}

/// The three hex digits after the version in `cc_version`.
///
/// The CLI picks the first user message's characters at 4, 7 and 20 —
/// **UTF-16 code units**, as JS string indexing gives them, with `"0"` where
/// the text is shorter — then hashes salt + picks + version with SHA-256. A
/// lone surrogate picked out of a pair is encoded as U+FFFD, as `TextEncoder`
/// does.
pub fn cc_version_suffix(first_user_text: &[u16], cli_version: &str) -> String {
    let mut seed = String::with_capacity(CCV_SALT.len() + 12 + cli_version.len());
    seed.push_str(CCV_SALT);
    // JS joins the picked code units before UTF-8 encoding. Adjacent picks
    // can therefore form a surrogate pair even when separated in the source.
    let picked = [4usize, 7, 20].map(|index| {
        first_user_text
            .get(index)
            .copied()
            .unwrap_or(u16::from(b'0'))
    });
    seed.push_str(&String::from_utf16_lossy(&picked));
    seed.push_str(cli_version);
    let digest = Sha256::digest(seed.as_bytes());
    crate::hex_lower(&digest[..2])[..3].to_owned()
}
