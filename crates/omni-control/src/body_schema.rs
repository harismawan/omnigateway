//! The key-edit request schemas (`packages/control/src/schemas.ts`:
//! `keyCreateSchema`, `keyLimitsSchema`, `keyModelsSchema`, `keyExpirySchema`,
//! `keyGuardrailSchema`, `keySmartRoutingSchema`, and `limitConfigSchema` from
//! `@omni/ratelimit/catalog`) as zod 4.6.1 runs them, over [`JsValue`] so a
//! body's lone surrogates and out-of-range numbers survive, and
//! [`parse_or_throw`]'s message is `parseOrThrow`'s: the *first* issue, its
//! path `safeToken`-ed and dot-joined, `(root)` when empty.
//!
//! The evaluation order is zod's: object shape keys in declaration order (all
//! of them, no early exit), then unknown keys of a strict object (one
//! `unrecognized_keys` issue that does not abort), then refinements, which run
//! only when nothing before them aborted. A record iterates own keys in JS
//! order (array indices first), silently drops `__proto__`, and refuses a key
//! failing its own schema as `Invalid key in record`.
use omni_ir::jsjson::JsValue;

type Refine = (fn(&JsValue) -> bool, &'static str);

/// One schema node.
pub enum Z {
    /// `z.string()`, optionally `.trim()`, `.min()`, `.max()` (code points).
    Str {
        trim: bool,
        min: Option<usize>,
        max: Option<usize>,
    },
    /// `z.number()`, optionally `.int()`, `.positive()`, `.max()`.
    Num {
        int: bool,
        positive: bool,
        max: Option<f64>,
    },
    Bool,
    Arr(Box<Z>),
    Nullable(Box<Z>),
    Opt(Box<Z>),
    Default(Box<Z>, fn() -> JsValue),
    Obj {
        shape: Vec<(&'static str, Z)>,
        strict: bool,
        refine: Option<Refine>,
    },
    /// `z.record(z.string().min(1).max(key_max), value)`.
    Rec {
        key_max: usize,
        value: Box<Z>,
        refine: Option<Refine>,
    },
}

struct Issue {
    path: Vec<String>,
    detail: String,
    /// zod's `continue: true`: does not abort what encloses it.
    cont: bool,
}

impl Issue {
    fn new(detail: String, cont: bool) -> Self {
        Issue {
            path: Vec::new(),
            detail,
            cont,
        }
    }
}

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn lossy(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `getTypeName(parsedType(input), input)`.
pub(crate) fn received(v: Option<&JsValue>) -> String {
    match v {
        None | Some(JsValue::Undefined) => "undefined".into(),
        Some(JsValue::Null) => "null".into(),
        Some(JsValue::Bool(_)) => "boolean".into(),
        Some(JsValue::Number(n)) if n.is_nan() => "NaN".into(),
        Some(JsValue::Number(n)) if n.is_infinite() => {
            if *n > 0.0 { "Infinity" } else { "-Infinity" }.into()
        }
        Some(JsValue::Number(_)) => "number".into(),
        Some(JsValue::String(_)) => "string".into(),
        Some(JsValue::Array(_)) => "array".into(),
        Some(JsValue::Object(_) | JsValue::Function) => "object".into(),
    }
}

fn invalid_type(expected: &str, v: Option<&JsValue>) -> Issue {
    Issue::new(
        format!(
            "Invalid input: expected {expected}, received {}",
            received(v)
        ),
        false,
    )
}

fn number_text(n: f64) -> String {
    let mut s = String::new();
    omni_ir::jsjson::write_number(n, &mut s);
    s
}

/// `util.codePointLength`: a surrogate pair is one, a lone surrogate one.
fn code_points(s: &[u16]) -> usize {
    char::decode_utf16(s.iter().copied()).count()
}

fn is_ws(u: u16) -> bool {
    char::from_u32(u32::from(u)).is_some_and(omni_ir::js::is_js_whitespace)
}

/// `String.prototype.trim` on UTF-16 units.
pub fn trim_units(mut s: &[u16]) -> &[u16] {
    while s.first().is_some_and(|u| is_ws(*u)) {
        s = &s[1..];
    }
    while s.last().is_some_and(|u| is_ws(*u)) {
        s = &s[..s.len() - 1];
    }
    s
}

/// Own keys in JS enumeration order: canonical array indices ascending,
/// then the rest in insertion order.
fn js_order(fields: &[(Vec<u16>, JsValue)]) -> Vec<usize> {
    let mut indexed: Vec<(u32, usize)> = Vec::new();
    let mut named = Vec::new();
    for (i, (k, _)) in fields.iter().enumerate() {
        let index = k
            .iter()
            .all(|u| (48..=57).contains(u))
            .then(|| omni_ir::jsjson::array_index(&lossy(k)))
            .flatten();
        match index {
            Some(n) => indexed.push((n, i)),
            None => named.push(i),
        }
    }
    indexed.sort_unstable();
    indexed.into_iter().map(|(_, i)| i).chain(named).collect()
}

fn own<'a>(fields: &'a [(Vec<u16>, JsValue)], key: &str) -> Option<&'a JsValue> {
    fields
        .iter()
        .find(|(k, _)| k.iter().copied().eq(key.encode_utf16()))
        .map(|(_, v)| v)
}

fn aborted(issues: &[Issue]) -> bool {
    issues.iter().any(|i| !i.cont)
}

fn prefixed(seg: String, issues: Vec<Issue>, into: &mut Vec<Issue>) {
    for mut i in issues {
        i.path.insert(0, seg.clone());
        into.push(i);
    }
}

/// zod's parse: the issues, in report order, and the output (`None` is
/// `undefined`).
fn run(z: &Z, v: Option<&JsValue>) -> (Vec<Issue>, Option<JsValue>) {
    let v = v.filter(|v| !matches!(v, JsValue::Undefined));
    match z {
        Z::Str { trim, min, max } => {
            let Some(JsValue::String(s)) = v else {
                return (vec![invalid_type("string", v)], None);
            };
            let s = if *trim { trim_units(s) } else { s.as_slice() };
            let n = code_points(s);
            let mut issues = Vec::new();
            if let Some(min) = min
                && n < *min
            {
                issues.push(Issue::new(
                    format!("Too small: expected string to have >={min} characters"),
                    true,
                ));
            }
            if let Some(max) = max
                && n > *max
            {
                issues.push(Issue::new(
                    format!("Too big: expected string to have <={max} characters"),
                    true,
                ));
            }
            (issues, Some(JsValue::String(s.to_vec())))
        }
        Z::Num { int, positive, max } => {
            let Some(JsValue::Number(n)) =
                v.filter(|v| matches!(v, JsValue::Number(n) if n.is_finite()))
            else {
                return (vec![invalid_type("number", v)], None);
            };
            let n = *n;
            let mut issues = Vec::new();
            if *int {
                if n.fract() != 0.0 {
                    return (
                        vec![Issue::new(
                            "Invalid input: expected int, received number".into(),
                            false,
                        )],
                        Some(JsValue::Number(n)),
                    );
                }
                if n.abs() > 9_007_199_254_740_991.0 {
                    issues.push(Issue::new(
                        if n > 0.0 {
                            "Too big: expected int to be <=9007199254740991"
                        } else {
                            "Too small: expected int to be >=-9007199254740991"
                        }
                        .into(),
                        true,
                    ));
                }
            }
            if *positive && n <= 0.0 {
                issues.push(Issue::new(
                    "Too small: expected number to be >0".into(),
                    true,
                ));
            }
            if let Some(max) = max
                && n > *max
            {
                issues.push(Issue::new(
                    format!("Too big: expected number to be <={}", number_text(*max)),
                    true,
                ));
            }
            (issues, Some(JsValue::Number(n)))
        }
        Z::Bool => match v {
            Some(JsValue::Bool(b)) => (Vec::new(), Some(JsValue::Bool(*b))),
            _ => (vec![invalid_type("boolean", v)], None),
        },
        Z::Arr(elem) => {
            let Some(JsValue::Array(items)) = v else {
                return (vec![invalid_type("array", v)], None);
            };
            let mut issues = Vec::new();
            let mut out = Vec::with_capacity(items.len());
            for (i, item) in items.iter().enumerate() {
                let (inner, value) = run(elem, Some(item));
                prefixed(i.to_string(), inner, &mut issues);
                out.push(value.unwrap_or(JsValue::Undefined));
            }
            (issues, Some(JsValue::Array(out)))
        }
        Z::Nullable(inner) => match v {
            Some(JsValue::Null) => (Vec::new(), Some(JsValue::Null)),
            _ => run(inner, v),
        },
        Z::Opt(inner) => match v {
            None => (Vec::new(), None),
            _ => run(inner, v),
        },
        Z::Default(inner, default) => match v {
            None => (Vec::new(), Some(default())),
            _ => {
                let (issues, out) = run(inner, v);
                (issues, Some(out.unwrap_or_else(default)))
            }
        },
        Z::Obj {
            shape,
            strict,
            refine,
        } => {
            let Some(JsValue::Object(fields)) = v else {
                return (vec![invalid_type("object", v)], None);
            };
            let mut issues = Vec::new();
            let mut out = Vec::new();
            for (key, field) in shape {
                let value = own(fields, key);
                // `.optional()` and an absent key: nothing, not even issues.
                if value.is_none() && matches!(field, Z::Opt(_)) {
                    continue;
                }
                let (inner, result) = run(field, value);
                prefixed((*key).to_owned(), inner, &mut issues);
                if let Some(result) = result {
                    out.push((units(key), result));
                }
            }
            if *strict {
                let unknown = js_order(fields)
                    .into_iter()
                    .map(|i| &fields[i].0)
                    .find(|k| {
                        !shape
                            .iter()
                            .any(|(s, _)| k.iter().copied().eq(s.encode_utf16()))
                    });
                if let Some(k) = unknown {
                    issues.push(Issue::new(
                        format!(
                            "unrecognized key \"{}\"",
                            omni_ir::js::safe_token(&lossy(k))
                        ),
                        true,
                    ));
                }
            }
            let out = JsValue::Object(out);
            if let Some((check, message)) = refine
                && !aborted(&issues)
                && !check(&out)
            {
                issues.push(Issue::new((*message).into(), true));
            }
            (issues, Some(out))
        }
        Z::Rec {
            key_max,
            value,
            refine,
        } => {
            let Some(JsValue::Object(fields)) = v else {
                return (vec![invalid_type("record", v)], None);
            };
            let mut issues = Vec::new();
            let mut out = Vec::new();
            for i in js_order(fields) {
                let (key, item) = &fields[i];
                if key.iter().copied().eq("__proto__".encode_utf16()) {
                    continue;
                }
                let n = code_points(key);
                if n < 1 || n > *key_max {
                    let mut issue = Issue::new("Invalid key in record".into(), false);
                    issue.path.push(lossy(key));
                    issues.push(issue);
                    continue;
                }
                let (inner, result) = run(value, Some(item));
                prefixed(lossy(key), inner, &mut issues);
                out.push((key.clone(), result.unwrap_or(JsValue::Undefined)));
            }
            let out = JsValue::Object(out);
            if let Some((check, message)) = refine
                && !aborted(&issues)
                && !check(&out)
            {
                issues.push(Issue::new((*message).into(), true));
            }
            (issues, Some(out))
        }
    }
}

/// `parseOrThrow(schema, body)`: the output, or the `BAD_REQUEST` message.
pub fn parse_or_throw(z: &Z, body: &JsValue) -> Result<JsValue, String> {
    let (issues, out) = run(z, Some(body));
    match issues.into_iter().next() {
        None => Ok(out.unwrap_or(JsValue::Undefined)),
        Some(issue) => {
            let path = if issue.path.is_empty() {
                "(root)".to_owned()
            } else {
                issue
                    .path
                    .iter()
                    .map(|s| omni_ir::js::safe_token(s))
                    .collect::<Vec<_>>()
                    .join(".")
            };
            Err(format!("{path}: {}", issue.detail))
        }
    }
}

// ------------------------------------------------------------ the schemas

fn opt(z: Z) -> Z {
    Z::Opt(Box::new(z))
}
fn nullable(z: Z) -> Z {
    Z::Nullable(Box::new(z))
}
fn count_limit() -> Z {
    opt(nullable(Z::Num {
        int: true,
        positive: true,
        max: None,
    }))
}
fn count_windows() -> Z {
    Z::Obj {
        shape: vec![
            ("1m", count_limit()),
            ("5h", count_limit()),
            ("1w", count_limit()),
        ],
        strict: true,
        refine: None,
    }
}
fn spend_windows() -> Z {
    let spend = || {
        opt(nullable(Z::Num {
            int: false,
            positive: true,
            max: None,
        }))
    };
    Z::Obj {
        shape: vec![("5h", spend()), ("1w", spend())],
        strict: true,
        refine: None,
    }
}
fn base_shape() -> Vec<(&'static str, Z)> {
    vec![
        ("requests", opt(count_windows())),
        ("tokens", opt(count_windows())),
        ("spend", opt(spend_windows())),
        ("concurrency", count_limit()),
    ]
}

/// `setsAnyLimit` over a parsed scope.
fn sets_any_limit(scope: &JsValue) -> bool {
    let set = |v: Option<&JsValue>| v.is_some_and(|v| !matches!(v, JsValue::Null));
    let JsValue::Object(fields) = scope else {
        return false;
    };
    if set(own(fields, "concurrency")) {
        return true;
    }
    ["requests", "tokens", "spend"].iter().any(|d| {
        matches!(own(fields, d), Some(JsValue::Object(w))
            if ["1m", "5h", "1w"].iter().any(|k| set(own(w, k))))
    })
}

fn at_most_64(models: &JsValue) -> bool {
    matches!(models, JsValue::Object(f) if f.len() <= 64)
}

/// `limitConfigSchema`.
pub fn limit_config() -> Z {
    let mut shape = base_shape();
    shape.push((
        "models",
        opt(Z::Rec {
            key_max: 256,
            value: Box::new(Z::Obj {
                shape: base_shape(),
                strict: true,
                refine: Some((
                    sets_any_limit,
                    "a model override must set at least one limit; omit the model to remove it",
                )),
            }),
            refine: Some((at_most_64, "at most 64 model overrides per key")),
        }),
    ));
    Z::Obj {
        shape,
        strict: true,
        refine: None,
    }
}

const MAX_INSTANT: f64 = 8_640_000_000_000_000.0;

fn expires_at() -> Z {
    nullable(Z::Num {
        int: true,
        positive: true,
        max: Some(MAX_INSTANT),
    })
}
fn guardrail_policy() -> Z {
    nullable(Z::Str {
        trim: true,
        min: Some(1),
        max: Some(4000),
    })
}
fn allowlist() -> Z {
    nullable(Z::Arr(Box::new(Z::Str {
        trim: false,
        min: Some(1),
        max: None,
    })))
}
fn strict(shape: Vec<(&'static str, Z)>) -> Z {
    Z::Obj {
        shape,
        strict: true,
        refine: None,
    }
}

/// `keyCreateSchema`.
pub fn key_create() -> Z {
    let d = |z: Z, v: fn() -> JsValue| Z::Default(Box::new(z), v);
    strict(vec![
        (
            "label",
            d(
                Z::Str {
                    trim: false,
                    min: Some(1),
                    max: None,
                },
                || JsValue::String(units("api key")),
            ),
        ),
        ("modelAllowlist", d(allowlist(), || JsValue::Null)),
        ("limits", d(limit_config(), || JsValue::Object(Vec::new()))),
        ("bodyLoggingOptOut", d(Z::Bool, || JsValue::Bool(false))),
        ("expiresAt", d(expires_at(), || JsValue::Null)),
        ("guardrailPolicy", d(guardrail_policy(), || JsValue::Null)),
        ("smartRouting", d(Z::Bool, || JsValue::Bool(false))),
    ])
}

/// `keyLimitsSchema`.
pub fn key_limits() -> Z {
    strict(vec![("limits", limit_config())])
}
/// `keyModelsSchema`.
pub fn key_models() -> Z {
    strict(vec![("modelAllowlist", allowlist())])
}
/// `keyExpirySchema`.
pub fn key_expiry() -> Z {
    strict(vec![("expiresAt", expires_at())])
}
/// `keyGuardrailSchema`.
pub fn key_guardrail() -> Z {
    strict(vec![("policy", guardrail_policy())])
}
/// `keySmartRoutingSchema`.
pub fn key_smart_routing() -> Z {
    strict(vec![("enabled", Z::Bool)])
}

/// Every schema by its TS export name, for the oracle test.
pub fn by_name(name: &str) -> Option<Z> {
    Some(match name {
        "keyCreateSchema" => key_create(),
        "keyLimitsSchema" => key_limits(),
        "keyModelsSchema" => key_models(),
        "keyExpirySchema" => key_expiry(),
        "keyGuardrailSchema" => key_guardrail(),
        "keySmartRoutingSchema" => key_smart_routing(),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {}

#[cfg(test)]
mod vectors {}
