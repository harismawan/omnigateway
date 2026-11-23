//! The synthetic agent identity xAI's client derives from a machine hash.
use serde_json::{Map, Value};

/// A synthetic-but-stable agent identity.
///
/// Deliberately not read from the host, for the same reason as kimi: a
/// hostname is routinely the operator's own name or their employer's asset
/// tag, and it would go upstream on every request. The value is made up once
/// at connect time and then frozen onto the credential — upstream needs it
/// stable, not true.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrokDevice {
    pub agent_id: String,
}

pub fn mint() -> GrokDevice {
    GrokDevice {
        agent_id: omni_crypto::codex::random_uuid_v4(),
    }
}

/// `grokDeviceHeaders`: nothing without a non-empty string `agentId`.
/// Credentials created before the field existed carry nothing, and an API-key
/// credential never sends the header at all — only the OAuth flow mints an
/// id, and api.x.ai neither expects it nor knows what it means.
pub fn headers(provider_data: &Map<String, Value>) -> Vec<(String, String)> {
    let Some(agent_id) = provider_data
        .get("agentId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Vec::new();
    };
    vec![("x-grok-agent-id".into(), agent_id.into())]
}
