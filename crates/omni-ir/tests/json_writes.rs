//! Syntactic tripwire for method `.insert` and direct index assignments in
//! the three crates' Rust sources (including cfg(test), excluding integration
//! tests and macro expansions). Exceptions match file + trimmed starting line.
//! This is not a type/ownership proof: removals, retain/extend/clear, aliased
//! assignments, UFCS calls, macro bodies and ordinary destruction are not
//! detected. Public JSON boundaries require a separate ownership audit.
use std::collections::HashSet;
use std::path::Path;
use syn::{spanned::Spanned, visit::Visit};

// Exact source-site exceptions with ownership/type justification.
const ALLOW: &[(&str, &str, &str)] = &[
    (
        "omni-dialects/src/egress/anthropic.rs",
        "self.suppressed.insert(*index);",
        "non-JSON collection: scalar indices, strings, or shallow typed entries",
    ),
    (
        "omni-dialects/src/egress/anthropic.rs",
        "self.out_index.insert(*index, at);",
        "non-JSON collection: scalar indices, strings, or shallow typed entries",
    ),
    (
        "omni-dialects/src/egress/openai.rs",
        "self.tool_index.insert(*index, at);",
        "non-JSON collection: scalar indices, strings, or shallow typed entries",
    ),
    (
        "omni-dialects/src/ingress/anthropic_tools.rs",
        "names.insert(name.to_string());",
        "non-JSON collection: scalar indices, strings, or shallow typed entries",
    ),
    (
        "omni-dialects/src/ingress/mod.rs",
        "b[6] = (b[6] & 0x0f) | 0x40;",
        "fixed byte or header array, not JSON",
    ),
    (
        "omni-dialects/src/ingress/mod.rs",
        "b[8] = (b[8] & 0x3f) | 0x80;",
        "fixed byte or header array, not JSON",
    ),
    (
        "omni-dialects/src/ingress/mod.rs",
        "names.insert(name.to_string());",
        "non-JSON collection: scalar indices, strings, or shallow typed entries",
    ),
    (
        "omni-dialects/src/ingress/mod.rs",
        "seen.insert(b.id.clone());",
        "non-JSON collection: scalar indices, strings, or shallow typed entries",
    ),
    (
        "omni-dialects/src/ingress/responses.rs",
        "dropped.insert(call_id.to_string());",
        "non-JSON collection: scalar indices, strings, or shallow typed entries",
    ),
    (
        "omni-dialects/src/ingress/zod.rs",
        "i.path.insert(0, seg.clone());",
        "non-JSON collection: scalar indices, strings, or shallow typed entries",
    ),
    (
        "omni-ir/src/deep.rs",
        "if let Some(old) = map.insert(key, value) {",
        "shared helper releases displaced JSON iteratively",
    ),
    (
        "omni-ir/src/jsjson.rs",
        "index.insert(key.clone(), o.len());",
        "non-JSON collection: duplicate-key index from UTF-16 key to member position",
    ),
    (
        "omni-ir/src/jsjson.rs",
        "buf[at] = b'0' + u8::try_from(value % 10).unwrap_or(0);",
        "fixed byte or header array, not JSON",
    ),
    (
        "omni-ir/src/stream.rs",
        "if let Some(old) = blocks.insert(*index, acc) {",
        "typed accumulator map; displaced accumulator fields explicitly released iteratively",
    ),
    (
        "omni-providers/src/anthropic/profile.rs",
        "base[i] = pair;",
        "Vec of header string pairs, not JSON",
    ),
    (
        "omni-providers/src/anthropic/decode.rs",
        "self.native.insert(index);",
        "non-JSON collection: scalar indices, strings, or shallow typed entries",
    ),
    (
        "omni-providers/src/anthropic/cloak.rs",
        "names.retain(|n| seen.insert(n.clone()));",
        "non-JSON collection: scalar indices, strings, or shallow typed entries",
    ),
    (
        "omni-providers/src/anthropic/cloak.rs",
        "cloak.from_wire.insert(alias.clone(), name.clone());",
        "HashMap<String, String>; replacing a string cannot release JSON",
    ),
    (
        "omni-providers/src/anthropic/wire.rs",
        "system.insert(0, json!({\"type\":\"text\",\"text\":OAUTH_IDENTITY}));",
        "Vec insertion moves elements; it cannot displace or release a JSON value",
    ),
    (
        "omni-providers/src/anthropic/wire.rs",
        "parts.insert(0, json!({\"type\":\"text\",\"text\":text}));",
        "Vec<Value> insertion moves elements, including deep JSON; nothing is displaced",
    ),
    (
        "omni-providers/src/custom/decode/chat.rs",
        "self.tool_index.insert(key, index);",
        "non-JSON collection: scalar indices, strings, or shallow typed entries",
    ),
    (
        "omni-providers/src/custom/decode/responses.rs",
        "self.indices.insert(key, assigned);",
        "non-JSON collection: scalar indices, strings, or shallow typed entries",
    ),
    (
        "omni-providers/src/custom/decode/responses.rs",
        "self.owns_block.insert(key);",
        "non-JSON collection: scalar indices, strings, or shallow typed entries",
    ),
];

struct Scanner<'a> {
    path: &'a str,
    source: &'a str,
    failures: &'a mut Vec<String>,
    used: &'a mut HashSet<usize>,
}
impl Scanner<'_> {
    fn check(&mut self, span: proc_macro2::Span) {
        let line = span.start().line;
        let text = self
            .source
            .lines()
            .nth(line - 1)
            .expect("valid source tree")
            .trim();
        if let Some(index) = ALLOW.iter().position(|(path, site, reason)| {
            !reason.is_empty() && *path == self.path && *site == text
        }) {
            self.used.insert(index);
        } else {
            self.failures.push(format!("{}:{line}: {text}", self.path));
        }
    }
}
impl<'ast> Visit<'ast> for Scanner<'_> {
    fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
        if node.method == "insert" {
            self.check(node.span());
        }
        syn::visit::visit_expr_method_call(self, node);
    }
    fn visit_expr_assign(&mut self, node: &'ast syn::ExprAssign) {
        if matches!(&*node.left, syn::Expr::Index(_)) {
            self.check(node.span());
        }
        syn::visit::visit_expr_assign(self, node);
    }
}
fn scan(root: &Path, dir: &Path, failures: &mut Vec<String>, used: &mut HashSet<usize>) {
    for entry in std::fs::read_dir(dir).expect("valid source tree") {
        let path = entry.expect("valid source tree").path();
        if path.is_dir() {
            scan(root, &path, failures, used);
        } else if path.extension().is_some_and(|x| x == "rs") {
            let source = std::fs::read_to_string(&path).expect("valid source tree");
            let relative = path
                .strip_prefix(root)
                .expect("valid source tree")
                .to_str()
                .expect("valid source tree");
            Scanner {
                path: relative,
                source: &source,
                failures,
                used,
            }
            .visit_file(&syn::parse_file(&source).expect("valid source tree"));
        }
    }
}
#[test]
fn json_writes_use_iterative_release() {
    let default = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("valid source tree")
        .to_path_buf();
    let root = std::env::var_os("OMNI_JSON_SCAN_ROOT").map_or(default, Into::into);
    let mut failures = Vec::new();
    let mut used = HashSet::new();
    for name in ["omni-ir", "omni-dialects", "omni-providers"] {
        scan(
            &root,
            &root.join(name).join("src"),
            &mut failures,
            &mut used,
        );
    }
    for (index, (path, site, _)) in ALLOW.iter().enumerate() {
        if !used.contains(&index) {
            failures.push(format!("unused or duplicate exception: {path}: {site}"));
        }
    }
    assert!(
        failures.is_empty(),
        "unreviewed JSON writes:\n{}",
        failures.join("\n")
    );
}
