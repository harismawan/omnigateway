//! Where a Qoder credential's inference goes. Both ends need the same check:
//! the finish chain validates the origin it elects before storing it, and the
//! codec validates what it reads back before attaching a signed credential.
//!
//! The comparison is against raw text, not a parsed URL: normalization would
//! hide dot paths, whitespace and empty queries.

use omni_ir::jsjson::JsValue;

/// The only inference origins the shipped CLI trusts.
pub const INFERENCE_ORIGINS: [&str; 3] = [
    "https://api1.qoder.sh",
    "https://api2.qoder.sh",
    "https://api3.qoder.sh",
];

/// `trustedInferenceOrigin`: one trailing slash is tolerated, nothing else.
pub fn trusted_inference_origin(value: &JsValue) -> Option<String> {
    match value {
        JsValue::String(s) => trusted_str(&String::from_utf16_lossy(s)),
        _ => None,
    }
}

/// The string form, for origins read back out of stored `providerData`.
pub fn trusted_str(value: &str) -> Option<String> {
    let origin = value.strip_suffix('/').unwrap_or(value);
    INFERENCE_ORIGINS
        .contains(&origin)
        .then(|| origin.to_owned())
}
