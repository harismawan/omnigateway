//! Bounded metadata page reader, on the control connection.
use crate::{SqliteStore, StoreError};
use omni_ir::jsjson::{JsValue, parse_js};
use rusqlite::types::{Value, ValueRef};

#[derive(Default, Clone)]
pub struct Query {
    pub since: Option<f64>,
    pub until: Option<f64>,
    pub failed: bool,
    pub state: Option<String>,
    pub provider: Option<String>,
    pub requested_model: Option<String>,
    pub resolved_model: Option<String>,
    pub model: Option<String>,
    pub error_code: Option<String>,
    pub api_key_id: Option<String>,
    pub credential_id: Option<String>,
    pub cursor: Option<(f64, Vec<u16>)>,
    pub internal_cursor: Option<(Value, Value)>,
    pub limit: usize,
}

pub(crate) fn cell(v: ValueRef<'_>) -> JsValue {
    match v {
        ValueRef::Null => JsValue::Null,
        #[allow(clippy::cast_precision_loss)]
        ValueRef::Integer(n) => JsValue::Number(n as f64),
        ValueRef::Real(n) => JsValue::Number(n),
        ValueRef::Text(s) => JsValue::String(String::from_utf8_lossy(s).encode_utf16().collect()),
        ValueRef::Blob(b) => JsValue::Object(
            b.iter()
                .enumerate()
                .map(|(i, n)| {
                    (
                        i.to_string().encode_utf16().collect(),
                        JsValue::Number(f64::from(*n)),
                    )
                })
                .collect(),
        ),
    }
}

pub fn page(store: &SqliteStore, q: &Query) -> Result<Vec<JsValue>, StoreError> {
    page_encoding(store, q, false)
}

/// CSV observes String(Uint8Array), while JSON observes its indexed object.
pub fn page_encoding(
    store: &SqliteStore,
    q: &Query,
    csv: bool,
) -> Result<Vec<JsValue>, StoreError> {
    Ok(export_page(store, q, csv)?.0)
}

pub type ExportPage = (Vec<JsValue>, Option<(Value, Value)>);
pub fn export_page(store: &SqliteStore, q: &Query, csv: bool) -> Result<ExportPage, StoreError> {
    let mut clauses = Vec::new();
    let mut bindings = Vec::new();
    if let Some((at, id)) = &q.internal_cursor {
        clauses.push("(at < ? OR (at = ? AND id < ?))".to_owned());
        bindings.extend([at.clone(), at.clone(), id.clone()]);
    }
    if let Some((at, id)) = &q.cursor {
        // Bun SQLite binds JS strings as UTF-8, replacing lone surrogates.
        // The wire cursor retains UTF-16; only this SQL boundary narrows it.
        clauses.push("(at < ? OR (at = ? AND id < ?))".to_owned());
        bindings.extend([
            Value::Real(*at),
            Value::Real(*at),
            Value::Text(String::from_utf16_lossy(id)),
        ]);
    }
    for (column, value) in [
        ("state", &q.state),
        ("resolved_provider", &q.provider),
        ("api_key_id", &q.api_key_id),
        ("credential_id", &q.credential_id),
    ] {
        if let Some(value) = value {
            clauses.push(format!("{column} = ?"));
            bindings.push(Value::Text(value.clone()));
        }
    }
    for (column, value) in [
        ("requested_model", &q.requested_model),
        ("resolved_model", &q.resolved_model),
        ("error_code", &q.error_code),
        ("", &q.model),
    ] {
        if let Some(value) = value {
            let escaped = format!(
                "%{}%",
                value
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            );
            if column.is_empty() {
                clauses.push(
                    "(requested_model LIKE ? ESCAPE '\\' OR resolved_model LIKE ? ESCAPE '\\')"
                        .into(),
                );
                bindings.push(Value::Text(escaped.clone()));
            } else {
                clauses.push(format!("{column} LIKE ? ESCAPE '\\'"));
            }
            bindings.push(Value::Text(escaped));
        }
    }
    for (op, value) in [(">=", q.since), ("<=", q.until)] {
        if let Some(value) = value {
            clauses.push(format!("at {op} ?"));
            bindings.push(Value::Real(value));
        }
    }
    if q.failed {
        clauses.push("state = 'done' AND status >= 400".into());
    }
    let filter = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    let start = std::time::Instant::now();
    let mut stmt = store.connection().prepare_cached(&format!(
        "SELECT * FROM request_logs {filter} ORDER BY at DESC,id DESC LIMIT ?"
    ))?;
    bindings.push(Value::Integer(
        i64::try_from(q.limit.saturating_add(1)).unwrap_or(i64::MAX),
    ));
    let prepared = start.elapsed().as_micros();
    let mut index = 0;
    // Retain the boundary cells without strict UTF-8 decoding. Only turn them
    // into binding values if the sentinel proves that another page exists.
    let mut boundary = None;
    let mut decode_time = std::time::Duration::ZERO;
    let result = stmt
        .query_map(rusqlite::params_from_iter(&bindings), |r| {
            let decode_start = std::time::Instant::now();
            index += 1;
            if index == q.limit {
                let capture = |v: ValueRef<'_>| match v {
                    ValueRef::Text(bytes) => (Value::Blob(bytes.to_vec()), true),
                    ValueRef::Blob(bytes) => (Value::Blob(bytes.to_vec()), false),
                    ValueRef::Integer(n) => (Value::Integer(n), false),
                    ValueRef::Real(n) => (Value::Real(n), false),
                    ValueRef::Null => (Value::Null, false),
                };
                boundary = Some((capture(r.get_ref("at")?), capture(r.get_ref("id")?)));
            }
            let mut fields = Vec::new();
            for (name, col) in [
                ("id", "id"),
                ("state", "state"),
                ("at", "at"),
                ("apiKeyId", "api_key_id"),
                ("requestedModel", "requested_model"),
                ("resolvedProvider", "resolved_provider"),
                ("resolvedModel", "resolved_model"),
                ("credentialId", "credential_id"),
                ("attempts", "attempts"),
                ("status", "status"),
                ("errorCode", "error_code"),
                ("inputTokens", "input_tokens"),
                ("outputTokens", "output_tokens"),
                ("cacheReadTokens", "cache_read_tokens"),
                ("cacheWriteTokens", "cache_write_tokens"),
                ("ttftMs", "ttft_ms"),
                ("durationMs", "duration_ms"),
                ("costUsd", "cost_usd"),
                ("degradations", "degradations"),
                ("rtkApplied", "rtk_applied"),
                ("rtkFilterHits", "rtk_filter_hits"),
                ("rtkOriginalCodeUnits", "rtk_original_code_units"),
                ("rtkCompressedCodeUnits", "rtk_compressed_code_units"),
                ("rtkEstimatedTokensSaved", "rtk_estimated_tokens_saved"),
                ("rtkFilters", "rtk_filters"),
            ] {
                let raw = r.get_ref(col)?;
                let value = match name {
                    "state" => JsValue::String(
                        if matches!(raw, ValueRef::Text(b"pending")) {
                            "pending"
                        } else {
                            "done"
                        }
                        .encode_utf16()
                        .collect(),
                    ),
                    "rtkApplied" => JsValue::Bool(
                        matches!(raw, ValueRef::Integer(1))
                            || matches!(raw,ValueRef::Real(n) if n==1.0),
                    ),
                    "degradations" => parse_js(&match raw {
                        ValueRef::Text(s) => String::from_utf8_lossy(s).into_owned(),
                        ValueRef::Blob(b) => b.iter().map(u8::to_string).collect::<Vec<_>>().join(","),
                        _ => omni_ir::jsjson::stringify(&cell(raw)).unwrap_or_default(),
                    })
                    .map_err(|_| rusqlite::Error::InvalidQuery)?,
                "rtkFilters" => {
                    let parsed = match raw { ValueRef::Text(s) => parse_js(&String::from_utf8_lossy(s)).ok(), _ => None };
                    let allowed = ["git-diff","git-status","git-log","grep","path-list","numbered-read","build-output","test-output","deduplicate-log","smart-truncate","lint-output","package-output","tree-output","git-operation","docker-build"];
                    JsValue::Array(match &parsed { Some(JsValue::Array(a)) => a.iter().filter(|v| matches!(v, JsValue::String(s) if allowed.contains(&String::from_utf16_lossy(s).as_str()))).cloned().collect(), _ => Vec::new() })
                },
                    _ => match raw {
                        ValueRef::Blob(b) if csv => JsValue::String(b.iter().map(u8::to_string).collect::<Vec<_>>().join(",").encode_utf16().collect()),
                        _ => cell(raw),
                    },
                };
                fields.push((name.encode_utf16().collect(), value));
            }
            decode_time += decode_start.elapsed();
            Ok(JsValue::Object(fields))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    tracing::debug!(
        "log_page prepare_us={} query_decode_us={} step_collect_us={} decode_us={}",
        prepared,
        start.elapsed().as_micros() - prepared,
        start.elapsed().as_micros() - prepared - decode_time.as_micros(),
        decode_time.as_micros()
    );
    let next = if result.len() > q.limit {
        boundary.map(|(at, id)| {
            let bind = |(v, text): (Value, bool)| match v {
                Value::Blob(bytes) if text => {
                    Value::Text(String::from_utf8_lossy(&bytes).into_owned())
                }
                #[allow(clippy::cast_precision_loss)]
                Value::Integer(n) => Value::Real(n as f64),
                other => other,
            };
            (bind(at), bind(id))
        })
    } else {
        None
    };
    Ok((result, next))
}
