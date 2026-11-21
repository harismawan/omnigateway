//! `JSON.stringify` parity against vectors exported from the TS build.
//!
//! Each vector's input is a tagged description (f64 bit patterns, UTF-16 code
//! units, key order) because plain JSON cannot carry `-0`, `NaN` or lone
//! surrogates. The test rebuilds the JS value as a [`JsValue`] and requires the
//! writer to produce exactly what `JSON.stringify` produced.

use omni_ir::jsjson::{JsValue, stringify};
use serde_json::Value;

#[test]
fn serde_value_round_trip_keeps_js_number_format() {
    // A parsed client body re-serialized for the wire: integers stay integers,
    // floats print shortest-round-trip, and whole floats print without `.0`.
    let parsed: Value =
        serde_json::from_str(r#"{"a":1,"b":1.0,"c":1e21,"d":0.1,"e":-0.0,"f":[1.5e-7]}"#)
            .expect("parse");
    let js = JsValue::from(&parsed);
    assert_eq!(
        stringify(&js).as_deref(),
        Some(r#"{"a":1,"b":1,"c":1e+21,"d":0.1,"e":0,"f":[1.5e-7]}"#)
    );
}

#[test]
fn integer_like_keys_hoist_ahead_of_string_keys_like_v8() {
    let parsed: Value =
        serde_json::from_str(r#"{"b":1,"10":2,"a":3,"2":4,"01":5}"#).expect("parse");
    assert_eq!(
        stringify(&JsValue::from(&parsed)).as_deref(),
        Some(r#"{"2":4,"10":2,"b":1,"a":3,"01":5}"#)
    );
}

/// The linear top-level extractor agrees with the full parse (`JSON.parse`
/// semantics) on what the top-level `model` is: the last duplicate, an
/// escaped spelling of the key, never a nested or quoted look-alike.
#[test]
fn top_level_string_agrees_with_the_full_parse() {
    use omni_ir::jsjson::{parse_js, top_level_string};
    let cases = [
        r#"{"model":"a"}"#,
        r#"  {  "model"  :  "a"  ,  "x"  :  1  }  "#,
        "{\n\t\"model\"\r:\n\"a\"\n}",
        r#"{"model":"a","model":"b"}"#,
        r#"{"model":"a","model":1}"#,
        r#"{"model":1,"model":"b"}"#,
        r#"{"model":"a","model":null,"model":"\ud800"}"#,
        r#"{"mod\u0065l":"escaped key"}"#,
        r#"{"model\u0000":"not it","Model":"nor this"}"#,
        r#"{"x":{"model":"nested"},"y":[{"model":"deeper"}]}"#,
        r#"{"x":{"model":"nested"},"model":"top","y":[{"model":"deeper"}]}"#,
        r#"{"x":"\"model\":\"quoted\"","model":"real"}"#,
        r#"{"x":"}]{[,\"","model":"after brackets in a string"}"#,
        r#"{"x":"ends with a backslash \\","model":"after"}"#,
        r#"{"x\"":"\\\"","model":"after escapes"}"#,
        r#"{"x":[1,[2,{"a":"]"}],"}"],"model":"after arrays"}"#,
        r#"{"x":-1.5e-3,"y":true,"z":null,"model":"after scalars"}"#,
        r#"{"model":"\ud800"}"#,
        r#"{"model":"\ud83d\ude00"}"#,
        r#"{"model":"\ud83d x \ude00"}"#,
        r#"{"model":"\ufffd"}"#,
        "{\"model\":\"\u{fffd}\"}",
        "{\"model\":\"\u{1f600} é\"}",
        r#"{"model":"\"\\\/\b\f\n\r\t"}"#,
        r#"{"model":""}"#,
        r#"{"model":{"model":"object"}}"#,
        r#"{"model":["array"]}"#,
        r#"{}"#,
        r#"{ }"#,
        r#"["model","a"]"#,
        r#""model""#,
        r#"1"#,
        r#"null"#,
        r#"{"a":{},"b":[],"model":"after empties"}"#,
        r#"{"a":{"b":{"c":{"d":[[[{"model":"x"}]]]}}},"model":"deep before"}"#,
    ];
    for text in cases {
        let parsed = parse_js(text).expect(text);
        let JsValue::Object(fields) = &parsed else {
            assert_eq!(top_level_string(text, "model"), None, "{text}");
            continue;
        };
        let want = fields
            .iter()
            .find(|(k, _)| k.iter().copied().eq("model".encode_utf16()))
            .and_then(|(_, v)| match v {
                JsValue::String(units) => Some(units.clone()),
                _ => None,
            });
        assert_eq!(top_level_string(text, "model"), want, "{text}");
    }
}

/// The extractor is total. Text no parser accepted (every truncation of a
/// body, with escapes and multi-byte characters cut anywhere) yields a value
/// or `None`, never a panic, and a member cut short contributes nothing.
#[test]
fn top_level_string_never_panics_on_text_that_is_not_json() {
    use omni_ir::jsjson::top_level_string;
    let bodies = [
        r#"{"model":"\ud800 \"é\" \\","x":{"model":["a",{"b":"]}"}]},"model":"😀\\"}"#,
        r#"{"modél":"�","model":"café\\\\","mod\u0065l":"\u00e9\ud83d\ude00"}"#,
        r#"{"model":"\u12"}"#,
        r#"{"model":"\uzzzz"}"#,
        r#"{"\uzzzz":"a","model":"b"}"#,
        r#"{"a":[[[{"#,
        r#"{"a":]]]}},"model":"x"}"#,
        r#"{,,,"model":"x"}"#,
        r#"{"model" "x"}"#,
        r#"{"model"::::"x"}"#,
        "{\"model\":\"é",
        "",
        "{",
        "\"",
        "\\",
    ];
    for body in bodies {
        for end in 0..=body.len() {
            if body.is_char_boundary(end) {
                let _ = top_level_string(&body[..end], "model");
            }
        }
    }
    assert_eq!(top_level_string(r#"{"model":"a\"#, "model"), None);
    assert_eq!(top_level_string(r#"{"model":"a"#, "model"), None);
    assert_eq!(top_level_string(r#"{"model":"\u12"}"#, "model"), None);
    assert_eq!(
        top_level_string(r#"{"model":"kept","model":"cut\"#, "model"),
        Some("kept".encode_utf16().collect())
    );
}
