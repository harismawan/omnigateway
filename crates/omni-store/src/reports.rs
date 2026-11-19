//! SQLite report reads. Grouping happens in SQLite, as in the frozen store's
//! `aggregate().all().map()`; the usage report's buckets are written to the
//! answer as SQLite yields them, never held as values.
use crate::{SqliteStore, StoreError};
use omni_ir::jsjson::{JsValue, write_number, write_str};
use rusqlite::types::{Value, ValueRef};

pub fn nodes(store: &SqliteStore, now: i64) -> Result<Vec<JsValue>, StoreError> {
    let mut stmt = store
        .connection()
        .prepare("SELECT id, seen_at FROM nodes WHERE seen_at > ? ORDER BY seen_at DESC")?;
    let rows = stmt.query_map([now.saturating_sub(60_000)], |row| {
        Ok(JsValue::Object(vec![
            (
                "id".encode_utf16().collect(),
                crate::logs::cell(row.get_ref(0)?),
            ),
            (
                "seenAt".encode_utf16().collect(),
                crate::logs::cell(row.get_ref(1)?),
            ),
        ]))
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub struct UsageQuery<'a> {
    pub daily: bool,
    pub key: &'a str,
    pub split: Option<&'a str>,
    pub since: f64,
    pub until: f64,
    pub api_key: Option<String>,
    pub credential: Option<String>,
}

pub(crate) fn dimension(column: &str, daily: bool) -> bool {
    matches!(
        column,
        "credential_id" | "resolved_model" | "requested_model" | "api_key_id"
    ) || if daily {
        matches!(column, "provider" | "day")
    } else {
        matches!(
            column,
            "resolved_provider" | "CAST(at / 3600000 AS INTEGER)"
        )
    }
}

pub(crate) const MEASURES: [(&str, usize); 10] = [
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
];

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

/// The usage buckets as the JSON array `JSON.stringify` writes for TS's
/// mapped rows, appended to `out`: one object per bucket, `key`, the ten
/// measures, then `split` when the query has one.
///
/// Written row by row rather than built and then serialized. A bucket as a
/// `JsValue` is 23 or 25 allocations (a UTF-16 key and a value per field) and
/// about 1.3 kB against about 200 bytes of text: for 70,000 buckets that was
/// 94 MB in a million allocations beside a 15 MB answer, built on one thread
/// and freed on another. On an error `out` holds a partial array, which the
/// caller discards with the error.
pub fn usage_json(
    store: &SqliteStore,
    q: UsageQuery<'_>,
    out: &mut String,
) -> Result<(), StoreError> {
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
        if !dimension(column, daily) {
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
    let mut rows = stmt.query(rusqlite::params_from_iter(bindings))?;
    out.push('[');
    let mut first = true;
    while let Some(r) = rows.next()? {
        if !first {
            out.push(',');
        }
        first = false;
        out.push_str("{\"key\":");
        // A label is well-formed UTF-8 (lossily decoded), so this is what
        // `JSON.stringify` writes for the same string.
        write_str(&label(r.get_ref(0)?), out);
        for (name, col) in MEASURES {
            out.push_str(",\"");
            out.push_str(name);
            out.push_str("\":");
            write_number(r.get::<_, f64>(col)?, out);
        }
        if split.is_some() {
            out.push_str(",\"split\":");
            write_str(&label(r.get_ref(1)?), out);
        }
        out.push('}');
    }
    out.push(']');
    Ok(())
}
