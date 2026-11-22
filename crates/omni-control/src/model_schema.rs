//! Write-only frozen model schema. Read-only operator values remain unvalidated.
use crate::settings_value::get;
use omni_ir::jsjson::JsValue;

fn field<'a>(v: &'a JsValue, k: &str) -> &'a JsValue {
    static UNDEFINED: JsValue = JsValue::Undefined;
    get(v, k).unwrap_or(&UNDEFINED)
}
fn error(path: &str, detail: impl std::fmt::Display) -> String {
    format!("BAD_REQUEST: {path}: {detail}")
}
fn kind(v: &JsValue) -> &'static str {
    match v {
        JsValue::Undefined => "undefined",
        JsValue::Function => "function",
        JsValue::Null => "null",
        JsValue::Bool(_) => "boolean",
        JsValue::Number(_) => "number",
        JsValue::String(_) => "string",
        JsValue::Array(_) => "array",
        JsValue::Object(_) => "object",
    }
}
fn typed(v: &JsValue, expected: &str, path: &str) -> Result<(), String> {
    if kind(v) == expected {
        Ok(())
    } else {
        Err(error(
            path,
            format!(
                "Invalid input: expected {expected}, received {}",
                crate::body_schema::received(Some(v))
            ),
        ))
    }
}
fn string(v: &JsValue, path: &str, trim: bool, nonempty: bool) -> Result<JsValue, String> {
    typed(v, "string", path)?;
    let JsValue::String(s) = v else {
        unreachable!()
    };
    let mut s = s.as_slice();
    if trim {
        let ws = |u: &u16| char::from_u32(u32::from(*u)).is_some_and(omni_ir::js::is_js_whitespace);
        while s.first().is_some_and(ws) {
            s = &s[1..];
        }
        while s.last().is_some_and(ws) {
            s = &s[..s.len() - 1];
        }
    }
    if nonempty && s.is_empty() {
        return Err(error(
            path,
            "Too small: expected string to have >=1 characters",
        ));
    }
    Ok(JsValue::String(s.to_vec()))
}
fn number(v: &JsValue, path: &str, integer: bool, positive: bool) -> Result<JsValue, String> {
    typed(v, "number", path)?;
    let JsValue::Number(n) = v else {
        unreachable!()
    };
    if !n.is_finite() {
        return Err(error(
            path,
            format!(
                "Invalid input: expected number, received {}",
                if n.is_nan() {
                    "NaN"
                } else if *n > 0.0 {
                    "Infinity"
                } else {
                    "-Infinity"
                }
            ),
        ));
    }
    if integer && n.fract() != 0.0 {
        return Err(error(path, "Invalid input: expected int, received number"));
    }
    if integer && n.abs() > 9007199254740991.0 {
        return Err(error(
            path,
            if *n > 0.0 {
                "Too big: expected int to be <=9007199254740991"
            } else {
                "Too small: expected int to be >=-9007199254740991"
            },
        ));
    }
    if positive && *n <= 0.0 {
        return Err(error(
            path,
            if path.ends_with(".tier") {
                "Too small: expected number to be >=1"
            } else {
                "Too small: expected number to be >0"
            },
        ));
    }
    if !positive && *n < 0.0 {
        return Err(error(path, "Too small: expected number to be >=0"));
    }
    Ok(v.clone())
}
fn pair(k: &str, v: JsValue) -> (Vec<u16>, JsValue) {
    (k.encode_utf16().collect(), v)
}
pub fn parse(v: &JsValue) -> Result<JsValue, String> {
    typed(v, "object", "(root)")?;
    let id = string(field(v, "id"), "id", false, true)?;
    let strategy = field(v, "strategy");
    if !["score", "priority", "roundRobin", "weighted"]
        .iter()
        .any(|s| strategy == &JsValue::String(s.encode_utf16().collect()))
    {
        return Err(error(
            "strategy",
            "Invalid option: expected one of \"score\"|\"priority\"|\"roundRobin\"|\"weighted\"",
        ));
    }
    let alias = field(v, "isAlias");
    typed(alias, "boolean", "isAlias")?;
    let targets = field(v, "targets");
    typed(targets, "array", "targets")?;
    let JsValue::Array(targets) = targets else {
        unreachable!()
    };
    let targets = targets
        .iter()
        .enumerate()
        .map(|(i, t)| target(t, &format!("targets.{i}")))
        .collect::<Result<Vec<_>, _>>()?;
    if targets.is_empty() {
        return Err(error(
            "targets",
            "a virtual model needs at least one target",
        ));
    }
    Ok(JsValue::Object(vec![
        pair("id", id),
        pair("strategy", strategy.clone()),
        pair("isAlias", alias.clone()),
        pair("targets", JsValue::Array(targets)),
    ]))
}
fn target(v: &JsValue, path: &str) -> Result<JsValue, String> {
    typed(v, "object", path)?;
    let mut out = Vec::new();
    let keys = [
        "provider",
        "endpointId",
        "model",
        "tier",
        "weight",
        "costPerMTok",
        "contextWindow",
        "maxOutputTokens",
        "credentialId",
        "capabilities",
    ];
    for key in keys {
        let value = field(v, key);
        let p = format!("{path}.{key}");
        if matches!(
            key,
            "endpointId" | "contextWindow" | "maxOutputTokens" | "credentialId"
        ) && matches!(value, JsValue::Undefined)
        {
            continue;
        }
        let value = match key {
            "provider" | "endpointId" | "model" | "credentialId" => {
                let value = string(
                    value,
                    &p,
                    matches!(key, "endpointId" | "credentialId"),
                    key != "provider",
                )?;
                let JsValue::String(s) = &value else {
                    unreachable!()
                };
                if key == "provider"
                    && !(s.len() <= 32
                        && s.first().is_some_and(|u| matches!(u, 97..=122))
                        && s.iter().all(|u| matches!(u,97..=122|48..=57|45)))
                {
                    return Err(error(&p, "must be a lowercase provider id"));
                }
                if key == "credentialId" {
                    if s.len() > 64 {
                        return Err(error(
                            &p,
                            "Too big: expected string to have <=64 characters",
                        ));
                    }
                    if !s.iter().all(|u| matches!(u,65..=90|97..=122|48..=57|45|95)) {
                        return Err(error(&p, "credentialId must be an account id"));
                    }
                }
                value
            }
            "tier" | "contextWindow" | "maxOutputTokens" => number(value, &p, true, true)?,
            "weight" => number(value, &p, false, true)?,
            "costPerMTok" | "capabilities" => {
                typed(value, "object", &p)?;
                let names: &[&str] = if key == "costPerMTok" {
                    &[
                        "input",
                        "output",
                        "cacheRead",
                        "cacheWrite5m",
                        "cacheWrite1h",
                    ]
                } else {
                    &["tools", "images", "reasoning"]
                };
                let mut fields = Vec::new();
                for name in names {
                    let v = field(value, name);
                    if name.starts_with("cache") && matches!(v, JsValue::Undefined) {
                        continue;
                    }
                    let p = format!("{p}.{name}");
                    let v = if key == "costPerMTok" {
                        number(v, &p, false, false)?
                    } else {
                        typed(v, "boolean", &p)?;
                        v.clone()
                    };
                    fields.push(pair(name, v));
                }
                JsValue::Object(fields)
            }
            _ => unreachable!(),
        };
        out.push(pair(key, value));
    }
    let JsValue::Object(fields) = v else {
        unreachable!()
    };
    if let Some((k, _)) = fields
        .iter()
        .filter(|(k, _)| !keys.iter().any(|s| k.iter().copied().eq(s.encode_utf16())))
        .min_by_key(|(k, _)| {
            omni_ir::jsjson::array_index(&String::from_utf16_lossy(k)).map_or((1, 0), |n| (0, n))
        })
    {
        return Err(error(
            path,
            format!(
                "unrecognized key \"{}\"",
                omni_ir::js::safe_token(&String::from_utf16_lossy(k))
            ),
        ));
    }
    let out = JsValue::Object(out);
    let custom = field(&out, "provider") == &JsValue::String("custom".encode_utf16().collect());
    let endpoint = get(&out, "endpointId").is_some();
    if custom != endpoint {
        return Err(error(
            &format!("{path}.endpointId"),
            if custom {
                "custom targets require an endpointId"
            } else {
                "endpointId is only meaningful for a custom target"
            },
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn deep_unknown_and_invalid_values_cleanup_on_small_stack() {
        std::thread::Builder::new().stack_size(256*1024).spawn(|| {
            let deep=format!("{}0{}","[".repeat(20000),"]".repeat(20000));
            for raw in [format!(r#"{{"id":{deep}}}"#),format!(r#"{{"id":"m","strategy":"score","isAlias":false,"targets":[],"extra":{deep}}}"#)] {
                let value=crate::operator_json::parse(&raw).expect("parse");
                assert!(super::parse(&value).is_err());
            }
        }).expect("thread").join().expect("bounded cleanup");
    }
}
