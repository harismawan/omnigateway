//! Deny per-chunk allocating spellings (including clone: none occurs today).
//! Blank comments/literals, brace-match fn bodies, normalise whitespace and
//! path generics. reserve/extend_from_slice on the reused read buffer are
//! deliberately allowed amortised growth. This is not an allocation proof:
//! other files/crates, macro expansions, trait dispatch, aliases/re-exports
//! (Box as B), dependencies and unlisted spellings still require review.
//! Assumes ordinary signatures, not arbitrary const-generic expressions or
//! Unicode identifiers. Same-file calls are conservatively matched by name.

const SOURCE: &str = include_str!("../src/http/body.rs");
const SCANNED: &[&str] = &[
    "next_chunk",
    "read_next",
    "fill",
    "fill_or_abort",
    "line",
    "clamp",
    "parse_chunk_size",
    "release",
];
// Exact function, normalised line, justification. Currently no exceptions.
const ALLOW: &[(&str, &str, &str)] = &[];
const DENY: &[&str] = &[
    "Box::pin",
    "Box::new",
    "Box::from",
    ".boxed()",
    ".into_boxed",
    "Arc::new",
    "Rc::new",
    "Vec::new",
    "Vec::with_capacity",
    "Vec::from",
    "vec!",
    ".to_vec()",
    ".to_owned()",
    ".to_string()",
    "String::",
    "format!",
    ".collect",
    "Bytes::copy_from_slice",
    "BytesMut::from",
    "BytesMut::with_capacity",
    ".clone()",
];

fn blank(source: &str) -> String {
    let b = source.as_bytes();
    let mut out = b.to_vec();
    let mut i = 0;
    while i < b.len() {
        let start = i;
        if b[i..].starts_with(b"//") {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else if b[i..].starts_with(b"/*") {
            i += 2;
            let mut depth = 1;
            while i < b.len() && depth > 0 {
                if b[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if b[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
        } else {
            let r = i + usize::from(b[i] == b'b');
            let mut q = r + 1;
            if b.get(r) == Some(&b'r') {
                while b.get(q) == Some(&b'#') {
                    q += 1;
                }
            }
            if b.get(r) == Some(&b'r') && b.get(q) == Some(&b'"') {
                let hashes = q - r - 1;
                i = q + 1;
                while i < b.len() {
                    if b[i] == b'"'
                        && b.get(i + 1..i + 1 + hashes)
                            .is_some_and(|s| s.iter().all(|c| *c == b'#'))
                    {
                        i += 1 + hashes;
                        break;
                    }
                    i += 1;
                }
            } else if b[i] == b'"' {
                i += 1;
                while i < b.len() {
                    if b[i] == b'\\' {
                        i = (i + 2).min(b.len());
                    } else if b[i] == b'"' {
                        i += 1;
                        break;
                    } else {
                        i += 1;
                    }
                }
            } else if b[i] == b'\'' {
                // One scalar/escape plus a quote is a char; 'a is a lifetime.
                let mut end = i + 1;
                if b.get(end) == Some(&b'\\') {
                    end += 2;
                    if b.get(end - 1) == Some(&b'u') && b.get(end) == Some(&b'{') {
                        while end < b.len() && b[end] != b'}' {
                            end += 1;
                        }
                        end += 1;
                    } else if b.get(end - 1) == Some(&b'x') {
                        end += 2;
                    }
                } else if let Some(c) = source[end..].chars().next() {
                    end += c.len_utf8();
                }
                if b.get(end) == Some(&b'\'') {
                    i = end + 1;
                }
            }
        }
        if i == start {
            i += 1;
            continue;
        }
        for c in &mut out[start..i] {
            if *c != b'\n' {
                *c = b' ';
            }
        }
    }
    String::from_utf8(out).expect("complete literals blanked")
}

fn ident(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

fn normalise(text: &str) -> String {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let b = compact.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'<' && i > 0 && (ident(b[i - 1]) || b[i - 1] == b':') {
            let mut end = i + 1;
            let mut depth = 1;
            while end < b.len() && depth > 0 {
                if b[end] == b'<' {
                    depth += 1;
                }
                if b[end] == b'>' {
                    depth -= 1;
                }
                end += 1;
            }
            if depth == 0 && b[end..].starts_with(b"::") {
                if out.ends_with("::") {
                    out.truncate(out.len() - 2);
                }
                i = end;
                continue;
            }
        }
        let c = compact[i..].chars().next().expect("remaining character");
        out.push(c);
        i += c.len_utf8();
    }
    out
}

fn functions(text: &str) -> Vec<(&str, usize, usize)> {
    let b = text.as_bytes();
    let mut found = Vec::new();
    for (at, _) in text.match_indices("fn") {
        if at > 0 && ident(b[at - 1]) || !b.get(at + 2).is_some_and(u8::is_ascii_whitespace) {
            continue;
        }
        let mut start = at + 2;
        while b.get(start).is_some_and(u8::is_ascii_whitespace) {
            start += 1;
        }
        let mut end = start;
        while b.get(end).is_some_and(|c| ident(*c)) {
            end += 1;
        }
        let name = &text[start..end];
        while b.get(end).is_some_and(u8::is_ascii_whitespace) {
            end += 1;
        }
        if !matches!(b.get(end), Some(b'(' | b'<')) {
            continue;
        }
        let open = end + text[end..].find('{').expect("function body");
        let mut depth = 1;
        let mut close = open + 1;
        while close < b.len() && depth > 0 {
            if b[close] == b'{' {
                depth += 1;
            }
            if b[close] == b'}' {
                depth -= 1;
            }
            close += 1;
        }
        assert_eq!(depth, 0, "balanced function {name}");
        found.push((name, open, close));
    }
    found
}

#[derive(Debug)]
struct Violation {
    function: String,
    text: String,
    reason: String,
}

fn scan(source: &str) -> Vec<Violation> {
    let text = blank(source);
    let funcs = functions(&text);
    let mut violations = Vec::new();
    let mut used = std::collections::HashSet::new();
    for name in SCANNED {
        let bodies: Vec<_> = funcs.iter().filter(|(f, _, _)| f == name).collect();
        assert!(!bodies.is_empty(), "missing function {name}");
        for (_, open, close) in bodies {
            let body = &text[*open..*close];
            let norm = normalise(body);
            for denied in DENY {
                let count = norm.matches(denied).count();
                let mut allowed = 0;
                for line in body.lines().map(normalise) {
                    if let Some(index) = ALLOW
                        .iter()
                        .position(|(f, l, why)| f == name && *l == line && !why.is_empty())
                    {
                        allowed += line.matches(denied).count();
                        used.insert(index);
                    }
                }
                if count > allowed {
                    violations.push(Violation {
                        function: name.to_string(),
                        text: norm.clone(),
                        reason: denied.to_string(),
                    });
                }
            }
            for (helper, _, _) in &funcs {
                let call = format!("{helper}(");
                if !SCANNED.contains(helper)
                    && norm
                        .match_indices(&call)
                        .any(|(at, _)| at == 0 || !ident(norm.as_bytes()[at - 1]))
                {
                    violations.push(Violation {
                        function: name.to_string(),
                        text: call,
                        reason: "unscanned local helper".into(),
                    });
                }
            }
        }
    }
    for (i, (f, line, _)) in ALLOW.iter().enumerate() {
        if !used.contains(&i) {
            violations.push(Violation {
                function: f.to_string(),
                text: line.to_string(),
                reason: "stale allow-list site".into(),
            });
        }
    }
    violations
}

#[test]
fn request_body_reads_do_not_allocate() {
    assert!(scan(SOURCE).is_empty(), "{:#?}", scan(SOURCE));
}

#[test]
fn mutations_are_caught() {
    for (label, inserted, reason) in [
        ("plain pin", "Box::pin(self.read_next())", "Box::pin"),
        (
            "qualified pin",
            "std::boxed::Box::pin(self.read_next())",
            "Box::pin",
        ),
        ("boxed", "self.read_next().boxed()", ".boxed()"),
        ("String", "String::from(\"x\")", "String::"),
        ("generic pin", "Box::<_>::pin(self.read_next())", "Box::pin"),
        ("spaced pin", "Box ::\n pin (self.read_next())", "Box::pin"),
        ("Arc", "Arc::new(1)", "Arc::new"),
        ("vec", "vec![1, 2, 3]", "vec!"),
        ("to_string", "1.to_string()", ".to_string()"),
        (
            "Bytes",
            "Bytes::copy_from_slice(b\"x\")",
            "Bytes::copy_from_slice",
        ),
        ("helper", "sneaky()", "unscanned local helper"),
        (
            "line comment",
            "0; // }\nlet _ = Box::pin(self.read_next())",
            "Box::pin",
        ),
        (
            "string brace",
            "\"}\"; let _ = Box::pin(self.read_next())",
            "Box::pin",
        ),
        (
            "nested comment",
            "0; /* } /* nested */ } */ let _ = Box::pin(self.read_next())",
            "Box::pin",
        ),
        (
            "char brace",
            "'}'; let _ = Box::pin(self.read_next())",
            "Box::pin",
        ),
    ] {
        let blanked = blank(SOURCE);
        let (_, open, _) = functions(&blanked)
            .into_iter()
            .find(|(n, _, _)| *n == "next_chunk")
            .expect("next_chunk body");
        let mut mutated = SOURCE.to_string();
        mutated.insert_str(open + 1, &format!("\nlet _ = {inserted};\n"));
        mutated.push_str("\nfn sneaky() { let _ = Box::new(1); }\n");
        let hits = scan(&mutated);
        assert!(
            hits.iter()
                .any(|v| v.function == "next_chunk" && v.reason == reason && !v.text.is_empty()),
            "{label}: {hits:?}"
        );
        println!("{label}: caught yes");
    }
}

#[test]
fn blanking_preserves_boundaries_and_lifetimes() {
    let source = r####"const S: &str = "fn read_next( { }";
fn read_next<'a>(s: &'a str, t: &'static str) { let _ = '}'; }
// }
/* { /* nested */ } */
"escaped \" }" b"byte }" r"raw }" r###"raw " }"### br##"bytes }"##
'x' '\n' '\'' '\u{7d}' '\x7d' '🦀'
"####;
    let text = blank(source);
    assert_eq!(text.len(), source.len());
    assert_eq!(text.lines().count(), source.lines().count());
    assert!(text.contains("&'a str, t: &'static str"));
    let funcs = functions(&text);
    assert_eq!(funcs.len(), 1);
    assert_eq!(funcs[0].0, "read_next");
    assert_eq!(text.matches('{').count(), 1);
    assert_eq!(text.matches('}').count(), 1);
    assert_eq!(
        normalise("std::boxed::Box::<Vec<u8>>::pin"),
        "std::boxed::Box::pin"
    );
}
