//! Credential identity only borrows arbitrary JSON; it retains validated strings.
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Secrets {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) installation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) id_salt: Option<String>,
}

pub(crate) fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

// Used by the OAuth codec/refresh in the next increment; no JSON is cloned.
#[allow(dead_code)]
pub(crate) fn secrets_from(data: &Value) -> Secrets {
    Secrets {
        installation_id: data
            .get("installationId")
            .and_then(Value::as_str)
            .filter(|s| is_uuid(s))
            .map(str::to_owned),
        id_salt: data
            .get("idSalt")
            .and_then(Value::as_str)
            .filter(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
            .map(str::to_owned),
    }
}

#[allow(dead_code)]
pub(crate) fn ensure_with(
    data: &Value,
    uuid: impl FnOnce() -> String,
    salt: impl FnOnce() -> String,
) -> Secrets {
    let stored = secrets_from(data);
    Secrets {
        installation_id: Some(stored.installation_id.unwrap_or_else(uuid)),
        id_salt: Some(stored.id_salt.unwrap_or_else(salt)),
    }
}

/// Randomness is injected separately in the differential; production uses the
/// existing OS-seeded rand dependency. Persistence belongs to OAuth refresh.
#[allow(dead_code)]
pub(crate) fn ensure_secrets(data: &Value) -> Secrets {
    use rand::RngCore as _;
    ensure_with(
        data,
        || {
            let mut bytes = [0u8; 16];
            rand::rng().fill_bytes(&mut bytes);
            bytes[6] = (bytes[6] & 15) | 64;
            bytes[8] = (bytes[8] & 63) | 128;
            let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            format!(
                "{}-{}-{}-{}-{}",
                &h[..8],
                &h[8..12],
                &h[12..16],
                &h[16..20],
                &h[20..]
            )
        },
        || {
            let mut bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut bytes);
            bytes.iter().map(|b| format!("{b:02x}")).collect()
        },
    )
}
