//! Shared X3 operator cell reader. Never use for auth/snapshot readers.
#[derive(Clone, Debug, PartialEq)]
pub enum Cell {
    Null,
    Number(f64),
    String(String),
    Bytes(Vec<u8>),
}
impl Cell {
    pub fn read(cell: rusqlite::types::ValueRef<'_>) -> Self {
        use rusqlite::types::ValueRef;
        match cell {
            ValueRef::Null => Self::Null,
            ValueRef::Integer(n) => Self::Number(n as f64),
            ValueRef::Real(n) => Self::Number(n),
            ValueRef::Text(b) => Self::String(String::from_utf8_lossy(b).into_owned()),
            ValueRef::Blob(b) => Self::Bytes(b.to_vec()),
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
