//! Log filter validation and opaque cursors.
use crate::api::Failure;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use omni_ir::jsjson::{JsValue, parse_js, stringify};
use omni_store::{SqliteStore, logs::Query};

fn obj(fields: Vec<(&str, JsValue)>) -> JsValue {
    JsValue::Object(
        fields
            .into_iter()
            .map(|(k, v)| (k.encode_utf16().collect(), v))
            .collect(),
    )
}
fn field<'a>(v: &'a JsValue, k: &str) -> Option<&'a JsValue> {
    if let JsValue::Object(f) = v {
        f.iter()
            .find(|(s, _)| s.iter().copied().eq(k.encode_utf16()))
            .map(|(_, v)| v)
    } else {
        None
    }
}
fn cursor(at: JsValue, id: JsValue) -> String {
    URL_SAFE_NO_PAD.encode(
        stringify(&obj(vec![
            ("v", JsValue::Number(1.0)),
            ("at", at),
            ("id", id),
        ]))
        .unwrap_or_default(),
    )
}

/// Export uses the same validated page operation, overriding caller paging.
pub fn export_query(raw: &str) -> Result<(String, bool), Failure> {
    let pairs = url::form_urlencoded::parse(raw.as_bytes()).collect::<Vec<_>>();
    let get = |k: &str| {
        pairs
            .iter()
            .rev()
            .find(|(n, _)| n == k)
            .map(|(_, v)| v.as_ref())
    };
    let format = get("format").unwrap_or("csv");
    if !matches!(format, "csv" | "jsonl") {
        return Err(Failure::bad(
            "(root): Invalid option: expected one of \"csv\"|\"jsonl\"",
        ));
    }
    for name in ["since", "until"] {
        if get(name).is_none_or(str::is_empty) {
            return Err(Failure::bad(format!("{name}: required for export")));
        }
    }
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in &pairs {
        if !matches!(k.as_ref(), "format" | "limit" | "cursor") {
            query.append_pair(k, v);
        }
    }
    query.append_pair("limit", "500");
    Ok((query.finish(), format == "jsonl"))
}

pub fn export_page(
    store: &SqliteStore,
    query: &Query,
    jsonl: bool,
) -> Result<(String, Option<Query>), Failure> {
    let started = std::time::Instant::now();
    let (mut rows, next) = omni_store::logs::export_page(store, query, !jsonl)?;
    rows.truncate(query.limit);
    let read_done = started.elapsed().as_micros();
    let parse_done = started.elapsed().as_micros();
    let next = next.map(|cursor| {
        let mut q = query.clone();
        q.internal_cursor = Some(cursor);
        q
    });
    let mut out = String::new();
    for row in &rows {
        if jsonl {
            out.push_str(&stringify(row).unwrap_or_default());
            out.push('\n');
        } else if let JsValue::Object(fields) = row {
            for (i, (_, v)) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&csv_cell(v));
            }
            out.push_str("\r\n");
        }
    }
    tracing::debug!(
        "export_page_read elapsed_us={} read_us={} parse_us={} encode_us={}",
        started.elapsed().as_micros(),
        read_done,
        parse_done - read_done,
        started.elapsed().as_micros() - parse_done
    );
    Ok((out, next))
}

pub const CSV_HEADER: &str = "id,state,at,apiKeyId,requestedModel,resolvedProvider,resolvedModel,credentialId,attempts,status,errorCode,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,ttftMs,durationMs,costUsd,degradations,rtkApplied,rtkFilterHits,rtkOriginalCodeUnits,rtkCompressedCodeUnits,rtkEstimatedTokensSaved,rtkFilters\r\n";
fn csv_cell(v: &JsValue) -> String {
    let mut text = match v {
        JsValue::Null | JsValue::Undefined => String::new(),
        JsValue::String(s) => String::from_utf16_lossy(s),
        JsValue::Object(_) => "[object Object]".into(),
        _ => stringify(v).unwrap_or_default(),
    };
    let first=text.trim_start_matches(|c:char|matches!(c,'\u{9}'..='\u{d}'|' '|'\u{a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')).chars().next();
    if first.is_some_and(|c| "=+-@".contains(c)) {
        text.insert(0, '\'');
    }
    if text.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

pub fn page(store: &SqliteStore, raw: &str) -> Result<String, Failure> {
    page_encoding(store, raw, false)
}

fn page_encoding(store: &SqliteStore, raw: &str, csv: bool) -> Result<String, Failure> {
    Ok(stringify(&page_value(store, raw, csv)?).unwrap_or_default())
}

fn page_value(store: &SqliteStore, raw: &str, csv: bool) -> Result<JsValue, Failure> {
    let q = parse_query(raw)?;
    page_from_query(store, &q, csv)
}

pub fn parse_query(raw: &str) -> Result<Query, Failure> {
    let mut pairs = Vec::<(String, String)>::new();
    for (k, v) in url::form_urlencoded::parse(raw.as_bytes()) {
        if let Some(p) = pairs.iter_mut().find(|p| p.0 == k) {
            p.1 = v.into_owned();
        } else {
            pairs.push((k.into_owned(), v.into_owned()));
        }
    }
    pairs.retain(|(_, v)| !v.is_empty());
    let get = |k: &str| pairs.iter().find(|p| p.0 == k).map(|p| p.1.as_str());
    for name in [
        "cursor",
        "limit",
        "since",
        "until",
        "state",
        "failed",
        "provider",
        "requestedModel",
        "resolvedModel",
        "model",
        "credentialId",
        "apiKeyId",
        "errorCode",
    ] {
        let Some(v) = get(name) else { continue };
        let max = match name {
            "cursor" => 512,
            "credentialId" | "apiKeyId" => 128,
            "requestedModel" | "resolvedModel" | "model" | "errorCode" => 256,
            _ => usize::MAX,
        };
        if v.chars().count() > max {
            return Err(Failure::bad(format!(
                "{name}: Too big: expected string to have <={max} characters"
            )));
        }
        match name {
            "state" if !matches!(v, "pending" | "done") => {
                return Err(Failure::bad(
                    "state: Invalid option: expected one of \"pending\"|\"done\"",
                ));
            }
            "failed" if !matches!(v, "true" | "false") => {
                return Err(Failure::bad(
                    "failed: Invalid option: expected one of \"true\"|\"false\"",
                ));
            }
            "since" | "until" => {
                let digits = v.strip_prefix('-').unwrap_or(v);
                if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(Failure::bad(format!("{name}: Invalid input")));
                }
                let n = v.parse::<f64>().unwrap_or(f64::INFINITY);
                if !n.is_finite() {
                    return Err(Failure::bad(format!(
                        "{name}: Invalid input: expected number, received {}Infinity",
                        if n.is_sign_negative() { "-" } else { "" }
                    )));
                }
                if n < -9_007_199_254_740_991.0 {
                    return Err(Failure::bad(format!(
                        "{name}: Too small: expected int to be >=-9007199254740991"
                    )));
                }
                if n.abs() > 9_007_199_254_740_991.0 {
                    return Err(Failure::bad(format!(
                        "{name}: Too big: expected int to be <=9007199254740991"
                    )));
                }
            }
            "provider"
                if v.len() > 32
                    || !v.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                    || !v
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') =>
            {
                return Err(Failure::bad("provider: must be a lowercase provider id"));
            }
            _ => {}
        }
    }
    for (k, _) in &pairs {
        if ![
            "cursor",
            "limit",
            "since",
            "until",
            "state",
            "failed",
            "provider",
            "requestedModel",
            "resolvedModel",
            "model",
            "credentialId",
            "apiKeyId",
            "errorCode",
        ]
        .contains(&k.as_str())
        {
            let safe = if !k.is_empty()
                && k.len() <= 64
                && k.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.:/+-".contains(&b))
            {
                k.as_str()
            } else {
                "(unprintable)"
            };
            return Err(Failure::bad(format!("(root): unrecognized key \"{safe}\"")));
        }
    }
    if let (Some(a), Some(b)) = (get("since"), get("until"))
        && a.parse::<f64>().unwrap_or(0.0) > b.parse::<f64>().unwrap_or(0.0)
    {
        return Err(Failure::bad("since: must not be after until"));
    }
    let n = get("limit")
        .filter(|s| !s.trim().is_empty())
        .map(omni_ir::js::string_to_number)
        .filter(|n| n.is_finite())
        .unwrap_or(100.0);
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let limit = n.clamp(1.0, 500.0).floor() as usize;
    let mut q = Query {
        limit,
        since: get("since").and_then(|v| v.parse().ok()),
        until: get("until").and_then(|v| v.parse().ok()),
        failed: get("failed") == Some("true"),
        state: get("state").map(str::to_owned),
        provider: get("provider").map(str::to_owned),
        requested_model: get("requestedModel").map(str::to_owned),
        resolved_model: get("resolvedModel").map(str::to_owned),
        model: get("model").map(str::to_owned),
        error_code: get("errorCode").map(str::to_owned),
        api_key_id: get("apiKeyId").map(str::to_owned),
        credential_id: get("credentialId").map(str::to_owned),
        cursor: None,
        internal_cursor: None,
    };
    if let Some(s) = get("cursor") {
        let bad = || Failure::bad("cursor: malformed");
        // Buffer.from(base64url) ignores non-alphabet bytes, accepts both
        // alphabets, stops at padding, and discards incomplete trailing bits.
        let mut bytes = Vec::new();
        let mut bits = 0u32;
        let mut count = 0;
        for b in s.bytes().take_while(|b| *b != b'=') {
            let n = match b {
                b'A'..=b'Z' => b - b'A',
                b'a'..=b'z' => b - b'a' + 26,
                b'0'..=b'9' => b - b'0' + 52,
                b'+' | b'-' => 62,
                b'/' | b'_' => 63,
                _ => continue,
            };
            bits = (bits << 6) | u32::from(n);
            count += 6;
            if count >= 8 {
                count -= 8;
                bytes.push(((bits >> count) & 255) as u8);
            }
        }
        let v = parse_js(&String::from_utf8_lossy(&bytes)).map_err(|_| bad())?;
        if !matches!(&v,JsValue::Object(f) if f.len()==3) {
            return Err(bad());
        }
        if field(&v, "v") != Some(&JsValue::Number(1.0)) {
            return Err(Failure::bad("cursor: unknown version"));
        }
        let (Some(JsValue::Number(at)), Some(JsValue::String(id))) =
            (field(&v, "at"), field(&v, "id"))
        else {
            return Err(bad());
        };
        if at.fract() != 0.0
            || at.abs() > 9_007_199_254_740_991.0
            || id.is_empty()
            || id.len() > 128
            || cursor(JsValue::Number(*at), JsValue::String(id.clone())) != s
        {
            return Err(bad());
        }
        q.cursor = Some((*at, id.clone()));
    }
    Ok(q)
}

fn page_from_query(store: &SqliteStore, q: &Query, csv: bool) -> Result<JsValue, Failure> {
    let limit = q.limit;
    let mut rows = omni_store::logs::page_encoding(store, q, csv)?;
    let next = if rows.len() > limit {
        rows.truncate(limit);
        let last = &rows[limit - 1];
        JsValue::String(
            cursor(
                field(last, "at").cloned().unwrap_or(JsValue::Null),
                field(last, "id").cloned().unwrap_or(JsValue::Null),
            )
            .encode_utf16()
            .collect(),
        )
    } else {
        JsValue::Null
    };
    Ok(obj(vec![
        ("logs", JsValue::Array(rows)),
        ("nextCursor", next),
    ]))
}
