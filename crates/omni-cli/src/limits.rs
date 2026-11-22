use serde_json::{Value, json};

fn usd(n: f64) -> String {
    if n.abs() >= 1e21 {
        return format!("${}", omni_ir::jsjson::to_string(&Value::from(n)));
    }
    let digits = if n < 1.0 { 4 } else { 2 };
    let bits = n.abs().to_bits();
    let exponent = ((bits >> 52) & 2047) as i32;
    let mantissa = (bits & ((1u64 << 52) - 1)) | if exponent == 0 { 0 } else { 1u64 << 52 };
    let shift = if exponent == 0 {
        -1074
    } else {
        exponent - 1075
    };
    let scaled = u128::from(mantissa) * 10u128.pow(digits);
    let rounded = if shift >= 0 {
        scaled << shift
    } else {
        let right = (-shift) as u32;
        if right >= 128 {
            0
        } else {
            (scaled >> right)
                + u128::from((scaled & ((1u128 << right) - 1)) >= (1u128 << (right - 1)))
        }
    };
    let scale = 10u128.pow(digits);
    format!(
        "${}{}.{:0width$}",
        if n < 0.0 { "-" } else { "" },
        rounded / scale,
        rounded % scale,
        width = digits as usize
    )
}

pub fn human(key: &Value, head: &str) -> String {
    if key["limits"].is_null() {
        return format!(
            "{head}\n\nlimits unreadable: this key is refused at /v1 until they are replaced with --set"
        );
    }
    let usage = key["limitUsage"].as_array().expect("usage");
    if usage.is_empty() {
        return format!("{head}\n\nno limits configured; this key is unlimited");
    }
    let mut rows: Vec<Vec<String>> = vec![
        ["SCOPE", "DIMENSION", "WINDOW", "LIMIT", "USED", "USE%"]
            .map(str::to_owned)
            .to_vec(),
    ];
    for r in usage {
        let amount = |v: &Value| {
            if r["dimension"] == "spend" {
                let n = v.as_f64().unwrap_or(0.0);
                usd(n)
            } else {
                omni_ir::jsjson::to_string(v)
            }
        };
        rows.push(vec![
            r["model"].as_str().unwrap_or("key").into(),
            r["dimension"].as_str().expect("dimension").into(),
            r["window"].as_str().unwrap_or("—").into(),
            amount(&r["limit"]),
            if r["used"].is_null() {
                "—".into()
            } else {
                amount(&r["used"])
            },
            if r["used"].is_null() {
                "—".into()
            } else {
                format!(
                    "{}%",
                    (r["used"].as_f64().unwrap_or(0.0) / r["limit"].as_f64().unwrap_or(1.0)
                        * 100.0)
                        .round()
                )
            },
        ]);
    }
    let widths: Vec<_> = (0..6)
        .map(|i| {
            rows.iter()
                .map(|r| r[i].encode_utf16().count())
                .max()
                .expect("rows")
        })
        .collect();
    let table = rows
        .iter()
        .map(|r| {
            r.iter()
                .enumerate()
                .map(|(i, c)| {
                    let pad = " ".repeat(widths[i] - c.encode_utf16().count());
                    if i >= 3 {
                        format!("{pad}{c}")
                    } else {
                        format!("{c}{pad}")
                    }
                })
                .collect::<Vec<_>>()
                .join("  ")
                .trim_end()
                .to_owned()
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("{head}\n\n{table}\nusage is counted from completed requests still inside each window")
}
type Error = (u8, String);
fn usage(s: impl Into<String>) -> Error {
    (2, s.into())
}
fn proto(flag: &str, name: &str) -> Result<(), Error> {
    if name == "__proto__" {
        Err(usage(format!("{flag} cannot name \"__proto__\"")))
    } else {
        Ok(())
    }
}
fn windowed(s: &str) -> bool {
    matches!(s, "requests" | "tokens" | "spend")
}
fn number(flag: &str, pair: &str, raw: &str) -> Result<Value, Error> {
    let n = omni_ir::js::string_to_number(raw);
    if omni_ir::js::trim(raw).is_empty() || !n.is_finite() {
        return Err(usage(format!(
            "{flag} {pair} must be a number, got \"{raw}\""
        )));
    }
    Ok(Value::from(n))
}
fn slot(scope: &mut Value, d: &str, w: Option<&str>, v: Value) {
    if let Some(w) = w {
        if !scope[d].is_object() {
            scope[d] = json!({});
        }
        scope[d][w] = v;
    } else {
        scope[d] = v;
    }
}
fn model_slot<'a>(
    s: &'a str,
    flag: &str,
    shape: &str,
) -> Result<(&'a str, &'a str, Option<&'a str>), Error> {
    let bad = || usage(format!("{flag} must be {shape}, got \"{s}\""));
    let (head, tail) = s.rsplit_once(':').ok_or_else(bad)?;
    if windowed(tail) {
        return Err(usage(format!(
            "{flag} {s} needs a window, e.g. {flag} {s}:1m"
        )));
    }
    let (model, d, w) = if tail == "concurrency" {
        (head, tail, None)
    } else {
        let (m, d) = head.rsplit_once(':').ok_or_else(bad)?;
        (m, d, Some(tail))
    };
    if model.is_empty() || d.is_empty() || w == Some("") {
        return Err(bad());
    }
    for s in [model, d, w.unwrap_or("")] {
        proto(flag, s)?;
    }
    Ok((model, d, w))
}
fn remove(scope: &mut Value, d: &str, w: Option<&str>, entry: &str) -> Result<(), Error> {
    let missing = || usage(format!("this key has no {entry} limit"));
    let object = scope.as_object_mut().ok_or_else(missing)?;
    if let Some(w) = w {
        let windows = object
            .get_mut(d)
            .and_then(Value::as_object_mut)
            .ok_or_else(missing)?;
        if windows.shift_remove(w).is_none() {
            return Err(missing());
        }
        if windows.is_empty() {
            object.shift_remove(d);
        }
    } else if object.shift_remove(d).is_none()
        && !matches!(d, "constructor" | "toString" | "valueOf")
    {
        return Err(missing());
    }
    Ok(())
}
fn loose(v: &Value) -> Value {
    let mut out = json!({});
    for d in ["requests", "tokens", "spend"] {
        if let Some(w) = v[d].as_object() {
            for (k, n) in w {
                if !n.is_null() {
                    slot(&mut out, d, Some(k), n.clone());
                }
            }
        }
    }
    if !v["concurrency"].is_null() {
        out["concurrency"] = v["concurrency"].clone();
    }
    if let Some(models) = v["models"].as_object() {
        for (m, s) in models {
            let s = loose(s);
            if s != json!({}) {
                if out["models"].is_null() {
                    out["models"] = json!({});
                }
                out["models"][m] = s;
            }
        }
    }
    out
}
pub fn edit(existing: &Value, entries: &[String]) -> Result<Value, Error> {
    let mut out = loose(existing);
    for name in ["unset", "unset-model-limit", "set", "model-limit"] {
        for entry in entries
            .iter()
            .filter_map(|e| e.strip_prefix(&format!("{name}\0")))
        {
            let flag = format!("--{name}");
            if name == "unset" {
                if entry.contains('=') {
                    return Err(usage(format!(
                        "--unset names a limit to remove, not a value, got \"{entry}\""
                    )));
                }
                let (d, w) = entry
                    .split_once(':')
                    .map_or((entry, None), |(d, w)| (d, Some(w)));
                if w.is_none() && windowed(d) {
                    return Err(usage(format!(
                        "--unset {entry} needs a window, e.g. --unset {entry}:1m"
                    )));
                }
                if d.is_empty() || w == Some("") {
                    return Err(usage(format!(
                        "--unset must be dimension:window, got \"{entry}\""
                    )));
                }
                proto(&flag, d)?;
                proto(&flag, w.unwrap_or(""))?;
                // Key-wide scope excludes the separate model override record.
                if d == "models" {
                    return Err(usage(format!("this key has no {entry} limit")));
                }
                remove(&mut out, d, w, entry)?;
            } else if name == "unset-model-limit" {
                if entry.contains('=') {
                    return Err(usage(format!(
                        "{flag} names a limit to remove, not a value, got \"{entry}\""
                    )));
                }
                let (m, d, w) =
                    model_slot(entry, &flag, "model:dimension:window or model:concurrency")?;
                remove(&mut out["models"][m], d, w, entry)?;
                if out["models"][m] == json!({}) {
                    out["models"]
                        .as_object_mut()
                        .expect("models")
                        .shift_remove(m);
                }
            } else if name == "model-limit" {
                let shape = "model:dimension:window=value or model:concurrency=value";
                let (spec, raw) = entry
                    .rsplit_once('=')
                    .filter(|(s, _)| !s.is_empty())
                    .ok_or_else(|| usage(format!("{flag} must be {shape}, got \"{entry}\"")))?;
                let n = number(&flag, spec, raw)?;
                let (m, d, w) = model_slot(spec, &flag, shape)?;
                if out["models"].is_null() {
                    out["models"] = json!({});
                }
                if out["models"][m].is_null() {
                    out["models"][m] = json!({});
                }
                slot(&mut out["models"][m], d, w, n);
            } else {
                let (pair, raw) = entry
                    .split_once('=')
                    .filter(|(s, _)| !s.is_empty())
                    .ok_or_else(|| {
                        usage(format!(
                            "{flag} must be dimension:window=value, got \"{entry}\""
                        ))
                    })?;
                let n = number(&flag, pair, raw)?;
                let (d, w) = pair
                    .split_once(':')
                    .map_or((pair, None), |(d, w)| (d, Some(w)));
                if w.is_none() && windowed(d) {
                    return Err(usage(format!(
                        "{flag} {d} needs a window, e.g. {flag} {d}:1m=60"
                    )));
                }
                if d.is_empty() || w == Some("") {
                    return Err(usage(format!(
                        "{flag} must be dimension:window=value, got \"{entry}\""
                    )));
                }
                proto(&flag, d)?;
                proto(&flag, w.unwrap_or(""))?;
                if d == "models" {
                    return Err(usage(format!(
                        "{flag} cannot name \"models\"; per-model limits use --model-limit"
                    )));
                }
                slot(&mut out, d, w, n);
            }
        }
    }
    if out["models"] == json!({}) {
        out.as_object_mut().expect("limits").shift_remove("models");
    }
    Ok(out)
}

/// Run the ordered CLI editor on every scope. Lone names get collision-free
/// temporary keys solely inside the UTF-8 editor, then regain their exact units.
/// Neither the shared serializer nor persistence performs this normalization.
pub fn edit_lossless(
    existing: &omni_ir::jsjson::JsValue,
    entries: &[String],
) -> Result<omni_ir::jsjson::JsValue, Error> {
    use omni_ir::jsjson::JsValue;
    let mut value = existing.clone();
    let mut names = Vec::new();
    if let JsValue::Object(root) = &mut value
        && let Some((_, JsValue::Object(models))) = root
            .iter_mut()
            .find(|(k, _)| k == &"models".encode_utf16().collect::<Vec<_>>())
    {
        for i in 0..models.len() {
            if String::from_utf16(&models[i].0).is_ok() {
                continue;
            }
            let mut temporary = format!("__omni_lone_{i}");
            while models
                .iter()
                .any(|(k, _)| *k == temporary.encode_utf16().collect::<Vec<_>>())
                || entries.iter().any(|e| e.contains(&temporary))
            {
                temporary.push('_');
            }
            let units = temporary.encode_utf16().collect::<Vec<_>>();
            names.push((units.clone(), std::mem::replace(&mut models[i].0, units)));
        }
    }
    let encoded = omni_ir::jsjson::stringify(&value).expect("limits");
    let utf8: Value = serde_json::from_str(&encoded).expect("names encoded");
    let mut edited = JsValue::from(&edit(&utf8, entries)?);
    if let JsValue::Object(root) = &mut edited
        && let Some((_, JsValue::Object(models))) = root
            .iter_mut()
            .find(|(k, _)| k == &"models".encode_utf16().collect::<Vec<_>>())
    {
        for (key, _) in models {
            if let Some((_, original)) = names.iter().find(|(temporary, _)| temporary == key) {
                *key = original.clone();
            }
        }
    }
    Ok(edited)
}
