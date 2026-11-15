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

// Numeric equivalence classes (including infinities and signed zero), then
// one NaN class: a total preorder. Stable sort retains input order in ties.
fn compare_numbers(a: f64, b: f64) -> std::cmp::Ordering {
    match (a.is_nan(), b.is_nan()) {
        (true, true) => std::cmp::Ordering::Equal,
        (true, false) => std::cmp::Ordering::Greater,
        (false, true) => std::cmp::Ordering::Less,
        (false, false) => a.partial_cmp(&b).expect("non-NaN numbers are ordered"),
    }
}

// Numeric cells first, then strings in UTF-16 order; frozen mixed-type order
// is not reproduced (reachable only with hand-altered column affinity).
fn compare_cells(a: &Value, b: &Value) -> std::cmp::Ordering {
    match (primitive(a), primitive(b)) {
        (Some(a), Some(b)) => a.encode_utf16().cmp(b.encode_utf16()),
        (None, None) => compare_numbers(number(a), number(b)),
        (None, Some(_)) => std::cmp::Ordering::Less,
        (Some(_), None) => std::cmp::Ordering::Greater,
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
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
        // ICU collation is a total preorder on these UTF-16 string keys.
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
    let compact = omni_store::quota::list_compact_quota_samples(
        store.connection(),
        since,
        until,
        MAX_SAMPLES + 1,
    )?;
    let mut samples = compact
        .series
        .iter()
        .zip(&compact.values)
        .map(|(s, v)| {
            [
                &compact.cells[s[0]],
                &compact.cells[s[1]],
                &v[0],
                &v[1],
                &v[2],
                &v[3],
                &v[4],
            ]
        })
        .collect::<Vec<_>>();
    crate::credentials::validate_client_metadata(store)?;
    let accounts = omni_store::credentials::client_quota_accounts(store.connection())?;
    // Lexicographic composition of total preorders is total, even for corrupt cells.
    samples.sort_by(|a, b| {
        history_compare_cells(&a[0], &b[0])
            .then_with(|| history_compare_cells(&a[1], &b[1]))
            .then_with(|| compare_numbers(number(&a[5]), number(&b[5])))
    });
    let truncated = samples.len() > MAX_SAMPLES;
    samples.truncate(MAX_SAMPLES);
    let mut rows = Vec::new();
    let mut distinct = std::collections::HashMap::new();
    let mut keys = Vec::new();
    let mut counts = Vec::new();
    let mut previous = None;
    for (i, s) in samples.iter().enumerate() {
        let Some(c) = accounts.iter().rposition(|c| same_id(&c[0], &s[0])) else {
            continue;
        };
        if *s[3] == Value::Null || number(s[3]) <= 0.0 {
            continue;
        }
        if let Some((last_c, window, k)) = previous
            && last_c == c
            && window == &s[1]
        {
            counts[k] += 1;
            rows.push((i, c, k));
            continue;
        }
        let key = sort_keys([&accounts[c][2], &accounts[c][1], &s[1]]);
        let next = keys.len();
        let k = *distinct.entry(key.clone()).or_insert_with(|| {
            keys.push(key);
            counts.push(0usize);
            next
        });
        counts[k] += 1;
        previous = Some((c, &s[1], k));
        rows.push((i, c, k));
    }
    // Two representatives preserve the ordered-distinct-row validation rule
    // even when every row has the same (possibly non-string) key.
    validate_sort(
        keys.iter()
            .zip(&counts)
            .flat_map(|(k, n)| std::iter::repeat_n(k, (*n).min(2)))
            .collect(),
    )?;
    let mut order = (0..keys.len()).collect::<Vec<_>>();
    order.sort_by(|a, b| compare_keys(&keys[*a], &keys[*b]));
    let mut ranks = vec![0usize; keys.len()];
    let mut rank = 0;
    for (i, k) in order.iter().enumerate() {
        if i > 0 && !compare_keys(&keys[order[i - 1]], &keys[*k]).is_eq() {
            rank += 1;
        }
        ranks[*k] = rank;
    }
    // Three collation keys followed by numeric/NaN classes form a total preorder.
    rows.sort_by(|a, b| {
        ranks[a.2]
            .cmp(&ranks[b.2])
            .then_with(|| compare_numbers(number(&samples[a.0][5]), number(&samples[b.0][5])))
    });
    let mut out = String::from("{\"samples\":[");
    for (n, (i, c, _)) in rows.iter().enumerate() {
        if n != 0 {
            out.push(',');
        }
        let s = &samples[*i];
        let c = &accounts[*c];
        let ratio = nan_max(number(&s[2]) / number(&s[3]), 0.0);
        for (prefix, value) in [
            ("{\"credentialId\":", &c[0]),
            (",\"label\":", &c[1]),
            (",\"provider\":", &c[2]),
            (",\"windowType\":", &s[1]),
            (",\"observedAt\":", &s[5]),
        ] {
            out.push_str(prefix);
            write_history_cell(value, &mut out);
        }
        out.push_str(",\"usedRatio\":");
        omni_ir::jsjson::write_number(
            if ratio.is_nan() {
                ratio
            } else {
                ratio.min(1.0)
            },
            &mut out,
        );
        out.push_str(",\"resetsAt\":");
        write_history_cell(&s[4], &mut out);
        out.push_str(",\"windowMs\":");
        write_history_cell(&s[6], &mut out);
        out.push('}');
    }
    out.push_str(if truncated {
        "],\"truncated\":true}"
    } else {
        "],\"truncated\":false}"
    });
    Ok(out)
}
fn write_history_cell(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Text(s) => omni_ir::jsjson::write_str(s, out),
        Value::Integer(_) | Value::Real(_) => omni_ir::jsjson::write_number(number(value), out),
        Value::Blob(_) => {
            out.push_str(&omni_ir::jsjson::stringify(&json(value)).unwrap_or_default())
        }
    }
}

// Borrow normal TEXT cells; retain the corrupt-cell coercion rules above.
fn history_compare_cells(a: &Value, b: &Value) -> std::cmp::Ordering {
    match (a, b) {
        (Value::Text(a), Value::Text(b)) if a == b => std::cmp::Ordering::Equal,
        (Value::Text(a), Value::Text(b)) if a.is_ascii() && b.is_ascii() => a.cmp(b),
        (Value::Text(a), Value::Text(b)) => a.encode_utf16().cmp(b.encode_utf16()),
        _ => compare_cells(a, b),
    }
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
    // Lexicographic composition of three ICU collation preorders is total.
    rows.sort_by(|a, b| compare_keys(&a.0, &b.0));
    Ok(omni_ir::jsjson::stringify(&JsValue::Object(vec![(
        "accounts".encode_utf16().collect(),
        JsValue::Array(rows.into_iter().map(|(_, v)| v).collect()),
    )]))
    .unwrap_or_default())
}

#[cfg(test)]
mod speed_tests {
    use super::*;

    #[test]
    #[ignore = "release benchmark and byte snapshots; A8_CAPTURE=1 records baseline"]
    fn history_speed() {
        let dir = std::path::Path::new("/tmp/opencode/a8/speed");
        std::fs::create_dir_all(dir).expect("scratch directory");
        let store = omni_store::SqliteStore::open(":memory:", 0).expect("store");
        let db = store.connection();
        db.execute_batch("PRAGMA foreign_keys=OFF; DROP TABLE credentials; CREATE TABLE credentials(id,label,provider,tier,provider_data); INSERT INTO credentials VALUES('history-0','custom','custom',1,NULL),('history-1','custom','custom',1,NULL); DROP TABLE quota_samples; CREATE TABLE quota_samples(credential_id,window_type,used,limit_value,resets_at,observed_at,window_ms);").expect("fixture");
        let capture = std::env::var_os("A8_CAPTURE").is_some();
        let check = |name: &str| {
            let output = match history(&store, "", 1794614400000.0) {
                Ok(s) => s,
                Err(e) => format!("ERROR {:?}:{}", e.code, e.message),
            };
            let path = dir.join(format!("baseline-{name}.json"));
            if capture {
                std::fs::write(path, output.as_bytes()).expect("capture");
            } else {
                assert!(
                    std::fs::read(path).expect("baseline") == output.as_bytes(),
                    "bytes: {name}"
                );
            }
            output.len()
        };
        for count in [1000, 10000, 50002] {
            db.execute_batch(&format!("DELETE FROM quota_samples; WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<{count}) INSERT INTO quota_samples SELECT CASE WHEN x%2=0 THEN 'history-0' ELSE 'history-1' END,'daily',x,60000,NULL,1794613400000+x,NULL FROM n;")).expect("samples");
            let bytes = check(&count.to_string());
            db.execute_batch("UPDATE credentials SET label='E' WHERE id='history-1'; CREATE INDEX IF NOT EXISTS speed_observed ON quota_samples(observed_at);").expect("driver metadata/index");
            let driver_bytes = check(&format!("r2-driver-{count}"));
            let sql = "SELECT credential_id,window_type,used,limit_value,resets_at,observed_at,window_ms FROM quota_samples WHERE observed_at >= ? AND observed_at <= ? ORDER BY observed_at DESC LIMIT ?";
            let mut plan = db
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .expect("plan");
            let details = plan
                .query_map(
                    rusqlite::params![1793232000000.0, 1794614400000.0, 50001],
                    |r| r.get::<_, String>(3),
                )
                .expect("plan rows")
                .collect::<Result<Vec<_>, _>>()
                .expect("details");
            let mut stepping = Vec::new();
            for _ in 0..9 {
                let start = std::time::Instant::now();
                let mut stmt = db.prepare(sql).expect("statement");
                let mut rows = stmt
                    .query(rusqlite::params![1793232000000.0, 1794614400000.0, 50001])
                    .expect("query");
                let mut n = 0;
                while rows.next().expect("step").is_some() {
                    n += 1;
                }
                std::hint::black_box(n);
                stepping.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            stepping.sort_by(f64::total_cmp);
            eprintln!(
                "STEP {count} median {} plan {details:?} driver_bytes {driver_bytes}",
                stepping[4]
            );
            let mut times = Vec::new();
            for _ in 0..9 {
                let start = std::time::Instant::now();
                std::hint::black_box(history(&store, "", 1794614400000.0).expect("history"));
                times.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            times.sort_by(f64::total_cmp);
            eprintln!(
                "BENCH {count}: median {:.3} ms bytes {bytes} all {times:?}",
                times[4]
            );
            db.execute_batch("UPDATE credentials SET label='custom' WHERE id='history-1'")
                .expect("restore");
        }
        db.execute_batch("UPDATE quota_samples SET observed_at=1794613400000;")
            .expect("ties");
        check("r2-ties");
        db.execute_batch("DELETE FROM quota_samples; INSERT INTO credentials VALUES(1,'numeric','custom',1,NULL); INSERT INTO quota_samples VALUES(1,'1',1,10,NULL,1794613400000,NULL),(1.0,'1',2,10,NULL,1794613400000,NULL),('1',1,3,10,NULL,1794613400000,NULL),(x'31',1.0,4,10,NULL,1794613400000,NULL),(0,x'31',5,10,NULL,1794613400000,NULL),(-0.0,NULL,6,10,NULL,1794613400000,NULL);").expect("mixed cells");
        check("r2-mixed-cells");
        db.execute_batch("DELETE FROM credentials; DELETE FROM quota_samples;")
            .expect("clear");
        for (i, label) in ["é", "E", "e", "Z", "ä", "A", "a", "Å", "中", "e\u{301}"]
            .iter()
            .enumerate()
        {
            db.execute(
                "INSERT INTO credentials VALUES(?1,?2,'custom',1,NULL)",
                rusqlite::params![i as i64, label],
            )
            .expect("label");
            db.execute(
                "INSERT INTO quota_samples VALUES(?1,'daily',1,10,NULL,1794613400000,NULL)",
                [i as i64],
            )
            .expect("sample");
        }
        check("collation");
        db.execute_batch("INSERT INTO credentials VALUES(2,'duplicate','custom',1,NULL),('1','text','custom',1,NULL); INSERT INTO quota_samples VALUES('1','daily',1,10,NULL,1794613400000,NULL),(999,'daily',1,10,NULL,1794613400000,NULL),(2,'daily',1,0,NULL,1794613400000,NULL),(2,'daily',1,NULL,NULL,1794613400000,NULL);").expect("mixed");
        check("mixed-duplicate-orphan-limits");
        for column in ["label", "provider"] {
            for (name, value) in [
                ("null", "NULL"),
                ("blob", "x'ff'"),
                ("invalid", "CAST(x'ff' AS TEXT)"),
            ] {
                db.execute_batch(&format!(
                    "UPDATE credentials SET {column}={value} WHERE id=2"
                ))
                .expect("corrupt");
                check(&format!("{column}-{name}"));
            }
            db.execute_batch(&format!(
                "UPDATE credentials SET {column}='custom' WHERE id=2"
            ))
            .expect("restore");
        }
        db.execute_batch("DELETE FROM quota_samples; DROP TABLE quota_samples; CREATE TABLE quota_samples(credential_id,window_type,used,limit_value,resets_at,observed_at TEXT,window_ms); INSERT INTO quota_samples VALUES(2,'daily',1,10,NULL,'1794613400000x',NULL),(2,'daily',1,10,NULL,'1794613400000',NULL);").expect("text timestamp");
        check("nonnumeric");
    }
}

#[cfg(test)]
mod sort_tests {
    use super::*;
    #[test]
    fn adversarial_sorts_are_total_and_preserve_rows() {
        let cells = [
            Value::Real(f64::NAN),
            Value::Real(f64::INFINITY),
            Value::Real(f64::NEG_INFINITY),
            Value::Real(-0.0),
            Value::Null,
            Value::Integer(2),
            Value::Text("bad".into()),
            Value::Text("2".into()),
            Value::Blob(vec![1, 2]),
        ];
        let mut seed = 42_u64;
        let mut rows = (0..8192)
            .map(|id| {
                let v: [Value; 3] = std::array::from_fn(|_| {
                    seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                    cells[(seed >> 32) as usize % cells.len()].clone()
                });
                (id, v)
            })
            .collect::<Vec<_>>();
        let raw = |a: &(usize, [Value; 3]), b: &(usize, [Value; 3])| {
            compare_cells(&a.1[0], &b.1[0])
                .then_with(|| compare_cells(&a.1[1], &b.1[1]))
                .then_with(|| compare_numbers(number(&a.1[2]), number(&b.1[2])))
        };
        rows.sort_by(raw);
        assert!(rows.windows(2).all(|w| !raw(&w[0], &w[1]).is_gt()));
        let keys = sort_keys([&Value::Text("a".into()); 3]);
        rows.sort_by(|a, b| {
            compare_keys(&keys, &keys)
                .then_with(|| compare_numbers(number(&a.1[2]), number(&b.1[2])))
        });
        assert!(
            rows.windows(2)
                .all(|w| !compare_numbers(number(&w[0].1[2]), number(&w[1].1[2])).is_gt())
        );
        let mut ids = rows.iter().map(|r| r.0).collect::<Vec<_>>();
        ids.sort();
        assert_eq!(ids, (0..8192).collect::<Vec<_>>());
    }
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
