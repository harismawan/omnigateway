//! Operator-only SQLite cell coercion, before JSON.parse's ToString.
#[derive(Clone, Debug)]
pub enum Cell {
    Null,
    Number(f64),
    String(String),
    Bytes(Vec<u8>),
}

impl Cell {
    pub fn read(cell: rusqlite::types::ValueRef<'_>) -> Self {
        use rusqlite::types::Value;
        match crate::database::bun_cell(cell) {
            Value::Null => Self::Null,
            Value::Integer(n) => Self::Number(n as f64),
            Value::Real(n) => Self::Number(n),
            Value::Text(s) => Self::String(s),
            Value::Blob(b) => Self::Bytes(b),
        }
    }
    pub fn json(&self) -> omni_ir::jsjson::JsValue {
        use omni_ir::jsjson::JsValue;
        match self {
            Self::Null => JsValue::Null,
            Self::Number(n) => JsValue::Number(*n),
            Self::String(s) => JsValue::String(s.encode_utf16().collect()),
            Self::Bytes(b) => JsValue::Object(
                b.iter()
                    .enumerate()
                    .map(|(i, b)| {
                        (
                            i.to_string().encode_utf16().collect(),
                            JsValue::Number(f64::from(*b)),
                        )
                    })
                    .collect(),
            ),
        }
    }
}

/// Frozen output.table passes cells directly to stripAnsi's text.replace.
pub fn table_text(value: &omni_ir::jsjson::JsValue) -> Result<String, String> {
    use omni_ir::jsjson::JsValue;
    match value {
        JsValue::String(s) => Ok(String::from_utf16_lossy(s)),
        JsValue::Null => Err("null is not an object (evaluating 'text.replace')".into()),
        _ => Err("text.replace is not a function. (In 'text.replace(/\\u001b\\[[0-9;]*m/g, \"\")', 'text.replace' is undefined)".into()),
    }
}

/// ToString for a projected scalar cell (an object here is always a BLOB).
pub fn scalar_string(value: &omni_ir::jsjson::JsValue) -> String {
    use omni_ir::jsjson::JsValue;
    match value {
        JsValue::Object(fields) => fields
            .iter()
            .map(|(_, v)| scalar_string(v))
            .collect::<Vec<_>>()
            .join(","),
        JsValue::String(s) => String::from_utf16_lossy(s),
        JsValue::Number(n) => number(*n),
        JsValue::Null => "null".into(),
        _ => unreachable!("scalar SQLite cell"),
    }
}
/// Relational ToNumber for the four SQLite cell classes, including Uint8Array.
pub fn scalar_number(value: &omni_ir::jsjson::JsValue) -> f64 {
    use omni_ir::jsjson::JsValue;
    match value {
        JsValue::Number(n) => *n,
        JsValue::Null => 0.0,
        JsValue::String(_) | JsValue::Object(_) => {
            omni_ir::js::string_to_number(&scalar_string(value))
        }
        _ => f64::NAN,
    }
}
pub fn json(cell: rusqlite::types::ValueRef<'_>) -> Result<omni_ir::jsjson::JsValue, String> {
    crate::operator_json::parse(&string(cell))
}
pub fn string(cell: rusqlite::types::ValueRef<'_>) -> String {
    use rusqlite::types::Value;
    match crate::database::bun_cell(cell) {
        Value::Null => "null".into(),
        Value::Text(s) => s,
        Value::Blob(bytes) => bytes
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(","),
        Value::Integer(n) => number(n as f64),
        Value::Real(n) => number(n),
    }
}
fn number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n == f64::INFINITY {
        return "Infinity".into();
    }
    if n == f64::NEG_INFINITY {
        return "-Infinity".into();
    }
    let mut s = String::new();
    omni_ir::jsjson::write_number(n, &mut s);
    s
}

/// bun:sqlite binds safe integral JS numbers as INTEGER, except negative zero.
pub(crate) fn bind_number(n: f64) -> rusqlite::types::Value {
    if n.is_finite()
        && n.fract() == 0.0
        && n.abs() <= 9_007_199_254_740_991.0
        && !(n == 0.0 && n.is_sign_negative())
    {
        rusqlite::types::Value::Integer(n as i64)
    } else {
        rusqlite::types::Value::Real(n)
    }
}

#[cfg(test)]
mod binding_tests {
    use super::bind_number;
    use rusqlite::types::Value;

    #[test]
    fn bun_number_binding_boundary() {
        for n in [0.0, 2.0, 2_147_483_648.0, 9_007_199_254_740_991.0] {
            assert!(matches!(bind_number(n), Value::Integer(_)));
        }
        for n in [-0.0, 2.5, 9_007_199_254_740_992.0, 1e20, f64::INFINITY] {
            assert!(matches!(bind_number(n), Value::Real(_)));
        }
    }
}
