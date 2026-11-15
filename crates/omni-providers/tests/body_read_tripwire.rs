//! Source tripwire for "no per-chunk allocation beyond the encoded frame".
//! Not an allocation proof: cannot see allocations in callees in other files,
//! macro expansions, or allocation spellings outside the explicit deny list.

#[test]
fn request_body_reads_do_not_allocate() {
    let source = include_str!("../src/http/body.rs");
    // Exact function + trimmed line + justification, never a function-wide pass.
    // Currently no denied spellings are needed, even on error paths.
    const ALLOW: &[(&str, &str, &str)] = &[];
    let mut used = std::collections::HashSet::new();
    for name in [
        "next_chunk",
        "read_next",
        "fill",
        "fill_or_abort",
        "line",
        "clamp",
        "parse_chunk_size",
        "release",
    ] {
        let signature = format!("fn {name}(");
        let start = source.find(&signature).expect("named reader function");
        let rest = &source[start..];
        let open = rest.find('{').expect("function body");
        let mut depth = 0;
        let end = rest[open..]
            .char_indices()
            .find_map(|(i, ch)| {
                if ch == '{' {
                    depth += 1;
                }
                if ch == '}' {
                    depth -= 1;
                }
                (depth == 0).then_some(open + i)
            })
            .expect("balanced body");
        for line in rest[open..=end].lines().map(str::trim) {
            for forbidden in [
                "Box::pin", "Box::new", ".boxed()", "Vec::new", "to_vec", "to_owned", "String::",
                "format!",
            ] {
                if line.contains(forbidden) {
                    let exception = ALLOW
                        .iter()
                        .position(|(f, l, why)| *f == name && *l == line && !why.is_empty());
                    assert!(exception.is_some(), "{name}: forbidden {forbidden}: {line}");
                    used.insert(exception.expect("allowed site"));
                }
            }
        }
    }
    assert_eq!(used.len(), ALLOW.len(), "remove stale exceptions");
}
