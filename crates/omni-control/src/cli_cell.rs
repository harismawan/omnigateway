//! Operator-only SQLite cell coercion, before JSON.parse's ToString.
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
