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

impl std::hash::Hash for Text {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        match &self.0 {
            Repr::Utf8(s) => s.encode_utf16().for_each(|u| state.write_u16(u)),
            Repr::Utf16(units) => units.iter().for_each(|u| state.write_u16(*u)),
        }
        state.write_u16(0);
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

impl From<&String> for Text {
    fn from(text: &String) -> Self {
        Self::from(text.as_str())
    }
}

impl From<&Text> for Text {
    fn from(text: &Text) -> Self {
        text.clone()
    }
}

impl PartialEq<str> for Text {
    fn eq(&self, other: &str) -> bool {
        match &self.0 {
            Repr::Utf8(text) => text == other,
            Repr::Utf16(units) => other.encode_utf16().eq(units.iter().copied()),
        }
    }
}

impl PartialEq<&str> for Text {
    fn eq(&self, other: &&str) -> bool {
        self == *other
    }
}

impl Text {
    pub fn as_utf8(&self) -> Option<&str> {
        match &self.0 {
            Repr::Utf8(text) => Some(text),
            Repr::Utf16(_) => None,
        }
    }

    /// For boundaries that require UTF-8 (e.g. hashing with TextEncoder).
    pub fn to_utf8_lossy(&self) -> std::borrow::Cow<'_, str> {
        match &self.0 {
            Repr::Utf8(text) => std::borrow::Cow::Borrowed(text),
            Repr::Utf16(units) => String::from_utf16_lossy(units).into(),
        }
    }

    pub fn to_utf16(&self) -> Vec<u16> {
        match &self.0 {
            Repr::Utf8(text) => text.encode_utf16().collect(),
            Repr::Utf16(units) => units.clone(),
        }
    }

    /// Conservative retained size for both storage and escaped JSON output.
    pub fn len(&self) -> usize {
        match &self.0 {
            Repr::Utf8(text) => text.len(),
            Repr::Utf16(units) => units.len().saturating_mul(6),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn surrounded(&self, prefix: &str, suffix: &str) -> Self {
        let mut text = Self::from(prefix);
        text.push(self);
        text.push(&Self::from(suffix));
        text
    }

    /// Ordinary Rust JSON APIs require UTF-8. For a lossless JSON boundary,
    /// use `write_json` instead, including when a fragment is itself JSON.
    pub fn with_json_source<R>(&self, f: impl FnOnce(&str) -> R) -> R {
        if let Some(text) = self.as_utf8() {
            return f(text);
        }
        // JS JSON.parse accepts literal lone surrogates in a string. Escape a
        // lone unit in that lexical position; do not make invalid JSON valid.
        let Repr::Utf16(units) = &self.0 else {
            unreachable!()
        };
        let mut source = String::new();
        let (mut in_string, mut escaped) = (false, false);
        for value in char::decode_utf16(units.iter().copied()) {
            match value {
                Ok(ch) => {
                    source.push(ch);
                    if escaped {
                        escaped = false;
                    } else if in_string && ch == '\\' {
                        escaped = true;
                    } else if ch == '"' {
                        in_string = !in_string;
                    }
                }
                Err(unit) if in_string && !escaped => {
                    use std::fmt::Write;
                    write!(source, "\\u{:04x}", unit.unpaired_surrogate())
                        .expect("writing into String cannot fail");
                }
                Err(_) => source.push('\0'),
            }
        }
        f(&source)
    }

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
