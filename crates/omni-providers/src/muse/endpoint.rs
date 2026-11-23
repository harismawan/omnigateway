//! Where a muse credential's inference goes, and the one check that decides it.
//!
//! Its own module because **both ends need it**. The mint validates the
//! `base_url` it is told before storing it, and the codec validates what it
//! reads back before attaching a decrypted key to it. `providerData` is parsed
//! back out of the database with no schema between, so the credential-bearing
//! read validates for itself, and the two ends cannot disagree because there
//! is one function.

use serde_json::{Map, Value};

/// Endpoints are only honoured under this registrable domain.
const TRUSTED_HOST: &str = "meta.ai";

/// The compiled default, used when a credential names nothing usable.
pub const DEFAULT_BASE_URL: &str = "https://api.meta.ai/v1";

/// The base URL if it is one Meta could have published, else `None`.
///
/// This value decides where a decrypted Model API key is sent, so every part
/// of it is checked rather than just the scheme: **https**, because a bearer
/// token must not cross plaintext, and a host under `meta.ai` matched as
/// `== "meta.ai"` or `.ends_with(".meta.ai")` — with the dot, so `evilmeta.ai`
/// and `meta.ai.attacker.example` are both refused. Userinfo, query and
/// fragment need no check of their own: the value returned is **rebuilt** from
/// origin and pathname, so none of the three can survive into it. A trailing
/// slash is dropped so the caller can append without doubling it.
pub fn trusted_base_url(value: &Value) -> Option<String> {
    trusted_str(value.as_str()?)
}

pub(crate) fn trusted_str(value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    let host = url.host_str()?;
    if host != TRUSTED_HOST && !host.ends_with(&format!(".{TRUSTED_HOST}")) {
        return None;
    }
    let rebuilt = format!("{}{}", url.origin().ascii_serialization(), url.path());
    Some(rebuilt.strip_suffix('/').unwrap_or(&rebuilt).to_owned())
}

/// The Responses endpoint for a credential, falling back to the default.
///
/// Built through the validated origin and path rather than by pasting onto
/// whatever was stored, so a value that somehow carried `..` cannot walk out
/// of the path the URL parser already normalized.
pub fn responses_url(provider_data: &Map<String, Value>) -> String {
    let base = provider_data
        .get("baseUrl")
        .and_then(trusted_base_url)
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
    format!("{base}/responses")
}
