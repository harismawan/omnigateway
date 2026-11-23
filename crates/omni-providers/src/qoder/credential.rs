//! The credential bundle JSON-stringified into `accessToken`. Strict parse:
//! this is the read that attaches a signed credential to an origin, so every
//! field is validated here rather than trusted from storage.

use omni_ir::jsjson::{JsValue, parse_js};

use super::endpoint::trusted_inference_origin;
use super::model_catalog::QoderModel;

/// `QoderCredentialBundle`.
#[derive(Debug, Clone, PartialEq)]
pub struct Bundle {
    pub device_token: String,
    pub uid: String,
    pub machine_id: String,
    pub encrypt_user_info: String,
    pub key: String,
    pub issued_at: f64,
    pub origin: String,
    pub models: Vec<QoderModel>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("Invalid Qoder credential")]
pub struct InvalidCredential;

/// Header-safe: non-empty, no control characters (per UTF-16 unit, as the TS
/// regex tests them).
fn header_safe(value: Option<&JsValue>) -> Option<String> {
    match value {
        Some(JsValue::String(s)) if !s.is_empty() && s.iter().all(|u| *u >= 0x20 && *u != 0x7f) => {
            Some(String::from_utf16_lossy(s))
        }
        _ => None,
    }
}

fn safe_positive_integer(value: Option<&JsValue>) -> Option<f64> {
    match value {
        Some(JsValue::Number(n))
            if n.is_finite() && n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0 =>
        {
            Some(*n)
        }
        _ => None,
    }
}

/// `parseCredential`: version 1, a trusted origin, a positive safe-integer
/// `issuedAt`, five header-safe secret strings and at most 500 well-formed
/// model rows. Anything else is one error, never a partial bundle.
pub fn parse(value: &str) -> Result<Bundle, InvalidCredential> {
    let b = parse_js(value).map_err(|_| InvalidCredential)?;
    if !b.is_object() {
        return Err(InvalidCredential);
    }
    if b.get("version") != Some(&JsValue::Number(1.0)) {
        return Err(InvalidCredential);
    }
    let Some(origin) = b.get("origin").and_then(trusted_inference_origin) else {
        return Err(InvalidCredential);
    };
    let Some(issued_at) = safe_positive_integer(b.get("issuedAt")) else {
        return Err(InvalidCredential);
    };
    let field = |name: &str| header_safe(b.get(name)).ok_or(InvalidCredential);
    let device_token = field("deviceToken")?;
    let uid = field("uid")?;
    let machine_id = field("machineId")?;
    let encrypt_user_info = field("encryptUserInfo")?;
    let key = field("key")?;
    let Some(JsValue::Array(rows)) = b.get("models") else {
        return Err(InvalidCredential);
    };
    if rows.len() > 500 {
        return Err(InvalidCredential);
    }
    let mut models = Vec::with_capacity(rows.len());
    for row in rows {
        if !row.is_object() {
            return Err(InvalidCredential);
        }
        let Some(JsValue::String(key_units)) = row.get("key") else {
            return Err(InvalidCredential);
        };
        if key_units.is_empty()
            || key_units.len() > 200
            || key_units.iter().any(|u| *u < 0x20 || *u == 0x7f)
        {
            return Err(InvalidCredential);
        }
        let Some(JsValue::String(name_units)) = row.get("displayName") else {
            return Err(InvalidCredential);
        };
        // The TS credential check bounds displayName but does not screen it
        // for control characters; the catalog parser does. Kept verbatim.
        if name_units.is_empty() || name_units.len() > 200 {
            return Err(InvalidCredential);
        }
        let (Some(JsValue::Bool(images)), Some(JsValue::Bool(reasoning))) =
            (row.get("images"), row.get("reasoning"))
        else {
            return Err(InvalidCredential);
        };
        let max_input_tokens = match row.get("maxInputTokens") {
            None | Some(JsValue::Undefined) => None,
            some => Some(safe_positive_integer(some).ok_or(InvalidCredential)?),
        };
        models.push(QoderModel {
            key: String::from_utf16_lossy(key_units),
            display_name: String::from_utf16_lossy(name_units),
            images: *images,
            reasoning: *reasoning,
            max_input_tokens,
        });
    }
    Ok(Bundle {
        device_token,
        uid,
        machine_id,
        encrypt_user_info,
        key,
        issued_at,
        origin,
        models,
    })
}
