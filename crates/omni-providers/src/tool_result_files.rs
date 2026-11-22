//! A tool result's files, per wire (`packages/providers/src/toolResultFiles.ts`).

use omni_ir::request::FileBlock;
use serde_json::{Value, json};

const TEXTUAL: [&str; 11] = [
    "application/json",
    "application/x-ndjson",
    "application/xml",
    "application/yaml",
    "application/x-yaml",
    "application/toml",
    "application/javascript",
    "application/typescript",
    "application/sql",
    "application/x-sh",
    "message/rfc822",
];

/// Binary types a Responses `input_file` is accepted with, and the extension
/// a nameless one is given.
const RESPONSES_FILE_TYPES: [(&str, &str); 8] = [
    ("application/pdf", "pdf"),
    ("application/rtf", "rtf"),
    ("application/msword", "doc"),
    ("application/vnd.ms-excel", "xls"),
    ("application/vnd.ms-powerpoint", "ppt"),
    (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "docx",
    ),
    (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xlsx",
    ),
    (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pptx",
    ),
];

/// `isTextual`: text a model reads best as text.
pub fn is_textual(media_type: &str) -> bool {
    let first = media_type.split(';').next().unwrap_or_default();
    let t = omni_ir::js::trim(first).to_lowercase();
    t.starts_with("text/")
        || t.ends_with("+json")
        || t.ends_with("+xml")
        || TEXTUAL.contains(&t.as_str())
}

/// `fileText`: `Buffer.from(data, "base64").toString("utf8")`.
pub fn file_text(file: &FileBlock) -> String {
    String::from_utf8_lossy(&node_base64_decode(&file.data)).into_owned()
}

/// node's lenient base64 decoder, as `Buffer.from(s, "base64")` runs it.
///
/// Measured against bun 1.4.4, every rule below observable:
/// - each UTF-16 unit is truncated to its low byte first (`Ł`, U+0141, decodes
///   as `A`; a high surrogate U+D83D as `=`);
/// - both alphabets decode (`+/` and `-_`);
/// - any other byte is skipped;
/// - the first `=` ends decoding, whatever follows;
/// - a trailing single sextet contributes nothing.
pub fn node_base64_decode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for unit in s.encode_utf16() {
        let byte = unit.to_le_bytes()[0];
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff).to_le_bytes()[0]);
        }
    }
    out
}

/// `splitFiles`'s result: decoded text, carried files, and whether anything
/// could be sent neither way.
pub struct SplitFiles<'a> {
    pub text: Vec<String>,
    pub carried: Vec<&'a FileBlock>,
    pub dropped: bool,
}

/// `splitFiles`.
pub fn split_files<'a>(files: &'a [FileBlock], carries: impl Fn(&str) -> bool) -> SplitFiles<'a> {
    let mut split = SplitFiles {
        text: Vec::new(),
        carried: Vec::new(),
        dropped: false,
    };
    for file in files {
        if is_textual(&file.media_type) {
            split.text.push(file_text(file));
        } else if carries(&file.media_type) {
            split.carried.push(file);
        } else {
            split.dropped = true;
        }
    }
    split
}

/// `withFileText`: the result's text followed by its decoded text files.
pub fn with_file_text(content: &str, text: &[String]) -> String {
    std::iter::once(content)
        .chain(text.iter().map(String::as_str))
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn responses_extension(media_type: &str) -> Option<&'static str> {
    RESPONSES_FILE_TYPES
        .iter()
        .find(|(t, _)| *t == media_type)
        .map(|(_, ext)| *ext)
}

/// `fileName`: the file's own name, or `file.<ext>`.
pub fn file_name(file: &FileBlock) -> String {
    file.filename.clone().unwrap_or_else(|| {
        format!(
            "file.{}",
            responses_extension(&file.media_type).unwrap_or("bin")
        )
    })
}

/// `responsesFiles`'s result.
pub struct ResponsesFiles {
    pub parts: Vec<Value>,
    pub text: Vec<String>,
    pub dropped: bool,
}

/// `responsesFiles`: a Responses wire's split, carried files as `input_file`.
pub fn responses_files(files: &[FileBlock]) -> ResponsesFiles {
    let split = split_files(files, |t| responses_extension(t).is_some());
    let parts = split
        .carried
        .iter()
        .map(|file| {
            json!({
                "type": "input_file",
                "filename": file_name(file),
                "file_data": format!("data:{};base64,{}", file.media_type, file.data),
            })
        })
        .collect();
    ResponsesFiles {
        parts,
        text: split.text,
        dropped: split.dropped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_node_on_measured_inputs() {
        // Every pair measured with `Buffer.from(s, "base64")` on bun 1.4.4.
        let cases: [(&str, &[u8]); 30] = [
            ("aGk=", b"hi"),
            ("aGk", b"hi"),
            ("aG k=", b"hi"),
            ("a$Gk", b"hi"),
            ("aGk=aGk=", b"hi"),
            ("aGk-_w", &[104, 105, 62, 255]),
            ("Y", b""),
            ("=YQ", b""),
            ("Y=Q", b""),
            ("YQ=x", b"a"),
            ("YW==ZA", b"a"),
            ("YWJ=ZA", b"ab"),
            ("YWJjZ", b"abc"),
            ("YWJjZ=Q", b"abc"),
            ("Y===", b""),
            ("-_-_", &[251, 255, 191]),
            ("YWJj\u{e9}ZA", b"abcd"),
            ("YWJj\u{1F600}ZA", b"abc"),
            ("YWJjZAZ\u{1F600}A", &[97, 98, 99, 100, 6]),
            ("YWJjZA\u{1F600}", b"abcd"),
            ("YWJj\u{141}ZA", &[97, 98, 99, 1, 144]),
            ("YWJj\u{15a}ZA", &[97, 98, 99, 101, 144]),
            ("\u{159}\u{157}\u{14a}j", b"abc"),
            ("YWJj\u{13d}ZA", b"abc"),
            ("YWJj\u{12b}ZA", &[97, 98, 99, 249, 144]),
            ("YWJj\u{ffff}ZA", b"abcd"),
            ("YWJj\u{e000}ZA", b"abcd"),
            ("YWJj\u{65e5}ZA", b"abcd"),
            ("\u{0}YQ", b"a"),
            ("77u/aGk=", &[239, 187, 191, 104, 105]),
        ];
        for (input, expected) in cases {
            assert_eq!(node_base64_decode(input), expected, "{input:?}");
        }
    }

    #[test]
    fn textual_types_are_trimmed_and_case_folded() {
        assert!(is_textual(" Text/Markdown ; charset=utf-8"));
        assert!(is_textual("application/vnd.api+json"));
        assert!(is_textual("APPLICATION/JSON"));
        assert!(!is_textual("application/pdf"));
        assert!(!is_textual(""));
    }
}
