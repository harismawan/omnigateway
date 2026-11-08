//! The JavaScript coercions the TS decoders lean on, pinned against values
//! measured with bun 1.4.4.

use omni_ir::js;
use serde_json::{Value, json};

#[test]
fn string_coercion_matches_js_string() {
    let cases: [(Option<Value>, &str); 12] = [
        (None, "undefined"),
        (Some(Value::Null), "null"),
        (Some(json!(true)), "true"),
        (Some(json!(5)), "5"),
        (Some(json!(1.5)), "1.5"),
        (Some(json!(1e21)), "1e+21"),
        (Some(json!("s")), "s"),
        (Some(json!({"a": 1})), "[object Object]"),
        (Some(json!([1, [2, null]])), "1,2,"),
        (Some(json!([])), ""),
        (Some(json!([{}])), "[object Object]"),
        (Some(json!(-0.0)), "0"),
    ];
    for (value, expected) in cases {
        assert_eq!(js::to_string(value.as_ref()), expected, "{value:?}");
    }
}

#[test]
fn number_coercion_matches_js_number() {
    let cases: [(&str, f64); 18] = [
        ("", 0.0),
        (" ", 0.0),
        ("  7  ", 7.0),
        ("0x1F", 31.0),
        ("0X1f", 31.0),
        ("0b11", 3.0),
        ("0o7", 7.0),
        ("1e2", 100.0),
        ("+7", 7.0),
        ("-3", -3.0),
        ("5.", 5.0),
        (".5", 0.5),
        ("Infinity", f64::INFINITY),
        ("-Infinity", f64::NEG_INFINITY),
        ("\u{feff}\u{a0}4\u{2028}", 4.0),
        ("-0", -0.0),
        ("1.5e-3", 0.0015),
        ("00012", 12.0),
    ];
    for (s, expected) in cases {
        let got = js::string_to_number(s);
        assert!(
            got == expected && got.is_sign_negative() == expected.is_sign_negative(),
            "{s:?}: {got}"
        );
    }
    for s in [
        "5s", "abc", "1_0", "-0x1", "0x", ".", "e5", "1e", "++1", "infinity", "0b2", "1 2",
    ] {
        assert!(js::string_to_number(s).is_nan(), "{s:?}");
    }
    assert!(js::to_number(None).is_nan());
    assert_eq!(js::to_number(Some(&Value::Null)), 0.0);
    assert_eq!(js::to_number(Some(&json!(true))), 1.0);
    assert_eq!(js::to_number(Some(&json!("12"))), 12.0);
    assert_eq!(js::to_number(Some(&json!([5]))), 5.0);
    assert_eq!(js::to_number(Some(&json!([]))), 0.0);
    assert!(js::to_number(Some(&json!({}))).is_nan());
}

#[test]
fn truthiness_matches_js() {
    for falsy in [json!(null), json!(false), json!(0), json!(-0.0), json!("")] {
        assert!(!js::truthy(Some(&falsy)), "{falsy}");
    }
    assert!(!js::truthy(None));
    for truthy in [json!(1), json!("0"), json!([]), json!({}), json!(true)] {
        assert!(js::truthy(Some(&truthy)), "{truthy}");
    }
}

#[test]
fn utf16_helpers() {
    assert_eq!(js::utf16_len("a😀é"), 4);
    // A cut through a pair keeps the half as U+FFFD: what the TS string
    // (which keeps the lone surrogate) becomes when converted lossily.
    assert_eq!(js::utf16_prefix("ab😀c", 3), "ab\u{fffd}");
    assert_eq!(js::utf16_prefix("ab😀c", 4), "ab😀");
    assert_eq!(js::utf16_prefix("abc", 10), "abc");
}

#[test]
fn json_parse_accepts_lone_surrogate_escapes_as_replacement() {
    // JS keeps a lone surrogate; a Rust `String` cannot, so it becomes U+FFFD
    // rather than failing the whole parse (which would drop the chunk).
    assert_eq!(
        js::parse_json(r#"{"a":"x\ud83d","b":"\ud83d\ude00","c":"\\ud83d","d":"\udc00\ud800"}"#),
        Some(json!({"a": "x\u{fffd}", "b": "😀", "c": "\\ud83d", "d": "\u{fffd}\u{fffd}"}))
    );
    assert_eq!(js::parse_json("not json"), None);
    assert_eq!(js::parse_json(" 5 "), Some(json!(5)));
    // Duplicate keys: the first position, the last value, as JSON.parse.
    assert_eq!(
        js::parse_json(r#"{"a":1,"b":2,"a":3}"#).map(|v| omni_ir::jsjson::to_string(&v)),
        Some(r#"{"a":3,"b":2}"#.to_string())
    );
}

#[test]
fn safe_token_and_math_helpers() {
    use omni_ir::js::{math_max, math_min, math_round, safe_token};
    assert_eq!(safe_token("claude-opus-4"), "claude-opus-4");
    assert_eq!(safe_token("a/b:c+d.e_f"), "a/b:c+d.e_f");
    assert_eq!(safe_token(""), "(unprintable)");
    assert_eq!(safe_token("has space"), "(unprintable)");
    assert_eq!(safe_token(&"x".repeat(64)), "x".repeat(64));
    assert_eq!(safe_token(&"x".repeat(65)), "(unprintable)");
    assert_eq!(safe_token("café"), "(unprintable)");
    assert!(math_min(1.0, f64::NAN).is_nan());
    assert!(math_max(f64::NAN, 1.0).is_nan());
    assert_eq!(math_min(1.0, 2.0), 1.0);
    assert_eq!(math_round(2.5), 3.0);
    assert_eq!(math_round(-2.5), -2.0);
}

/// `Math.round` against Bun's, bit for bit (sign of zero included).
#[test]
fn math_round_equals_js_math_round() {
    use omni_ir::js::math_round;
    let mut inputs: Vec<f64> = vec![
        0.49999999999999994,
        0.5,
        -0.5,
        1.5,
        -1.5,
        2.5,
        -2.5,
        0.0,
        -0.0,
        1e-300,
        -1e-300,
        -0.4999999999999999,
        -0.49999999999999994,
        -0.5000000000000001,
        4503599627370497.0,
        9007199254740991.0,
        -4503599627370497.0,
        -9007199254740991.0,
        4503599627370495.5,
        1e300,
        -1e300,
        f64::MAX,
        f64::MIN,
        f64::MIN_POSITIVE,
        -f64::MIN_POSITIVE,
        5e-324,
        -5e-324,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NAN,
        1999.9999999999998,
        0.7,
        -0.7,
        123.5,
        -123.5,
    ];
    let mut seed = 0x1234_5678_9abc_def0_u64;
    for _ in 0..2000 {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        let x = f64::from_bits(seed);
        if x.is_finite() {
            inputs.push(x);
            inputs.push(x.fract() + 0.5);
        }
    }
    let ok = std::process::Command::new("bun")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !ok {
        println!("skipping: bun is not on PATH");
        return;
    }
    // Bits as hex strings, so NaN, ±0 and ±Inf survive the trip.
    let hex: Vec<String> = inputs
        .iter()
        .map(|x| format!("{:016x}", x.to_bits()))
        .collect();
    let script = r#"
const xs = JSON.parse(await Bun.stdin.text());
const b = new DataView(new ArrayBuffer(8));
console.log(JSON.stringify(xs.map((h) => {
  b.setBigUint64(0, BigInt("0x" + h)); const r = Math.round(b.getFloat64(0));
  b.setFloat64(0, r); return b.getBigUint64(0).toString(16).padStart(16, "0");
})));
"#;
    let file = std::env::temp_dir().join(format!("omni-round-{}.ts", std::process::id()));
    std::fs::write(&file, script).expect("script");
    let mut child = std::process::Command::new("bun")
        .arg(&file)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("bun");
    use std::io::Write as _;
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(serde_json::to_string(&hex).expect("json").as_bytes())
        .expect("write");
    let out = child.wait_with_output().expect("out");
    let ts: Vec<String> = serde_json::from_slice(&out.stdout).expect("ts");
    for (x, expected) in inputs.iter().zip(ts) {
        let got = math_round(*x);
        let got_hex = format!("{:016x}", got.to_bits());
        // Any NaN is NaN.
        if x.is_nan() {
            assert!(got.is_nan());
            continue;
        }
        assert_eq!(got_hex, expected, "Math.round({x:e})");
    }
}

#[test]
fn spread_writes_match_js_object_spread() {
    use omni_ir::jsjson::{Spread, write_spread};
    let map = |s: &str| {
        serde_json::from_str::<serde_json::Value>(s)
            .expect("json")
            .as_object()
            .expect("obj")
            .clone()
    };
    let w = |m: &serde_json::Map<String, serde_json::Value>, sp| {
        let mut out = String::new();
        write_spread(m, "type", "T", sp, &mut out);
        out
    };
    // `{ ...data, type }`
    assert_eq!(
        w(&map(r#"{"a":1}"#), Spread::KeyLast),
        r#"{"a":1,"type":"T"}"#
    );
    assert_eq!(
        w(&map(r#"{"a":1,"type":"x","b":2}"#), Spread::KeyLast),
        r#"{"a":1,"type":"T","b":2}"#
    );
    assert_eq!(
        w(&map(r#"{"b":1,"2":2}"#), Spread::KeyLast),
        r#"{"2":2,"b":1,"type":"T"}"#
    );
    // `{ type, ...data }`
    assert_eq!(
        w(&map(r#"{"a":1}"#), Spread::KeyFirst),
        r#"{"type":"T","a":1}"#
    );
    assert_eq!(
        w(&map(r#"{"a":1,"type":"x"}"#), Spread::KeyFirst),
        r#"{"type":"x","a":1}"#
    );
    assert_eq!(
        w(&map(r#"{"a":1,"5":0}"#), Spread::KeyFirst),
        r#"{"5":0,"type":"T","a":1}"#
    );
    assert_eq!(
        w(&map(r#"{"__proto__":{"q":1}}"#), Spread::KeyFirst),
        r#"{"type":"T","__proto__":{"q":1}}"#
    );
}
