//! JSON.parse values for operator inspection, separate from gateway admission.
//! Explicit parse/coercion stacks and JsValue's iterative Drop preserve deep
//! stored values and infinities without passing through serde's number model.
use omni_ir::jsjson::JsValue;

enum Frame {
    Array(Vec<JsValue>),
    Object(Vec<(Vec<u16>, JsValue)>, Option<Vec<u16>>),
}

pub fn parse(text: &str) -> Result<JsValue, String> {
    if text.is_empty() {
        return Err("JSON Parse error: Unexpected EOF".into());
    }
    if let Some(error) = omni_ir::jsc_json::parse_error(text) {
        return Err(error);
    }
    let mut frames = Vec::new();
    let mut root = JsValue::Null;
    let mut i = 0;
    let bytes = text.as_bytes();
    while i < bytes.len() {
        let value = match bytes[i] {
            b' ' | b'\t' | b'\r' | b'\n' | b',' | b':' => {
                i += 1;
                continue;
            }
            b'[' => {
                frames.push(Frame::Array(Vec::new()));
                i += 1;
                continue;
            }
            b'{' => {
                frames.push(Frame::Object(Vec::new(), None));
                i += 1;
                continue;
            }
            b']' | b'}' => {
                i += 1;
                match frames.pop().expect("validated container") {
                    Frame::Array(a) => JsValue::Array(a),
                    Frame::Object(o, _) => JsValue::Object(o),
                }
            }
            b'"' => {
                let start = i;
                i += 1;
                while bytes[i] != b'"' {
                    if bytes[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                i += 1;
                // Preserve the existing documented lone-surrogate replacement.
                let v = omni_ir::js::parse_json(&text[start..i]).expect("validated string");
                let units: Vec<u16> = v.as_str().expect("string").encode_utf16().collect();
                if let Some(Frame::Object(_, key @ None)) = frames.last_mut() {
                    *key = Some(units);
                    continue;
                }
                JsValue::String(units)
            }
            b't' => {
                i += 4;
                JsValue::Bool(true)
            }
            b'f' => {
                i += 5;
                JsValue::Bool(false)
            }
            b'n' => {
                i += 4;
                JsValue::Null
            }
            _ => {
                let start = i;
                while i < bytes.len()
                    && matches!(bytes[i], b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')
                {
                    i += 1;
                }
                JsValue::Number(text[start..i].parse::<f64>().expect("validated number"))
            }
        };
        match frames.last_mut() {
            None => root = value,
            Some(Frame::Array(a)) => a.push(value),
            Some(Frame::Object(o, key)) => {
                let key = key.take().expect("validated property");
                if let Some((_, old)) = o.iter_mut().find(|(k, _)| *k == key) {
                    *old = value;
                } else {
                    o.push((key, value));
                }
            }
        }
    }
    Ok(root)
}

/// Array.join's recursive ToString, traversed without the native stack.
fn join(value: &JsValue) -> Result<String, String> {
    let mut out = String::new();
    let mut pending = vec![Some(value)];
    while let Some(next) = pending.pop() {
        let Some(v) = next else {
            out.push(',');
            continue;
        };
        match v {
            JsValue::Array(a) => {
                for (i, v) in a.iter().enumerate().rev() {
                    pending.push(Some(v));
                    if i > 0 {
                        pending.push(None);
                    }
                }
            }
            JsValue::Null | JsValue::Undefined => {}
            JsValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            JsValue::Number(n) if n.is_infinite() => out.push_str(if n.is_sign_negative() {
                "-Infinity"
            } else {
                "Infinity"
            }),
            JsValue::Number(n) => omni_ir::jsjson::write_number(*n, &mut out),
            JsValue::String(s) => out.push_str(&String::from_utf16_lossy(s)),
            JsValue::Object(fields) => {
                // OrdinaryToPrimitive with a string hint tries toString first.
                // JSON cannot contain callable own methods: any own toString
                // shadows Object.prototype.toString without replacing it with
                // a callable. Own valueOf is likewise noncallable; inherited
                // valueOf returns the object, never a primitive. __proto__ in
                // JSON.parse is only a data property, not a prototype change.
                if fields
                    .iter()
                    .any(|(key, _)| key.iter().copied().eq("toString".encode_utf16()))
                {
                    return Err("No default value".into());
                }
                out.push_str("[object Object]");
            }
            _ => out.push_str("[object Object]"),
        }
    }
    Ok(out)
}

pub fn models(value: &JsValue) -> Result<String, String> {
    match value {
        JsValue::Null => return Ok("all".into()),
        JsValue::Array(a) => {
            return if a.is_empty() {
                Ok("none".into())
            } else {
                join(value)
            };
        }
        JsValue::String(s) if s.is_empty() => return Ok("none".into()),
        _ => {}
    }
    let prop = |name: &str| {
        if let JsValue::Object(o) = value {
            o.iter()
                .find(|(k, _)| k.iter().copied().eq(name.encode_utf16()))
                .map(|(_, v)| v)
        } else {
            None
        }
    };
    if matches!(prop("length"),Some(JsValue::Number(n)) if *n == 0.0) {
        return Ok("none".into());
    }
    let description = match prop("join") {
        None => "undefined".into(),
        Some(JsValue::Object(_)) => "an instance of Object".into(),
        Some(JsValue::Array(_)) => "an instance of Array".into(),
        Some(JsValue::Number(n)) if n.is_infinite() => join(&JsValue::Number(*n))?,
        Some(v) => omni_ir::jsjson::stringify(v).unwrap_or_default(),
    };
    Err(format!(
        "key.modelAllowlist.join is not a function. (In 'key.modelAllowlist.join(\",\")', 'key.modelAllowlist.join' is {description})"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deep_coercion_error_and_pretty_listing_drop_on_small_stack() {
        std::thread::Builder::new().stack_size(256 * 1024).spawn(|| {
            // A duplicate property discards a deep object before coercion;
            // another deep value survives until the later error unwinds.
            let deep = format!("{}0{}", "{\"x\":".repeat(20_000), "}".repeat(20_000));
            let value = parse(&format!("[{deep},{{\"toString\":{deep},\"toString\":null}}]")).expect("parse");
            assert_eq!(models(&value), Err("No default value".into()));
            let earlier = parse(&format!("{}0{}", "[".repeat(512), "]".repeat(512))).expect("deep array");
            let later = parse("[{\"toString\":null}]").expect("error array");
            let listing = crate::keys::KeyListing {
                data: serde_json::json!({"keys":[{"modelAllowlist":null},{"modelAllowlist":null}]}),
                allowlists: vec![earlier, later],
            };
            assert_eq!(models(&listing.allowlists[0]).expect("earlier"), "0");
            assert_eq!(models(&listing.allowlists[1]), Err("No default value".into()));
            assert!(listing.json().contains("\"toString\": null"));
        }).expect("thread").join().expect("no overflow");
    }
    #[test]
    fn deep_parse_clone_join_and_drop_on_small_stack() {
        std::thread::Builder::new()
            .stack_size(256 * 1024)
            .spawn(|| {
                let input = format!("{}-1e400{}", "[".repeat(20_000), "]".repeat(20_000));
                let value = parse(&input).expect("parse");
                let cloned = value.clone();
                assert_eq!(models(&cloned).expect("join"), "-Infinity");
                assert!(
                    omni_ir::jsjson::stringify(&value)
                        .expect("json")
                        .contains("null")
                );
            })
            .expect("thread")
            .join()
            .expect("no overflow");
    }
}
