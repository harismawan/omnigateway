//! Reader reports; SQL expressions are selected only from validated dimensions.
use crate::api::Failure;
use omni_ir::jsjson::{JsValue, write_number};
use omni_store::SqliteStore;
use rusqlite::types::{Value, ValueRef};

fn trim(s: &str) -> &str {
    s.trim_matches(|c: char| matches!(c, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

fn dimension(grain: &str, value: &str) -> Result<&'static str, Failure> {
    let column = match value {
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
    };
    Ok(column)
}

fn label(cell: ValueRef<'_>) -> String {
    let text = match cell {
        ValueRef::Null => String::new(),
        ValueRef::Text(s) => String::from_utf8_lossy(s).into_owned(),
        ValueRef::Blob(b) => b.iter().map(u8::to_string).collect::<Vec<_>>().join(","),
        ValueRef::Integer(n) => {
            let mut s = String::new();
            #[allow(clippy::cast_precision_loss)]
            write_number(n as f64, &mut s);
            s
        }
        ValueRef::Real(n) => {
            let mut s = String::new();
            write_number(n, &mut s);
            s
        }
    };
    if text.is_empty() {
        "unknown".into()
    } else {
        text
    }
}

/// Frozen `queryUsage` and SQLite `aggregate`, on the independent control reader.
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
    let daily = grain == "daily";
    let mut since = number("since", 0.0);
    if daily {
        #[allow(clippy::cast_precision_loss)]
        let offset = store.day_offset_minutes() as f64 * 60_000.0;
        since = ((since + offset) / 86_400_000.0).floor() * 86_400_000.0 - offset;
    }
    let mut bindings = vec![Value::Real(since), Value::Real(number("until", now))];
    let mut filters = String::new();
    for (col, value) in [("api_key_id", api_key), ("credential_id", credential)] {
        if let Some(value) = value {
            filters.push_str(&format!(" AND {col} = ?"));
            bindings.push(Value::Text(value));
        }
    }
    let measures = if daily {
        "COALESCE(SUM(requests),0), COALESCE(SUM(errors),0), COALESCE(SUM(duration_ms_sum),0)"
    } else {
        "COUNT(*), COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0), COALESCE(SUM(duration_ms),0)"
    };
    let sql = format!(
        "SELECT {key}, {}, {measures}, COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(cache_read_tokens),0), COALESCE(SUM(cache_write_tokens),0), COALESCE(SUM({}),0), COALESCE(SUM({}),0), COALESCE(SUM(cost_usd),0) FROM {} WHERE {}{} >= ? AND {} <= ?{filters} GROUP BY {key}{} ORDER BY 3 DESC",
        split.unwrap_or("NULL"),
        if daily {
            "rtk_saved_tokens"
        } else {
            "rtk_estimated_tokens_saved"
        },
        if daily {
            "rtk_applied_requests"
        } else {
            "CASE WHEN rtk_applied = 1 THEN 1 ELSE 0 END"
        },
        if daily { "usage_daily" } else { "request_logs" },
        if daily { "" } else { "state = 'done' AND " },
        if daily { "day" } else { "at" },
        if daily { "day" } else { "at" },
        split.map(|s| format!(", {s}")).unwrap_or_default()
    );
    let mut stmt = store
        .connection()
        .prepare(&sql)
        .map_err(Failure::internal)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(bindings), |r| {
            let mut fields = vec![(
                "key".encode_utf16().collect(),
                JsValue::String(label(r.get_ref(0)?).encode_utf16().collect()),
            )];
            for (name, col) in [
                ("requests", 2),
                ("inputTokens", 5),
                ("outputTokens", 6),
                ("cacheReadTokens", 7),
                ("cacheWriteTokens", 8),
                ("rtkSavedTokens", 9),
                ("rtkAppliedRequests", 10),
                ("costUsd", 11),
                ("errors", 3),
                ("durationMsSum", 4),
            ] {
                fields.push((
                    name.encode_utf16().collect(),
                    JsValue::Number(r.get::<_, f64>(col)?),
                ));
            }
            if split.is_some() {
                fields.push((
                    "split".encode_utf16().collect(),
                    JsValue::String(label(r.get_ref(1)?).encode_utf16().collect()),
                ));
            }
            Ok(JsValue::Object(fields))
        })
        .map_err(Failure::internal)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(Failure::internal)?;
    Ok(JsValue::Object(vec![(
        "rows".encode_utf16().collect(),
        JsValue::Array(rows),
    )]))
}
