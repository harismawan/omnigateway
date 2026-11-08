//! `api_keys.limits`, parsed as `parseLimitConfig` in
//! `packages/ratelimit/src/catalog.ts` parses it.
//!
//! The names are a storage contract and the schema is strict: an unknown key,
//! a zero, a fraction where a count belongs, or a `__proto__` anywhere is a
//! refusal, never a silent drop. A refused row reads as `limits: None` on the
//! key, which is "unreadable" and is refused at auth; it must never collapse
//! into "unlimited".
//!
//! Every pair is tri-state, as in TS: absent (`None`), explicit `null`
//! (`Some(None)`, also unlimited), or a ceiling (`Some(Some(n))`). The two
//! unlimited spellings are kept apart only so the value re-serializes exactly.

use indexmap::IndexMap;
use serde_json::{Map, Value};

/// `MAX_MODEL_OVERRIDES`.
pub const MAX_MODEL_OVERRIDES: usize = 64;
/// `MAX_MODEL_NAME_LENGTH`, in code points (zod 4.6's `max` on a string).
pub const MAX_MODEL_NAME_LENGTH: usize = 256;

/// `WINDOW_MS`: every window is counted sliding.
pub const WINDOW_MS_1M: u64 = 60_000;
pub const WINDOW_MS_5H: u64 = 5 * 60 * 60 * 1000;
pub const WINDOW_MS_1W: u64 = 7 * 24 * 60 * 60 * 1000;

/// Absent, explicit null, or a value.
pub type Pair<T> = Option<Option<T>>;

/// `countWindows`: `requests` or `tokens` at the three windows.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CountWindows {
    pub one_minute: Pair<u64>,
    pub five_hours: Pair<u64>,
    pub one_week: Pair<u64>,
}

/// `spendWindows`: dollars, so fractional, and no `1m`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SpendWindows {
    pub five_hours: Pair<f64>,
    pub one_week: Pair<f64>,
}

/// `LimitConfigBase`: one scope's sparse matrix, key-wide or one model's.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LimitScope {
    pub requests: Option<CountWindows>,
    pub tokens: Option<CountWindows>,
    pub spend: Option<SpendWindows>,
    /// In-flight requests right now; not a window.
    pub concurrency: Pair<u64>,
}

/// `LimitConfig`: the key-wide scope plus per-model overrides that stack on it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LimitConfig {
    pub base: LimitScope,
    /// Keyed by the requested model exactly. Every override sets at least one
    /// ceiling; `Some(empty)` is a stored `"models":{}`.
    pub models: Option<IndexMap<String, LimitScope>>,
}

fn set<T: Copy>(pair: Pair<T>) -> Option<T> {
    pair.flatten()
}

impl CountWindows {
    fn sets_any(&self) -> bool {
        [self.one_minute, self.five_hours, self.one_week]
            .into_iter()
            .any(|p| set(p).is_some())
    }
}

impl SpendWindows {
    fn sets_any(&self) -> bool {
        set(self.five_hours).is_some() || set(self.one_week).is_some()
    }
}

impl LimitScope {
    /// `setsAnyLimit`: whether any ceiling is set, rather than only nulls and empties.
    pub fn sets_any_limit(&self) -> bool {
        set(self.concurrency).is_some()
            || self.requests.as_ref().is_some_and(CountWindows::sets_any)
            || self.tokens.as_ref().is_some_and(CountWindows::sets_any)
            || self.spend.as_ref().is_some_and(SpendWindows::sets_any)
    }

    fn to_json(&self) -> Map<String, Value> {
        let mut out = Map::new();
        let pair_u = |p: Option<u64>| p.map_or(Value::Null, Value::from);
        let pair_f = |p: Option<f64>| {
            p.and_then(serde_json::Number::from_f64)
                .map_or(Value::Null, Value::Number)
        };
        let count = |w: &CountWindows| {
            let mut m = Map::new();
            for (name, p) in [
                ("1m", w.one_minute),
                ("5h", w.five_hours),
                ("1w", w.one_week),
            ] {
                if let Some(p) = p {
                    m.insert(name.to_owned(), pair_u(p));
                }
            }
            Value::Object(m)
        };
        if let Some(w) = &self.requests {
            out.insert("requests".to_owned(), count(w));
        }
        if let Some(w) = &self.tokens {
            out.insert("tokens".to_owned(), count(w));
        }
        if let Some(w) = &self.spend {
            let mut m = Map::new();
            for (name, p) in [("5h", w.five_hours), ("1w", w.one_week)] {
                if let Some(p) = p {
                    m.insert(name.to_owned(), pair_f(p));
                }
            }
            out.insert("spend".to_owned(), Value::Object(m));
        }
        if let Some(p) = self.concurrency {
            out.insert("concurrency".to_owned(), pair_u(p));
        }
        out
    }
}

impl LimitConfig {
    /// `modelOverride`: the override one model carries. An own-key lookup, so
    /// `constructor` is a model name like any other.
    pub fn model_override(&self, model: &str) -> Option<&LimitScope> {
        self.models.as_ref()?.get(model)
    }

    /// No ceiling anywhere. Overrides always set one, so any override counts.
    pub fn is_unlimited(&self) -> bool {
        !self.base.sets_any_limit() && self.models.as_ref().is_none_or(IndexMap::is_empty)
    }

    /// The value zod's parse returns, as `JSON.stringify` would see it: schema
    /// key order, absent pairs omitted, explicit nulls kept.
    pub fn to_json(&self) -> Value {
        let mut out = self.base.to_json();
        if let Some(models) = &self.models {
            let m: Map<String, Value> = models
                .iter()
                .map(|(k, scope)| (k.clone(), Value::Object(scope.to_json())))
                .collect();
            out.insert("models".to_owned(), Value::Object(m));
        }
        Value::Object(out)
    }
}

impl serde::Serialize for LimitConfig {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(s)
    }
}

/// `parseLimits` in `packages/store/src/sqlite/keys.ts`: `JSON.parse`, then
/// `parseLimitConfig`, with any failure read as unreadable (`None`).
pub fn parse_limits(raw: &str) -> Option<LimitConfig> {
    let value: Value = serde_json::from_str(raw).ok()?;
    parse_limit_config(&value)
}

/// `parseLimitConfig` over an already-parsed value.
pub fn parse_limit_config(value: &Value) -> Option<LimitConfig> {
    if names_proto(value) {
        return None;
    }
    let obj = value.as_object()?;
    let mut base_fields = Map::new();
    let mut models = None;
    for (k, v) in obj {
        if k == "models" {
            models = Some(parse_models(v)?);
        } else {
            base_fields.insert(k.clone(), v.clone());
        }
    }
    Some(LimitConfig {
        base: parse_scope(&base_fields)?,
        models,
    })
}

/// `assertNoProto`: `__proto__` as a key at any depth is refused, because zod
/// would otherwise drop it and report a ceiling stored that never was.
fn names_proto(value: &Value) -> bool {
    match value {
        Value::Object(m) => m.iter().any(|(k, v)| k == "__proto__" || names_proto(v)),
        Value::Array(items) => items.iter().any(names_proto),
        _ => false,
    }
}

fn parse_models(value: &Value) -> Option<IndexMap<String, LimitScope>> {
    let obj = value.as_object()?;
    let mut out = IndexMap::with_capacity(obj.len());
    for (name, scope) in obj {
        let points = name.chars().count();
        if !(1..=MAX_MODEL_NAME_LENGTH).contains(&points) {
            return None;
        }
        let scope = parse_scope(scope.as_object()?)?;
        if !scope.sets_any_limit() {
            return None;
        }
        out.insert(name.clone(), scope);
    }
    (out.len() <= MAX_MODEL_OVERRIDES).then_some(out)
}

/// `limitConfigBaseSchema`, strict.
fn parse_scope(obj: &Map<String, Value>) -> Option<LimitScope> {
    let mut scope = LimitScope::default();
    for (k, v) in obj {
        match k.as_str() {
            "requests" => scope.requests = Some(parse_count_windows(v)?),
            "tokens" => scope.tokens = Some(parse_count_windows(v)?),
            "spend" => scope.spend = Some(parse_spend_windows(v)?),
            "concurrency" => scope.concurrency = Some(count_limit(v)?),
            _ => return None,
        }
    }
    Some(scope)
}

fn parse_count_windows(value: &Value) -> Option<CountWindows> {
    let mut w = CountWindows::default();
    for (k, v) in value.as_object()? {
        let limit = Some(count_limit(v)?);
        match k.as_str() {
            "1m" => w.one_minute = limit,
            "5h" => w.five_hours = limit,
            "1w" => w.one_week = limit,
            _ => return None,
        }
    }
    Some(w)
}

fn parse_spend_windows(value: &Value) -> Option<SpendWindows> {
    let mut w = SpendWindows::default();
    for (k, v) in value.as_object()? {
        let limit = Some(spend_limit(v)?);
        match k.as_str() {
            "5h" => w.five_hours = limit,
            "1w" => w.one_week = limit,
            _ => return None,
        }
    }
    Some(w)
}

/// `z.number().int().positive().nullable()`. zod's `int` is a safe integer.
fn count_limit(value: &Value) -> Option<Option<u64>> {
    if value.is_null() {
        return Some(None);
    }
    let n = value.as_f64()?;
    if !is_safe_integer(n) || n <= 0.0 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    Some(Some(n as u64))
}

/// `z.number().positive().nullable()`: finite and above zero.
fn spend_limit(value: &Value) -> Option<Option<f64>> {
    if value.is_null() {
        return Some(None);
    }
    let n = value.as_f64()?;
    (n.is_finite() && n > 0.0).then_some(Some(n))
}

/// `Number.isSafeInteger(v)`.
fn is_safe_integer(v: f64) -> bool {
    v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0
}
