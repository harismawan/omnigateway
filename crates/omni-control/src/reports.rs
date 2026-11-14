//! Validation for reader reports; aggregate SQL belongs to omni-store.
use crate::api::Failure;
use omni_ir::js::trim;
use omni_store::{SqliteStore, reports::UsageQuery};

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

/// `GET /api/usage`'s body: `{"rows":[…]}`, as `JSON.stringify` writes it.
pub fn usage(store: &SqliteStore, query: &str, now: f64) -> Result<String, Failure> {
    scoped_usage(store, query, now, None)
}

/// Only the five public filters are forwarded; identity comes from the session.
pub fn client_usage(
    store: &SqliteStore,
    query: &str,
    now: f64,
    id: &str,
) -> Result<String, Failure> {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(
            url::form_urlencoded::parse(query.as_bytes()).filter(|(k, _)| {
                matches!(
                    k.as_ref(),
                    "grain" | "groupBy" | "splitBy" | "since" | "until"
                )
            }),
        )
        .finish();
    scoped_usage(store, &query, now, Some(id))
}

fn scoped_usage(
    store: &SqliteStore,
    query: &str,
    now: f64,
    scope: Option<&str>,
) -> Result<String, Failure> {
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
    if scope.is_some() && (key == "credential_id" || split == Some("credential_id")) {
        return Err(Failure::bad(
            "this dimension is not available on this surface",
        ));
    }
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
    let api_key = scope
        .map(str::to_owned)
        .or(id("apiKeyId", "apiKeyId must be a key id")?);
    let number = |name: &str, default: f64| {
        get(name)
            .filter(|s| !trim(s).is_empty())
            .map(omni_ir::js::string_to_number)
            .filter(|n| n.is_finite())
            .unwrap_or(default)
    };
    let mut out = if scope.is_some() {
        String::new()
    } else {
        String::from("{\"rows\":")
    };
    omni_store::reports::usage_json(
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
        &mut out,
    )?;
    if scope.is_none() {
        out.push('}');
    }
    Ok(out)
}
pub fn nodes(store: &omni_store::SqliteStore, now: i64, node_id: &str) -> Result<String, Failure> {
    use omni_ir::jsjson::{JsValue, stringify};
    let mut rows = omni_store::reports::nodes(store, now).map_err(Failure::internal)?;
    let own = JsValue::String(node_id.encode_utf16().collect());
    for row in &mut rows {
        if let JsValue::Object(fields) = row {
            let is_self = fields.first().is_some_and(|(_, id)| id == &own);
            fields.push(("self".encode_utf16().collect(), JsValue::Bool(is_self)));
        }
    }
    Ok(stringify(&JsValue::Object(vec![(
        "nodes".encode_utf16().collect(),
        JsValue::Array(rows),
    )]))
    .unwrap_or_default())
}
