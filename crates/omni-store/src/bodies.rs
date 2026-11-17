//! Frozen body masking and bounding. UTF-16 carriers are intentional: masking
//! and uncut bounding preserve lone surrogates, while TextEncoder truncation
//! replaces them only when an over-budget string is actually encoded/cut.
use omni_ir::jsjson::JsValue;

pub const MAX_STRING_BYTES: usize = 64 * 1024;
pub const MAX_ARRAY_ITEMS: usize = 24;
pub const MAX_DEPTH: usize = 6;
pub const MAX_OBJECT_KEYS: usize = 80;
const MARKER: &str = "…[truncated]";

fn ascii(c: u16) -> Option<u8> {
    u8::try_from(c).ok().filter(u8::is_ascii)
}
fn word(c: u16) -> bool {
    ascii(c).is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
}
fn token(c: u16) -> bool {
    word(c) || c == u16::from(b'-')
}
fn starts(s: &[u16], p: &str) -> bool {
    s.len() >= p.len() && s.iter().copied().take(p.len()).eq(p.bytes().map(u16::from))
}

/// The ordered five-rule chain, on code units rather than lossy Rust strings.
pub fn mask_string(value: &[u16]) -> Vec<u16> {
    let mut current = value.to_vec();
    for rule in 0..5 {
        let mut out = Vec::with_capacity(current.len());
        let mut i = 0;
        while i < current.len() {
            let tail = &current[i..];
            let boundary = i == 0 || !token(current[i - 1]);
            let mut matched = None;
            if rule == 0
                && (i == 0 || !word(current[i - 1]))
                && tail.len() >= 6
                && tail[..6]
                    .iter()
                    .zip(b"bearer")
                    .all(|(c, b)| ascii(*c).is_some_and(|a| a.eq_ignore_ascii_case(b)))
            {
                let mut end = 6;
                while end < tail.len()
                    && char::from_u32(u32::from(tail[end]))
                        .is_some_and(omni_ir::js::is_js_whitespace)
                {
                    end += 1;
                }
                let keep = end;
                while end < tail.len()
                    && ascii(tail[end])
                        .is_some_and(|b| b.is_ascii_alphanumeric() || b"._~+/=-".contains(&b))
                {
                    end += 1;
                }
                if keep > 6 && end > keep {
                    matched = Some((keep, end));
                }
            } else if rule == 4 && token(tail[0]) {
                let end = tail.iter().take_while(|c| token(**c)).count();
                if end >= 41 {
                    matched = Some((0, end));
                }
            } else if boundary {
                let prefixes: &[&str] = match rule {
                    1 => &["sk-", "ak-", "pk-"],
                    2 => &[
                        "ghp_",
                        "gho_",
                        "ghs_",
                        "ghu_",
                        "github_pat_",
                        "AIza",
                        "GOCSPX-",
                    ],
                    3 => &["xai-"],
                    _ => &[],
                };
                for prefix in prefixes {
                    if starts(tail, prefix) {
                        let mut end = prefix.len();
                        while end < tail.len()
                            && if rule == 3 {
                                word(tail[end])
                            } else {
                                token(tail[end])
                            }
                        {
                            end += 1;
                        }
                        if end >= prefix.len() + 8 {
                            matched = Some((prefix.len(), end));
                        }
                        break;
                    }
                }
            }
            if let Some((keep, end)) = matched {
                out.extend_from_slice(&tail[..keep]);
                out.extend("[redacted]".encode_utf16());
                i += end;
            } else {
                out.push(current[i]);
                i += 1;
            }
        }
        current = out;
    }
    current
}

pub fn mask_secrets(value: &JsValue) -> JsValue {
    match value {
        JsValue::String(s) => JsValue::String(mask_string(s)),
        JsValue::Array(a) => {
            omni_ir::deep::grow(|| JsValue::Array(a.iter().map(mask_secrets).collect()))
        }
        JsValue::Object(o) => omni_ir::deep::grow(|| {
            JsValue::Object(
                o.iter()
                    .map(|(k, v)| (k.clone(), mask_secrets(v)))
                    .collect(),
            )
        }),
        _ => value.clone(),
    }
}

fn index(key: &[u16]) -> Option<u32> {
    let s = String::from_utf16(key).ok()?;
    let n: u32 = s.parse().ok()?;
    (n != u32::MAX && n.to_string() == s).then_some(n)
}

pub fn bound_value(value: &JsValue) -> (JsValue, bool) {
    fn walk(v: &JsValue, depth: usize, cut: &mut bool) -> JsValue {
        match v {
            JsValue::String(s) => {
                let encoded = String::from_utf16_lossy(s);
                if encoded.len() <= MAX_STRING_BYTES {
                    return v.clone();
                }
                *cut = true;
                let prefix = &encoded.as_bytes()[..MAX_STRING_BYTES - MARKER.len() - 3];
                // TextDecoder consumes a leading UTF-8 BOM by default.
                let decoded = String::from_utf8_lossy(prefix);
                let text = decoded
                    .strip_prefix('\u{feff}')
                    .unwrap_or(&decoded)
                    .to_owned()
                    + MARKER;
                JsValue::String(text.encode_utf16().collect())
            }
            JsValue::Array(_) | JsValue::Object(_) if depth > MAX_DEPTH => {
                *cut = true;
                JsValue::String("[omitted: nesting past 6 levels]".encode_utf16().collect())
            }
            JsValue::Array(a) => {
                let start = a.len().saturating_sub(MAX_ARRAY_ITEMS);
                *cut |= start != 0;
                JsValue::Array(a[start..].iter().map(|x| walk(x, depth + 1, cut)).collect())
            }
            JsValue::Object(o) => {
                let mut entries: Vec<_> = o.iter().collect();
                entries.sort_by_key(|(k, _)| index(k).map_or((1, 0), |n| (0, n)));
                *cut |= entries.len() > MAX_OBJECT_KEYS;
                JsValue::Object(
                    entries
                        .into_iter()
                        .take(MAX_OBJECT_KEYS)
                        .map(|(k, v)| (k.clone(), walk(v, depth + 1, cut)))
                        .collect(),
                )
            }
            _ => v.clone(),
        }
    }
    let mut cut = false;
    (walk(value, 1, &mut cut), cut)
}

fn get<'a>(value: &'a JsValue, key: &str) -> &'a JsValue {
    if let JsValue::Object(entries) = value
        && let Some((_, v)) = entries
            .iter()
            .find(|(k, _)| k.iter().copied().eq(key.encode_utf16()))
    {
        return v;
    }
    static NULL: JsValue = JsValue::Null;
    &NULL
}

fn object(entries: &[(&str, JsValue)]) -> JsValue {
    JsValue::Object(
        entries
            .iter()
            .map(|(k, v)| (k.encode_utf16().collect(), v.clone()))
            .collect(),
    )
}

fn pair(value: &JsValue) -> (JsValue, JsValue, bool) {
    let (request, a) = bound_value(&mask_secrets(get(value, "request")));
    let (response, b) = bound_value(&mask_secrets(get(value, "response")));
    (
        request,
        response,
        a || b || matches!(get(value, "truncated"), JsValue::Bool(true)),
    )
}

/// `prepareArtifact`: mask before bounding, then whole-artifact omission.
/// The caller must still seal the result, which refuses an oversized frame.
pub fn prepare_artifact(input: &JsValue) -> (JsValue, String) {
    let (request, response, truncated) = pair(get(input, "client"));
    let client = object(&[
        ("request", request),
        ("response", response),
        ("truncated", JsValue::Bool(truncated)),
    ]);
    let attempts = match get(input, "attempts") {
        JsValue::Array(a) => a
            .iter()
            .map(|a| {
                let (request, response, truncated) = pair(a);
                let (chunks, cut) = bound_value(&mask_secrets(get(a, "streamChunks")));
                object(&[
                    ("attempt", get(a, "attempt").clone()),
                    ("provider", get(a, "provider").clone()),
                    ("request", request),
                    ("response", response),
                    ("streamChunks", chunks),
                    ("truncated", JsValue::Bool(truncated || cut)),
                ])
            })
            .collect(),
        _ => Vec::new(),
    };
    let (error, _) = bound_value(&mask_secrets(get(input, "error")));
    let mut artifact = object(&[
        ("schemaVersion", JsValue::Number(1.0)),
        ("requestId", get(input, "requestId").clone()),
        ("at", get(input, "at").clone()),
        ("client", client),
        ("attempts", JsValue::Array(attempts)),
        ("error", error),
    ]);
    let json = omni_ir::jsjson::stringify(&artifact).expect("artifact object");
    if json.len() <= crate::pg::bodies::MAX_ARTIFACT_BYTES {
        return (artifact, json);
    }
    let marker = object(&[
        ("omitted", JsValue::Bool(true)),
        (
            "reason",
            JsValue::String(
                "artifact exceeded 524288 bytes after structural bounding"
                    .encode_utf16()
                    .collect(),
            ),
        ),
        ("serializedBytes", JsValue::Number(json.len() as f64)),
    ]);
    if let JsValue::Object(fields) = &mut artifact {
        for (key, value) in fields.iter_mut() {
            if key.iter().copied().eq("client".encode_utf16()) {
                *value = object(&[
                    ("request", marker.clone()),
                    ("response", marker.clone()),
                    ("truncated", JsValue::Bool(true)),
                ]);
            } else if key.iter().copied().eq("attempts".encode_utf16())
                && let JsValue::Array(attempts) = value
            {
                for a in attempts {
                    *a = object(&[
                        ("attempt", get(a, "attempt").clone()),
                        ("provider", get(a, "provider").clone()),
                        ("request", marker.clone()),
                        ("response", marker.clone()),
                        ("streamChunks", JsValue::Null),
                        ("truncated", JsValue::Bool(true)),
                    ]);
                }
            }
        }
    }
    let json = omni_ir::jsjson::stringify(&artifact).expect("artifact object");
    if json.len() <= crate::pg::bodies::MAX_ARTIFACT_BYTES {
        return (artifact, json);
    }
    if let JsValue::Object(fields) = &mut artifact
        && let Some((_, error)) = fields
            .iter_mut()
            .find(|(k, _)| k.iter().copied().eq("error".encode_utf16()))
    {
        *error = marker;
    }
    let json = omni_ir::jsjson::stringify(&artifact).expect("artifact object");
    (artifact, json)
}
