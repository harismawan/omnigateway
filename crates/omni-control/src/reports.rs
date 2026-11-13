//! Validation for reader reports; aggregate SQL belongs to omni-store.
use crate::api::Failure;
use omni_ir::jsjson::JsValue;
use omni_store::{SqliteStore, reports::UsageQuery};

fn trim(s: &str) -> &str {
    s.trim_matches(|c: char| matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

fn dimension(grain: &str, value: &str) -> Result<&'static str, Failure> {
    Ok(match value {
        "credential" => "credential_id",
        "model" => "resolved_model",
        "requestedModel" => "requested_model",
        "apiKey" => "api_key_id",
        "provider" => {
            if grain == "raw" {
                "resolved_provider"
            } else {
                "provider"
            }
        }
        "hour" if grain == "raw" => "CAST(at / 3600000 AS INTEGER)",
        "day" if grain == "daily" => "day",
        "hour" | "day" => {
            return Err(Failure::bad(format!(
                "usage grain \"{grain}\" cannot group by \"{value}\""
            )));
        }
        _ => {
            return Err(Failure::bad(
                "(root): Invalid option: expected one of \"credential\"|\"model\"|\"requestedModel\"|\"apiKey\"|\"provider\"|\"hour\"|\"day\"",
            ));
        }
    })
}

pub fn usage(store: &SqliteStore, query: &str, now: f64) -> Result<JsValue, Failure> {
    let pairs = url::form_urlencoded::parse(query.as_bytes()).collect::<Vec<_>>();
    let get = |name: &str| {
        pairs
            .iter()
            .rev()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_ref())
    };
    let grain = get("grain").unwrap_or("raw");
    if !matches!(grain, "raw" | "daily") {
        return Err(Failure::bad(
            "(root): Invalid option: expected one of \"raw\"|\"daily\"",
        ));
    }
    let key = dimension(grain, get("groupBy").unwrap_or("model"))?;
    let split = get("splitBy").map(|s| dimension(grain, s)).transpose()?;
    let id = |name: &str, message: &str| -> Result<Option<String>, Failure> {
        get(name)
            .map(|v| {
                let v = trim(v);
                if v.is_empty()
                    || v.len() > 64
                    || !v
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                {
                    Err(Failure::bad(format!("(root): {message}")))
                } else {
                    Ok(v.to_owned())
                }
            })
            .transpose()
    };
    let credential = id("credentialId", "credentialId must be an account id")?;
    let api_key = id("apiKeyId", "apiKeyId must be a key id")?;
    let number = |name: &str, default: f64| {
        get(name)
            .filter(|s| !trim(s).is_empty())
            .map(omni_ir::js::string_to_number)
            .filter(|n| n.is_finite())
            .unwrap_or(default)
    };
    let rows = omni_store::reports::usage(
        store,
        UsageQuery {
            daily: grain == "daily",
            key,
            split,
            since: number("since", 0.0),
            until: number("until", now),
            api_key,
            credential,
        },
    )?;
    Ok(JsValue::Object(vec![(
        "rows".encode_utf16().collect(),
        JsValue::Array(rows),
    )]))
}
