//! The synthetic device identity kimi ties a session to.
use serde_json::{Map, Value, json};

/// A synthetic-but-stable device identity.
///
/// Deliberately not read from the host: the operator's hostname is often their
/// name or their employer's asset tag, and it would go upstream on every
/// request. These values are made up once at connect time and then frozen onto
/// the credential — upstream only needs them to be stable, not true.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KimiDevice {
    pub device_id: String,
    pub device_name: String,
    pub device_model: String,
    pub os_version: String,
}

pub fn mint() -> KimiDevice {
    KimiDevice {
        device_id: omni_crypto::codex::uuid_v4_from(&crate::oauth::random_state()),
        device_name: "MacBook-Pro".into(),
        device_model: "MacBookPro18,3".into(),
        os_version: "15.3.1".into(),
    }
}

/// `deviceFrom`: reads a persisted identity back, minting a fresh one if it is
/// absent. Credentials created before the descriptive fields existed carry
/// only `deviceId`; the missing fields take a fresh mint's values.
pub fn from_data(source: Option<&Map<String, Value>>) -> KimiDevice {
    let field = |key: &str| {
        source
            .and_then(|s| s.get(key))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    if let Some(device_id) = field("deviceId") {
        let fresh = mint();
        return KimiDevice {
            device_id: device_id.into(),
            device_name: field("deviceName").unwrap_or(&fresh.device_name).into(),
            device_model: field("deviceModel").unwrap_or(&fresh.device_model).into(),
            os_version: field("osVersion").unwrap_or(&fresh.os_version).into(),
        };
    }
    mint()
}

impl KimiDevice {
    /// The identity as it is frozen onto a credential's `providerData`.
    pub fn map(&self) -> Map<String, Value> {
        let mut out = Map::new();
        omni_ir::deep::insert(&mut out, "deviceId".into(), json!(self.device_id));
        omni_ir::deep::insert(&mut out, "deviceName".into(), json!(self.device_name));
        omni_ir::deep::insert(&mut out, "deviceModel".into(), json!(self.device_model));
        omni_ir::deep::insert(&mut out, "osVersion".into(), json!(self.os_version));
        out
    }

    pub fn headers(&self) -> Vec<(String, String)> {
        headers(&self.map())
    }
}

/// `kimiDeviceHeaders`: nothing without a non-empty string `deviceId`; the
/// descriptive fields fall back to `"unknown"` so a credential minted before
/// they existed keeps claiming the device it always claimed to be.
pub fn headers(provider_data: &Map<String, Value>) -> Vec<(String, String)> {
    let Some(device_id) = provider_data
        .get("deviceId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Vec::new();
    };
    let str_or_unknown = |key: &str| {
        provider_data
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or("unknown")
            .to_owned()
    };
    vec![
        ("X-Msh-Device-Id".into(), device_id.into()),
        ("X-Msh-Device-Name".into(), str_or_unknown("deviceName")),
        ("X-Msh-Device-Model".into(), str_or_unknown("deviceModel")),
        ("X-Msh-Os-Version".into(), str_or_unknown("osVersion")),
    ]
}
