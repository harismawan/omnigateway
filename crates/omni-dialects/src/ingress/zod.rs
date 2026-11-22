//! The subset of zod 4.6.1 semantics the ingress schemas implement.
//!
//! The parsers send the *first* issue's message to the client, so the
//! contract is not only accept/reject but which issue comes first and how it
//! is worded. That depends on zod's evaluation order (shape keys in
//! declaration order, then unknown keys), on which issues "abort"
//! (a union keeps the one option whose issues all `continue`), and on the
//! English locale's message templates. All of that is byte-stable wire
//! behavior (clients match on the messages).
//!
//! [`check`] reports issues; [`rebuild`] produces zod's *output* for a value
//! that passed, which differs from the input where it is read back: object
//! keys come out in schema order, a stripped object loses unknown keys, a
//! record loses a top-level `__proto__`, and a `.default()` fills in.

use serde_json::{Map, Value};

use omni_ir::deep::Owned;

use super::js_keys;

/// One schema node.
#[derive(Debug)]
pub enum Z {
    /// `z.string()` with optional `.min()` / `.max()` (code points).
    Str {
        min: Option<usize>,
        max: Option<usize>,
    },
    /// `z.number()`, optionally `.int()` and `.positive()`.
    Num {
        int: bool,
        positive: bool,
    },
    Bool,
    Null,
    Unknown,
    /// `z.literal(x)` (one value) or `z.enum([...])` (several).
    OneOf(&'static [&'static str]),
    /// `.refine(v => v !== null, { message })`.
    NotNull(Box<Z>, &'static str),
    Arr {
        elem: Box<Z>,
        min: Option<usize>,
    },
    Obj {
        shape: Vec<(&'static str, Z)>,
        strict: bool,
    },
    /// `z.record(z.string(), value)`.
    Rec(Box<Z>),
    Union(Vec<Z>),
    /// `z.discriminatedUnion(key, options)`; each option is an `Obj` whose
    /// `key` field is a `OneOf`.
    Disc(&'static str, Vec<Z>),
    Opt(Box<Z>),
    Nullable(Box<Z>),
    /// `.default({})`, the only default the schemas use.
    DefaultEmptyObject(Box<Z>),
}

pub fn str() -> Z {
    Z::Str {
        min: None,
        max: None,
    }
}
pub fn str_min(min: usize) -> Z {
    Z::Str {
        min: Some(min),
        max: None,
    }
}
pub fn str_max(max: usize) -> Z {
    Z::Str {
        min: None,
        max: Some(max),
    }
}
pub fn str_between(min: usize, max: usize) -> Z {
    Z::Str {
        min: Some(min),
        max: Some(max),
    }
}
pub fn num() -> Z {
    Z::Num {
        int: false,
        positive: false,
    }
}
pub fn int() -> Z {
    Z::Num {
        int: true,
        positive: false,
    }
}
pub fn pos_int() -> Z {
    Z::Num {
        int: true,
        positive: true,
    }
}
pub fn one_of(values: &'static [&'static str]) -> Z {
    Z::OneOf(values)
}
pub fn arr(elem: Z) -> Z {
    Z::Arr {
        elem: Box::new(elem),
        min: None,
    }
}
pub fn arr_min(elem: Z, min: usize) -> Z {
    Z::Arr {
        elem: Box::new(elem),
        min: Some(min),
    }
}
pub fn obj(shape: Vec<(&'static str, Z)>) -> Z {
    Z::Obj {
        shape,
        strict: false,
    }
}
pub fn strict(shape: Vec<(&'static str, Z)>) -> Z {
    Z::Obj {
        shape,
        strict: true,
    }
}
pub fn rec() -> Z {
    Z::Rec(Box::new(Z::Unknown))
}
pub fn opt(z: Z) -> Z {
    Z::Opt(Box::new(z))
}
pub fn nullable(z: Z) -> Z {
    Z::Nullable(Box::new(z))
}
pub fn nullish(z: Z) -> Z {
    opt(nullable(z))
}

/// The `cache_control` schema.
pub fn cache_control() -> Z {
    obj(vec![
        ("type", one_of(&["ephemeral"])),
        ("ttl", opt(one_of(&["5m", "1h"]))),
    ])
}

/// `REASONING_EFFORTS`.
pub const EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, PartialEq)]
pub enum Seg {
    Key(String),
    Index(usize),
}

impl Seg {
    pub fn as_string(&self) -> String {
        match self {
            Seg::Key(k) => k.clone(),
            Seg::Index(i) => i.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Kind {
    /// `expected` is zod's own name ("string", "int", "record", "nonoptional").
    InvalidType {
        expected: &'static str,
        received: &'static str,
    },
    InvalidValue(&'static [&'static str]),
    TooSmallLength {
        origin: &'static str,
        unit: &'static str,
        minimum: usize,
    },
    TooBigLength {
        origin: &'static str,
        unit: &'static str,
        maximum: usize,
    },
    NotPositive,
    UnsafeIntTooBig,
    UnsafeIntTooSmall,
    UnrecognizedKeys(Vec<String>),
    InvalidUnion,
    NoDiscriminator(Vec<&'static str>),
    Custom(&'static str),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Issue {
    pub path: Vec<Seg>,
    pub kind: Kind,
    /// zod's `continue: true`: does not abort the enclosing parse.
    pub cont: bool,
    /// zod's `continue: false`: aborts even checks that have a `when`.
    pub explicit_abort: bool,
}

impl Issue {
    fn new(kind: Kind) -> Issue {
        Issue {
            path: Vec::new(),
            kind,
            cont: false,
            explicit_abort: false,
        }
    }

    fn continuing(kind: Kind) -> Issue {
        Issue {
            cont: true,
            ..Issue::new(kind)
        }
    }

    /// The English locale's message.
    pub fn message(&self) -> String {
        match &self.kind {
            Kind::InvalidType { expected, received } => {
                format!("Invalid input: expected {expected}, received {received}")
            }
            Kind::InvalidValue(values) if values.len() == 1 => {
                format!("Invalid input: expected \"{}\"", values[0])
            }
            Kind::InvalidValue(values) => {
                let joined: Vec<String> = values.iter().map(|v| format!("\"{v}\"")).collect();
                format!("Invalid option: expected one of {}", joined.join("|"))
            }
            Kind::TooSmallLength {
                origin,
                unit,
                minimum,
            } => format!("Too small: expected {origin} to have >={minimum} {unit}"),
            Kind::TooBigLength {
                origin,
                unit,
                maximum,
            } => format!("Too big: expected {origin} to have <={maximum} {unit}"),
            Kind::NotPositive => "Too small: expected number to be >0".into(),
            Kind::UnsafeIntTooBig => "Too big: expected int to be <=9007199254740991".into(),
            Kind::UnsafeIntTooSmall => "Too small: expected int to be >=-9007199254740991".into(),
            Kind::UnrecognizedKeys(keys) => {
                let joined: Vec<String> = keys.iter().map(|k| format!("\"{k}\"")).collect();
                let s = if keys.len() > 1 { "s" } else { "" };
                format!("Unrecognized key{s}: {}", joined.join(", "))
            }
            Kind::InvalidUnion => "Invalid input".into(),
            Kind::NoDiscriminator(options) => {
                let opts: Vec<String> = options.iter().map(|o| format!("'{o}'")).collect();
                format!("Invalid discriminator value. Expected {}", opts.join(" | "))
            }
            Kind::Custom(message) => (*message).into(),
        }
    }
}

/// `util.parsedType`, for a JSON value (`None` is `undefined`).
pub fn parsed_type(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

#[derive(Clone, Copy, PartialEq)]
enum OptIn {
    Optional,
    Defaulted,
}

fn optin(z: &Z) -> Option<OptIn> {
    match z {
        Z::Opt(inner) => Some(if optin(inner) == Some(OptIn::Defaulted) {
            OptIn::Defaulted
        } else {
            OptIn::Optional
        }),
        Z::Nullable(inner) => optin(inner),
        Z::DefaultEmptyObject(_) => Some(OptIn::Defaulted),
        Z::Union(options) => {
            if options.iter().any(|o| optin(o) == Some(OptIn::Defaulted)) {
                Some(OptIn::Defaulted)
            } else if options.iter().any(|o| optin(o).is_some()) {
                Some(OptIn::Optional)
            } else {
                None
            }
        }
        _ => None,
    }
}

fn optout(z: &Z) -> bool {
    match z {
        Z::Opt(_) => true,
        Z::Nullable(inner) => optout(inner),
        Z::Union(options) => options.iter().any(optout),
        _ => false,
    }
}

/// `util.aborted`: any issue without `continue: true`.
fn aborted(issues: &[Issue]) -> bool {
    issues.iter().any(|i| !i.cont)
}

fn prefix(seg: Seg, mut issues: Vec<Issue>) -> Vec<Issue> {
    for i in &mut issues {
        i.path.insert(0, seg.clone());
    }
    issues
}

fn code_points(s: &str) -> usize {
    s.chars().count()
}

/// The discriminator values of one option, in declaration order.
fn disc_values<'z>(option: &'z Z, key: &str) -> &'z [&'static str] {
    if let Z::Obj { shape, .. } = option
        && let Some((_, Z::OneOf(values))) = shape.iter().find(|(k, _)| *k == key)
    {
        return values;
    }
    &[]
}

fn check_object(shape: &[(&'static str, Z)], strict: bool, map: &Map<String, Value>) -> Vec<Issue> {
    let mut issues = Vec::new();
    for (key, field) in shape {
        let v = map.get(*key);
        let present = v.is_some();
        let result = check(field, v);
        let fin = optin(field);
        let fout = optout(field);
        if !present && fout && fin == Some(OptIn::Optional) {
            continue;
        }
        if !result.is_empty() {
            if fin.is_some() && fout && !present {
                continue;
            }
            issues.extend(prefix(Seg::Key((*key).to_string()), result.clone()));
        }
        if !present && fin.is_none() && result.is_empty() {
            let mut i = Issue::new(Kind::InvalidType {
                expected: "nonoptional",
                received: "undefined",
            });
            i.path.push(Seg::Key((*key).to_string()));
            issues.push(i);
        }
    }
    if strict {
        let unknown: Vec<String> = js_keys(map)
            .into_iter()
            .filter(|k| !shape.iter().any(|(s, _)| s == k))
            .map(str::to_string)
            .collect();
        if !unknown.is_empty() {
            issues.push(Issue::continuing(Kind::UnrecognizedKeys(unknown)));
        }
    }
    issues
}

/// Runs `z` on `value` (`None` is `undefined`) and returns its issues, in the
/// order zod reports them.
pub fn check(z: &Z, value: Option<&Value>) -> Vec<Issue> {
    omni_ir::deep::grow(|| check_inner(z, value))
}

fn check_inner(z: &Z, value: Option<&Value>) -> Vec<Issue> {
    match z {
        Z::Str { min, max } => {
            let Some(Value::String(s)) = value else {
                return vec![Issue::new(Kind::InvalidType {
                    expected: "string",
                    received: parsed_type(value),
                })];
            };
            if min.is_none() && max.is_none() {
                return Vec::new();
            }
            let n = code_points(s);
            let mut issues = Vec::new();
            if let Some(min) = *min
                && n < min
            {
                issues.push(Issue::continuing(Kind::TooSmallLength {
                    origin: "string",
                    unit: "characters",
                    minimum: min,
                }));
            }
            if let Some(max) = *max
                && n > max
            {
                issues.push(Issue::continuing(Kind::TooBigLength {
                    origin: "string",
                    unit: "characters",
                    maximum: max,
                }));
            }
            issues
        }
        Z::Num { int, positive } => {
            let Some(Value::Number(n)) = value else {
                return vec![Issue::new(Kind::InvalidType {
                    expected: "number",
                    received: parsed_type(value),
                })];
            };
            let x = omni_ir::js::number_value(n);
            let mut issues = Vec::new();
            if *int {
                if x.fract() != 0.0 {
                    // `continue: false`: the checks after it do not run.
                    return vec![Issue {
                        explicit_abort: true,
                        ..Issue::new(Kind::InvalidType {
                            expected: "int",
                            received: "number",
                        })
                    }];
                }
                const SAFE: f64 = 9_007_199_254_740_991.0;
                if x > SAFE {
                    issues.push(Issue::continuing(Kind::UnsafeIntTooBig));
                } else if x < -SAFE {
                    issues.push(Issue::continuing(Kind::UnsafeIntTooSmall));
                }
            }
            if *positive && x <= 0.0 {
                issues.push(Issue::continuing(Kind::NotPositive));
            }
            issues
        }
        Z::Bool => match value {
            Some(Value::Bool(_)) => Vec::new(),
            _ => vec![Issue::new(Kind::InvalidType {
                expected: "boolean",
                received: parsed_type(value),
            })],
        },
        Z::Null => match value {
            Some(Value::Null) => Vec::new(),
            _ => vec![Issue::new(Kind::InvalidType {
                expected: "null",
                received: parsed_type(value),
            })],
        },
        Z::Unknown => Vec::new(),
        Z::OneOf(values) => match value {
            Some(Value::String(s)) if values.contains(&s.as_str()) => Vec::new(),
            _ => vec![Issue::new(Kind::InvalidValue(values))],
        },
        Z::NotNull(inner, message) => {
            let mut issues = check(inner, value);
            if !aborted(&issues) && matches!(value, Some(Value::Null)) {
                issues.push(Issue::continuing(Kind::Custom(message)));
            }
            issues
        }
        Z::Arr { elem, min } => {
            let Some(Value::Array(items)) = value else {
                return vec![Issue::new(Kind::InvalidType {
                    expected: "array",
                    received: parsed_type(value),
                })];
            };
            let mut issues = Vec::new();
            for (i, item) in items.iter().enumerate() {
                issues.extend(prefix(Seg::Index(i), check(elem, Some(item))));
            }
            // A length check has a `when`, so only `continue: false` skips it.
            if let Some(min) = *min
                && items.len() < min
                && !issues.iter().any(|i| i.explicit_abort)
            {
                issues.push(Issue::continuing(Kind::TooSmallLength {
                    origin: "array",
                    unit: "items",
                    minimum: min,
                }));
            }
            issues
        }
        Z::Obj { shape, strict } => {
            let Some(Value::Object(map)) = value else {
                return vec![Issue::new(Kind::InvalidType {
                    expected: "object",
                    received: parsed_type(value),
                })];
            };
            check_object(shape, *strict, map)
        }
        Z::Rec(inner) => {
            let Some(Value::Object(map)) = value else {
                return vec![Issue::new(Kind::InvalidType {
                    expected: "record",
                    received: parsed_type(value),
                })];
            };
            let mut issues = Vec::new();
            for key in js_keys(map) {
                if key == "__proto__" {
                    continue;
                }
                issues.extend(prefix(
                    Seg::Key(key.to_string()),
                    check(inner, map.get(key)),
                ));
            }
            issues
        }
        Z::Union(options) => {
            let mut results = Vec::with_capacity(options.len());
            for o in options {
                let r = check(o, value);
                if r.is_empty() {
                    return r;
                }
                results.push(r);
            }
            let mut live = results.into_iter().filter(|r| !aborted(r));
            match (live.next(), live.next()) {
                (Some(only), None) => only,
                _ => vec![Issue::new(Kind::InvalidUnion)],
            }
        }
        Z::Disc(key, options) => {
            let Some(Value::Object(map)) = value else {
                return vec![Issue::new(Kind::InvalidType {
                    expected: "object",
                    received: parsed_type(value),
                })];
            };
            let tag = map.get(*key).and_then(Value::as_str);
            if let Some(tag) = tag
                && let Some(option) = options.iter().find(|o| disc_values(o, key).contains(&tag))
            {
                return check(option, value);
            }
            let all: Vec<&'static str> = options
                .iter()
                .flat_map(|o| disc_values(o, key).iter().copied())
                .collect();
            let mut i = Issue::new(Kind::NoDiscriminator(all));
            i.path.push(Seg::Key((*key).to_string()));
            vec![i]
        }
        Z::Opt(inner) => match value {
            None => Vec::new(),
            Some(_) => check(inner, value),
        },
        Z::Nullable(inner) => match value {
            Some(Value::Null) => Vec::new(),
            _ => check(inner, value),
        },
        Z::DefaultEmptyObject(inner) => match value {
            None => Vec::new(),
            Some(_) => check(inner, value),
        },
    }
}

/// zod's output for a value [`check`] accepted (`None` stays absent).
pub fn rebuild(z: &Z, value: Option<&Value>) -> Option<Value> {
    omni_ir::deep::grow(|| rebuild_inner(z, value))
}

fn rebuild_inner(z: &Z, value: Option<&Value>) -> Option<Value> {
    match z {
        Z::Arr { elem, .. } => match value {
            Some(Value::Array(items)) => Some(Value::Array(
                items
                    .iter()
                    .map(|v| rebuild(elem, Some(v)).unwrap_or(Value::Null))
                    .collect(),
            )),
            other => other.map(omni_ir::deep::clone),
        },
        Z::Obj { shape, .. } => match value {
            Some(Value::Object(map)) => Some(rebuild_object(shape, map)),
            other => other.map(omni_ir::deep::clone),
        },
        Z::Rec(inner) => match value {
            Some(Value::Object(map)) => {
                let mut out = Map::new();
                for key in js_keys(map) {
                    if key == "__proto__" {
                        continue;
                    }
                    if let Some(r) = rebuild(inner, map.get(key)) {
                        omni_ir::deep::insert(&mut out, key.to_string(), r);
                    }
                }
                Some(Value::Object(out))
            }
            other => other.map(omni_ir::deep::clone),
        },
        Z::Union(options) => {
            let chosen = options.iter().find(|o| check(o, value).is_empty());
            match chosen {
                Some(o) => rebuild(o, value),
                None => value.map(omni_ir::deep::clone),
            }
        }
        Z::Disc(key, options) => {
            let tag = value.and_then(|v| v.get(*key)).and_then(Value::as_str);
            match tag.and_then(|t| options.iter().find(|o| disc_values(o, key).contains(&t))) {
                Some(o) => rebuild(o, value),
                None => value.map(omni_ir::deep::clone),
            }
        }
        Z::Opt(inner) | Z::Nullable(inner) | Z::NotNull(inner, _) => match value {
            None => None,
            Some(Value::Null) if !matches!(z, Z::NotNull(..)) => Some(Value::Null),
            Some(_) => rebuild(inner, value),
        },
        Z::DefaultEmptyObject(inner) => match value {
            None => Some(Value::Object(Map::new())),
            Some(_) => rebuild(inner, value),
        },
        Z::Str { .. } | Z::Num { .. } | Z::Bool | Z::Null | Z::Unknown | Z::OneOf(_) => {
            value.map(omni_ir::deep::clone)
        }
    }
}

/// [`parse`] of an object given as its map, without wrapping it in a `Value`.
pub fn parse_map(z: &Z, map: &Map<String, Value>) -> Result<Owned, Issue> {
    match z {
        Z::Obj { shape, strict } => {
            let mut issues = check_object(shape, *strict, map);
            if issues.is_empty() {
                Ok(Owned(rebuild_object(shape, map)))
            } else {
                Err(issues.swap_remove(0))
            }
        }
        _ => unreachable!("parse_map takes an object schema"),
    }
}

fn rebuild_object(shape: &[(&'static str, Z)], map: &Map<String, Value>) -> Value {
    let mut out = Map::new();
    for (key, field) in shape {
        if let Some(r) = rebuild(field, map.get(*key)) {
            omni_ir::deep::insert(&mut out, (*key).to_string(), r);
        }
    }
    Value::Object(out)
}

/// `safeParse` → the first issue, or the output (dropped iteratively).
pub fn parse(z: &Z, value: &Value) -> Result<Owned, Issue> {
    let mut issues = check(z, Some(value));
    if issues.is_empty() {
        Ok(Owned(rebuild(z, Some(value)).unwrap_or(Value::Null)))
    } else {
        Err(issues.swap_remove(0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn first(z: &Z, v: Value) -> String {
        let i = parse(z, &v).expect_err("rejected");
        let path: Vec<String> = i.path.iter().map(Seg::as_string).collect();
        format!("{}: {}", path.join("."), i.message())
    }

    #[test]
    fn a_union_keeps_the_one_option_whose_issues_continue() {
        let z = Z::Union(vec![
            obj(vec![("type", one_of(&["adaptive"]))]),
            obj(vec![
                ("type", one_of(&["enabled"])),
                ("budget_tokens", pos_int()),
            ]),
        ]);
        assert_eq!(
            first(&z, json!({"type": "enabled", "budget_tokens": 0})),
            "budget_tokens: Too small: expected number to be >0"
        );
        assert_eq!(
            first(&z, json!({"type": "enabled", "budget_tokens": 1.5})),
            ": Invalid input"
        );
    }

    #[test]
    fn a_required_unknown_is_nonoptional_and_an_optional_one_is_not() {
        let z = obj(vec![("a", Z::Unknown), ("b", opt(Z::Unknown))]);
        assert_eq!(
            first(&z, json!({})),
            "a: Invalid input: expected nonoptional, received undefined"
        );
    }

    #[test]
    fn strict_objects_report_unknown_keys_in_js_order() {
        let z = strict(vec![("a", str())]);
        let i = parse(&z, &json!({"a": "x", "z": 1, "5": 2})).expect_err("rejected");
        assert_eq!(i.kind, Kind::UnrecognizedKeys(vec!["5".into(), "z".into()]));
    }

    #[test]
    fn output_follows_the_schema_order_and_drops_proto_from_records() {
        let z = obj(vec![("b", Z::Unknown), ("a", rec())]);
        let v = serde_json::from_str::<Value>(r#"{"a":{"__proto__":1,"y":2},"x":0,"b":1}"#)
            .expect("json");
        assert_eq!(
            serde_json::to_string(&*parse(&z, &v).expect("ok")).expect("s"),
            r#"{"b":1,"a":{"y":2}}"#
        );
    }
}
