//! Lossless JavaScript text, with a UTF-8 fast path for ordinary strings.
//!
//! No `Deref<str>` or lossy conversion: callers must explicitly handle UTF-16.
//! JSON output uses the same lone-surrogate escaping as `JSON.stringify`.
#[derive(Debug, Clone, Eq)]
pub struct Text(Repr);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Repr {
    Utf8(String),
    Utf16(Vec<u16>),
}

impl Default for Text {
    fn default() -> Self {
        Self::from(String::new())
    }
}

impl PartialEq for Text {
    fn eq(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (Repr::Utf8(a), Repr::Utf8(b)) => a == b,
            (Repr::Utf16(a), Repr::Utf16(b)) => a == b,
            (Repr::Utf8(a), Repr::Utf16(b)) | (Repr::Utf16(b), Repr::Utf8(a)) => {
                a.encode_utf16().eq(b.iter().copied())
            }
        }
    }
}

impl From<String> for Text {
    fn from(text: String) -> Self {
        Self(Repr::Utf8(text))
    }
}

impl From<&str> for Text {
    fn from(text: &str) -> Self {
        Self::from(text.to_owned())
    }
}

impl Text {
    pub fn from_utf16(units: Vec<u16>) -> Self {
        match String::from_utf16(&units) {
            Ok(text) => Self::from(text),
            Err(_) => Self(Repr::Utf16(units)),
        }
    }

    /// Concatenates code units, including a surrogate pair split across chunks.
    pub fn push(&mut self, other: &Self) {
        match (&mut self.0, &other.0) {
            (Repr::Utf8(left), Repr::Utf8(right)) => left.push_str(right),
            (Repr::Utf8(left), Repr::Utf16(right)) => {
                let mut units: Vec<u16> = left.encode_utf16().collect();
                units.extend_from_slice(right);
                self.0 = Repr::Utf16(units);
            }
            (Repr::Utf16(left), right) => {
                match right {
                    Repr::Utf8(right) => left.extend(right.encode_utf16()),
                    Repr::Utf16(right) => left.extend_from_slice(right),
                }
                // Do not rescan the accumulated prefix on every chunk. The
                // JSON writer combines any pairs repaired at chunk boundaries.
            }
        }
    }

    pub fn write_json(&self, out: &mut String) {
        match &self.0 {
            Repr::Utf8(text) => crate::jsjson::write_str(text, out),
            Repr::Utf16(units) => crate::jsjson::write_utf16(units, out),
        }
    }
}
