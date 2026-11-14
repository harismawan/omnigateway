//! Explicit frozen client quota projection. Never serializes credential records.
use crate::api::Failure;
use omni_ir::jsjson::JsValue;
use rusqlite::types::Value;
trait TextCell {
    fn as_str(&self) -> Option<&str>;
}
impl TextCell for Value {
    fn as_str(&self) -> Option<&str> {
        if let Value::Text(s) = self {
            Some(s)
        } else {
            None
        }
    }
}

fn number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Integer(n) => *n as f64,
        Value::Real(n) => *n,
        Value::Text(s) => omni_ir::js::string_to_number(s),
        Value::Blob(b) => omni_ir::js::string_to_number(
            &b.iter().map(u8::to_string).collect::<Vec<_>>().join(","),
        ),
    }
}
fn json(v: &Value) -> JsValue {
    match v {
        Value::Null => JsValue::Null,
        Value::Text(s) => JsValue::String(s.encode_utf16().collect()),
        Value::Blob(b) => JsValue::Object(
            b.iter()
                .enumerate()
                .map(|(i, b)| {
                    (
                        i.to_string().encode_utf16().collect(),
                        JsValue::Number(*b as f64),
                    )
                })
                .collect(),
        ),
        _ => JsValue::Number(number(v)),
    }
}
fn nan_max(n: f64, floor: f64) -> f64 {
    if n.is_nan() { n } else { n.max(floor) }
}
fn primitive(v: &Value) -> Option<String> {
    match v {
        Value::Text(s) => Some(s.clone()),
        Value::Blob(b) => Some(b.iter().map(u8::to_string).collect::<Vec<_>>().join(",")),
        _ => None,
    }
}
pub fn accounts(store: &omni_store::SqliteStore, now: f64) -> Result<String, Failure> {
    crate::credentials::validate_client_metadata(store)?;
    let accounts = omni_store::credentials::client_quota_accounts(store.connection())?;
    let windows = omni_store::quota::client_windows(store.connection())?;
    let poll = store.get_settings()?.quota_poll_interval_ms;
    let mut rows = Vec::new();
    for w in windows {
        let Some(c) = accounts.iter().find(|c| c[0] == w[0]) else {
            continue;
        };
        let used = number(&w[2]);
        let limit = number(&w[3]);
        let reset = number(&w[4]);
        let observed = number(&w[5]);
        let stale = observed <= 0.0 || now - observed > nan_max(poll, 60_000.0) * 3.0;
        let rolled = w[4] != Value::Null && reset <= now;
        let duration = if number(&w[6]) > 0.0 {
            number(&w[6])
        } else {
            omni_store::quota::WindowType::parse(w[1].as_str().unwrap_or("")).nominal_ms()
        };
        let rate = if stale || rolled || w[4] == Value::Null {
            None
        } else {
            let elapsed = (observed - (reset - duration)) / 3_600_000.0;
            Some(
                if elapsed <= 0.0 || w[2] == Value::Integer(0) || w[2] == Value::Real(0.0) {
                    0.0
                } else {
                    used / elapsed
                },
            )
        };
        let known = w[3] != Value::Null && (limit.is_nan() || limit > 0.0);
        let exhaust = rate.filter(|r| known && (r.is_nan() || *r > 0.0)).map(|r| {
            let delta = nan_max(limit - used, 0.0) / r * 3_600_000.0;
            if let Some(mut s) = primitive(&w[5]) {
                if delta.is_nan() {
                    s.push_str("NaN");
                } else if delta.is_infinite() {
                    s.push_str(if delta.is_sign_positive() {
                        "Infinity"
                    } else {
                        "-Infinity"
                    });
                } else {
                    omni_ir::jsjson::write_number(delta, &mut s);
                }
                Value::Text(s)
            } else {
                Value::Real(observed + delta)
            }
        });
        let survives = exhaust.as_ref().is_none_or(|e| {
            w[4] == Value::Null
                || match (primitive(e), primitive(&w[4])) {
                    (Some(a), Some(b)) => a.encode_utf16().cmp(b.encode_utf16()).is_ge(),
                    _ => number(e) >= reset,
                }
        });
        let ratio = if known {
            let n = nan_max(used / limit, 0.0);
            JsValue::Number(if n.is_nan() { n } else { n.min(1.0) })
        } else {
            JsValue::Null
        };
        let fields = vec![
            ("credentialId", json(&c[0])),
            ("label", json(&c[1])),
            ("provider", json(&c[2])),
            ("windowType", json(&w[1])),
            ("usedRatio", ratio),
            ("resetsAt", json(&w[4])),
            ("observedAt", json(&w[5])),
            ("windowMs", json(&w[6])),
            (
                "ratePerHourRatio",
                rate.filter(|_| known)
                    .map_or(JsValue::Null, |r| JsValue::Number(r / limit)),
            ),
            ("exhaustsAt", exhaust.as_ref().map_or(JsValue::Null, json)),
            (
                "survives",
                if stale || rolled {
                    JsValue::Null
                } else {
                    JsValue::Bool(survives)
                },
            ),
            ("stale", JsValue::Bool(stale)),
            ("rolledOver", JsValue::Bool(rolled)),
        ];
        let keys = [&c[2], &c[1], &w[1]]
            .map(|v| {
                v.as_str()
                    .map(|s| s.encode_utf16().collect::<Vec<_>>())
                    .ok_or_else(|| Failure::internal("localeCompare is not a function"))
            })
            .into_iter()
            .collect::<Result<Vec<_>, _>>()?;
        rows.push((
            keys,
            JsValue::Object(
                fields
                    .into_iter()
                    .map(|(k, v)| (k.encode_utf16().collect(), v))
                    .collect(),
            ),
        ));
    }
    rows.sort_by(|a, b| {
        a.0.iter()
            .zip(&b.0)
            .map(|(a, b)| crate::api::locale_compare(a, b))
            .find(|o| !o.is_eq())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(omni_ir::jsjson::stringify(&JsValue::Object(vec![(
        "accounts".encode_utf16().collect(),
        JsValue::Array(rows.into_iter().map(|(_, v)| v).collect()),
    )]))
    .unwrap_or_default())
}
