//! Explicit frozen client quota projection. Never serializes credential records.
use crate::api::Failure;
use omni_ir::jsjson::JsValue;
use rusqlite::types::Value;
trait TextCell {
    fn as_str(&self) -> Option<&str>;
}
// Map uses SameValueZero for primitives; separately read Uint8Arrays are
// distinct objects even when their bytes are identical. Never coerce text.
fn same_id(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Blob(_), _) | (_, Value::Blob(_)) => false,
        (Value::Null, Value::Null) => true,
        (Value::Text(a), Value::Text(b)) => a == b,
        (Value::Integer(_) | Value::Real(_), Value::Integer(_) | Value::Real(_)) => {
            let (a, b) = (number(a), number(b));
            a == b || (a.is_nan() && b.is_nan())
        }
        _ => false,
    }
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

#[derive(Clone)]
struct SortKey {
    text: Vec<u16>,
    string: bool,
}
fn sort_keys(values: [&Value; 3]) -> [SortKey; 3] {
    values.map(|v| SortKey {
        text: match v {
            Value::Text(s) => s.clone(),
            Value::Blob(b) => b.iter().map(u8::to_string).collect::<Vec<_>>().join(","),
            Value::Null => "null".into(),
            _ => {
                let mut s = String::new();
                omni_ir::jsjson::write_number(number(v), &mut s);
                s
            }
        }
        .encode_utf16()
        .collect(),
        string: matches!(v, Value::Text(_)),
    })
}
fn compare_keys(a: &[SortKey; 3], b: &[SortKey; 3]) -> std::cmp::Ordering {
    a.iter()
        .zip(b)
        .map(|(a, b)| crate::api::locale_compare(&a.text, &b.text))
        .find(|o| !o.is_eq())
        .unwrap_or(std::cmp::Ordering::Equal)
}
// Documented difference: reject iff SOME ordered pair of distinct rows would
// throw in the frozen comparator, not merely pairs visited by an engine sort.
// At each equal-prefix group, only receivers must be strings; arguments use JS
// ToString (including comma-joined Uint8Array). A singleton never compares.
// Sorting/grouping three levels costs O(n log n), rather than n squared.
fn validate_sort(mut keys: Vec<&[SortKey; 3]>) -> Result<(), Failure> {
    fn group(keys: &mut [&[SortKey; 3]], depth: usize) -> Result<(), Failure> {
        if keys.len() < 2 || depth == 3 {
            return Ok(());
        }
        if keys.iter().any(|k| !k[depth].string) {
            return Err(Failure::internal("localeCompare is not a function"));
        }
        keys.sort_by(|a, b| crate::api::locale_compare(&a[depth].text, &b[depth].text));
        let mut start = 0;
        for end in 1..=keys.len() {
            if end == keys.len()
                || !crate::api::locale_compare(&keys[start][depth].text, &keys[end][depth].text)
                    .is_eq()
            {
                group(&mut keys[start..end], depth + 1)?;
                start = end;
            }
        }
        Ok(())
    }
    group(&mut keys, 0)
}

/// Account history retains at most 50,001 raw samples and writes one row at a
/// time. No projected sample value tree is retained alongside the raw page.
pub fn history(store: &omni_store::SqliteStore, query: &str, now: f64) -> Result<String, Failure> {
    const MAX_SAMPLES: usize = 50_000;
    let settings = store.get_settings()?;
    let oldest = (now - settings.log_retention_days * 86_400_000.0).max(now - 16.0 * 86_400_000.0);
    let pairs = url::form_urlencoded::parse(query.as_bytes()).collect::<Vec<_>>();
    let optional = |key: &str, fallback: f64| {
        pairs
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map_or(fallback, |(_, v)| {
                let n = omni_ir::js::string_to_number(v);
                if v.trim().is_empty() || !n.is_finite() {
                    fallback
                } else {
                    n
                }
            })
    };
    let since = optional("since", oldest).max(oldest);
    let until = optional("until", now).min(now);
    let mut samples =
        omni_store::quota::list_quota_samples(store.connection(), since, until, MAX_SAMPLES + 1)?;
    crate::credentials::validate_client_metadata(store)?;
    let accounts = omni_store::credentials::client_quota_accounts(store.connection())?;
    let relational = |a: &Value, b: &Value| match (primitive(a), primitive(b)) {
        (Some(a), Some(b)) => a.encode_utf16().cmp(b.encode_utf16()),
        _ => number(a)
            .partial_cmp(&number(b))
            .unwrap_or(std::cmp::Ordering::Equal),
    };
    samples.sort_by(|a, b| {
        relational(&a[0], &b[0])
            .then_with(|| relational(&a[1], &b[1]))
            .then_with(|| {
                (number(&a[5]) - number(&b[5]))
                    .partial_cmp(&0.0)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    let truncated = samples.len() > MAX_SAMPLES;
    samples.truncate(MAX_SAMPLES);
    let mut rows = Vec::new();
    for (i, s) in samples.iter().enumerate() {
        let Some(c) = accounts.iter().rposition(|c| same_id(&c[0], &s[0])) else {
            continue;
        };
        if s[3] == Value::Null || number(&s[3]) <= 0.0 {
            continue;
        }
        let keys = sort_keys([&accounts[c][2], &accounts[c][1], &s[1]]);
        rows.push((i, c, keys));
    }
    validate_sort(rows.iter().map(|r| &r.2).collect())?;
    rows.sort_by(|a, b| {
        compare_keys(&a.2, &b.2).then_with(|| {
            // Frozen fourth key is subtraction: non-numeric cells yield
            // NaN, treated as an equal comparison, never an exception.
            (number(&samples[a.0][5]) - number(&samples[b.0][5]))
                .partial_cmp(&0.0)
                .unwrap_or(std::cmp::Ordering::Equal)
        })
    });
    let mut out = String::from("{\"samples\":[");
    for (n, (i, c, _)) in rows.iter().enumerate() {
        if n != 0 {
            out.push(',');
        }
        let s = &samples[*i];
        let c = &accounts[*c];
        let ratio = nan_max(number(&s[2]) / number(&s[3]), 0.0);
        let fields = [
            ("credentialId", json(&c[0])),
            ("label", json(&c[1])),
            ("provider", json(&c[2])),
            ("windowType", json(&s[1])),
            ("observedAt", json(&s[5])),
            (
                "usedRatio",
                JsValue::Number(if ratio.is_nan() {
                    ratio
                } else {
                    ratio.min(1.0)
                }),
            ),
            ("resetsAt", json(&s[4])),
            ("windowMs", json(&s[6])),
        ];
        out.push_str(
            &omni_ir::jsjson::stringify(&JsValue::Object(
                fields
                    .into_iter()
                    .map(|(k, v)| (k.encode_utf16().collect(), v))
                    .collect(),
            ))
            .unwrap_or_default(),
        );
    }
    out.push_str(if truncated {
        "],\"truncated\":true}"
    } else {
        "],\"truncated\":false}"
    });
    Ok(out)
}
pub fn accounts(store: &omni_store::SqliteStore, now: f64) -> Result<String, Failure> {
    crate::credentials::validate_client_metadata(store)?;
    let accounts = omni_store::credentials::client_quota_accounts(store.connection())?;
    let windows = omni_store::quota::client_windows(store.connection())?;
    let poll = store.get_settings()?.quota_poll_interval_ms;
    let mut rows = Vec::new();
    for w in windows {
        let Some(c) = accounts.iter().rev().find(|c| same_id(&c[0], &w[0])) else {
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
        let keys = sort_keys([&c[2], &c[1], &w[1]]);
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
    validate_sort(rows.iter().map(|r| &r.0).collect())?;
    rows.sort_by(|a, b| compare_keys(&a.0, &b.0));
    Ok(omni_ir::jsjson::stringify(&JsValue::Object(vec![(
        "accounts".encode_utf16().collect(),
        JsValue::Array(rows.into_iter().map(|(_, v)| v).collect()),
    )]))
    .unwrap_or_default())
}

#[cfg(test)]
mod sort_tests {
    use super::*;
    #[test]
    fn map_id_primitives_and_object_identity() {
        assert!(!same_id(&Value::Blob(vec![49]), &Value::Blob(vec![49])));
        assert!(!same_id(&Value::Integer(1), &Value::Text("1".into())));
        assert!(same_id(&Value::Integer(1), &Value::Real(1.0)));
        assert!(same_id(&Value::Integer(0), &Value::Real(-0.0)));
        assert!(same_id(&Value::Real(f64::NAN), &Value::Real(f64::NAN)));
        assert!(!same_id(&Value::Text("NaN".into()), &Value::Real(f64::NAN)));
        assert!(same_id(&Value::Null, &Value::Null));
    }
    #[test]
    fn grouped_rule_equals_all_ordered_pairs() {
        let cells = [
            Value::Text("a".into()),
            Value::Text("b".into()),
            Value::Text("49,50".into()),
            Value::Blob(vec![49, 50]),
            Value::Null,
            Value::Text("null".into()),
            Value::Integer(1),
            Value::Text("1".into()),
            Value::Text("é".into()),
            Value::Text("e\u{301}".into()),
        ];
        let mut seed = 42_u64;
        for n in 0..9 {
            for _ in 0..1000 {
                let rows = (0..n)
                    .map(|_| {
                        let v = std::array::from_fn(|_| {
                            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                            &cells[(seed >> 32) as usize % cells.len()]
                        });
                        sort_keys(v)
                    })
                    .collect::<Vec<_>>();
                let throws = rows.iter().enumerate().any(|(i, a)| {
                    rows.iter().enumerate().any(|(j, b)| {
                        if i == j {
                            return false;
                        }
                        for k in 0..3 {
                            if !a[k].string {
                                return true;
                            }
                            if !crate::api::locale_compare(&a[k].text, &b[k].text).is_eq() {
                                break;
                            }
                        }
                        false
                    })
                });
                assert_eq!(validate_sort(rows.iter().collect()).is_err(), throws);
            }
        }
    }
}
