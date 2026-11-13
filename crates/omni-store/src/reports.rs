//! SQLite report reads. Grouping happens in SQLite; only aggregate buckets are
//! materialized, as in the frozen store's `aggregate().all().map()`.
use crate::{SqliteStore, StoreError};
use omni_ir::jsjson::{JsValue, write_number};
use rusqlite::types::{Value, ValueRef};

pub struct UsageQuery<'a> {
    pub daily: bool,
    pub key: &'a str,
    pub split: Option<&'a str>,
    pub since: f64,
    pub until: f64,
    pub api_key: Option<String>,
    pub credential: Option<String>,
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

pub fn usage(store: &SqliteStore, q: UsageQuery<'_>) -> Result<Vec<JsValue>, StoreError> {
    let UsageQuery {
        daily,
        key,
        split,
        mut since,
        until,
        api_key,
        credential,
    } = q;
    // Public reader never interpolates a caller-supplied SQL expression.
    for column in std::iter::once(key).chain(split) {
        if !matches!(
            column,
            "credential_id"
                | "resolved_model"
                | "requested_model"
                | "api_key_id"
                | "resolved_provider"
                | "provider"
                | "CAST(at / 3600000 AS INTEGER)"
                | "day"
        ) {
            return Err(rusqlite::Error::InvalidParameterName(column.into()).into());
        }
    }
    if daily {
        #[allow(clippy::cast_precision_loss)]
        let offset = store.day_offset_minutes() as f64 * 60_000.0;
        since = ((since + offset) / 86_400_000.0).floor() * 86_400_000.0 - offset;
    }
    let mut bindings = vec![Value::Real(since), Value::Real(until)];
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
    let mut stmt = store.connection().prepare(&sql)?;
    Ok(stmt
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
        })?
        .collect::<Result<Vec<_>, _>>()?)
}
