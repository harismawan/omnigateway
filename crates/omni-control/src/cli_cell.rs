//! Shared X3 operator cell semantics.
pub use omni_store::operator_cell::Cell;

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
