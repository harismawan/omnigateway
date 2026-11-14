//! Conservative API inventory tripwire, not an ownership proof. Inventories
//! every explicitly public function/method in src, a superset of JSON APIs
//! (including declarations behind private modules). This catches signature
//! changes as well as additions/removals. It cannot resolve macro re-exports,
//! trait methods, generic JSON carriers or effective module visibility.
//! Safety decisions and known limits live in public_json_boundary.tsv.
//! The reference tripwire cannot see macros, re-exports through a fourth
//! crate, or names built by token pasting; it does not perform name resolution.
use std::collections::BTreeSet;
use std::path::Path;
use syn::{spanned::Spanned, visit::Visit};

struct Inventory<'a> {
    file: &'a str,
    source: &'a str,
    entries: &'a mut BTreeSet<String>,
}

impl Inventory<'_> {
    fn record(&mut self, visibility: &syn::Visibility, signature: &syn::Signature) {
        if !matches!(visibility, syn::Visibility::Public(_)) {
            return;
        }
        let start = signature.span().start();
        let end = signature.span().end();
        let lines: Vec<_> = self.source.lines().collect();
        let mut text = String::new();
        for line in start.line..=end.line {
            let s = lines[line - 1];
            let from = if line == start.line { start.column } else { 0 };
            let to = if line == end.line {
                end.column
            } else {
                s.len()
            };
            text.push_str(&s[from..to]);
            text.push(' ');
        }
        self.entries.insert(format!(
            "{} :: {}",
            self.file,
            text.split_whitespace().collect::<Vec<_>>().join(" ")
        ));
    }
}

impl<'ast> Visit<'ast> for Inventory<'_> {
    fn visit_item_mod(&mut self, node: &'ast syn::ItemMod) {
        if node.ident != "tests" {
            syn::visit::visit_item_mod(self, node);
        }
    }
    fn visit_item_fn(&mut self, node: &'ast syn::ItemFn) {
        self.record(&node.vis, &node.sig);
    }
    fn visit_impl_item_fn(&mut self, node: &'ast syn::ImplItemFn) {
        self.record(&node.vis, &node.sig);
    }
}

fn scan(root: &Path, directory: &Path, entries: &mut BTreeSet<String>) {
    for entry in std::fs::read_dir(directory).expect("sources") {
        let path = entry.expect("entry").path();
        if path.is_dir() {
            scan(root, &path, entries);
        } else if path.extension().is_some_and(|e| e == "rs") {
            let source = std::fs::read_to_string(&path).expect("source");
            let file = path
                .strip_prefix(root)
                .expect("relative")
                .to_str()
                .expect("utf8");
            Inventory {
                file,
                source: &source,
                entries,
            }
            .visit_file(&syn::parse_file(&source).expect("syntax"));
        }
    }
}

#[test]
fn public_boundary_inventory_matches() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates");
    let mut actual = BTreeSet::new();
    for name in ["omni-ir", "omni-dialects", "omni-providers"] {
        scan(root, &root.join(name).join("src"), &mut actual);
    }
    let expected: BTreeSet<_> = include_str!("public_json_boundary.tsv")
        .lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
        .map(|line| {
            let (signature, reason) = line.split_once('\t').expect("signature TAB decision");
            assert!(!reason.is_empty(), "missing decision: {signature}");
            signature.to_owned()
        })
        .collect();
    assert_eq!(
        actual, expected,
        "review additions/removals and update the boundary inventory"
    );
}

/// Lexical tripwire: qualified paths/imports, including aliases, must not make
/// these scoped assembly helpers into cross-crate production entry points.
/// This is not name resolution: macros, re-exports through a fourth crate,
/// and names built by token pasting are invisible to this tripwire.
#[test]
fn scoped_helpers_have_no_external_production_callers() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates");
    let helpers = [
        ("omni-providers", "to_custom_chat_wire"),
        ("omni-providers", "to_wire"),
        ("omni-providers", "to_wire_with_options"),
        ("omni-providers", "encode_block"),
        ("omni-providers", "apply_system"),
    ];
    fn files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        if !dir.exists() {
            return;
        }
        for entry in std::fs::read_dir(dir).expect("directory") {
            let p = entry.expect("entry").path();
            if p.is_dir() {
                files(&p, out);
            } else if p.extension().is_some_and(|e| e == "rs") {
                out.push(p);
            }
        }
    }
    for entry in std::fs::read_dir(root).expect("crates") {
        let crate_dir = entry.expect("crate").path();
        let name = crate_dir.file_name().expect("name").to_str().expect("utf8");
        let mut sources = Vec::new();
        files(&crate_dir.join("src"), &mut sources);
        for path in sources {
            let source = std::fs::read_to_string(&path).expect("source");
            let tokens: Vec<_> = source
                .split(|c: char| !c.is_alphanumeric() && c != '_')
                .collect();
            for (owner, helper) in helpers {
                assert!(
                    name == owner || !tokens.contains(&helper),
                    "external internal-helper reference: {}: {helper}",
                    path.display()
                );
            }
            if name != "omni-dialects" {
                assert!(
                    !forbidden_ingress(&source),
                    "external ingress exposure: {}",
                    path.display()
                );
                // Ban imports of parser modules as well as direct parse calls.
                let compact: String = source.chars().filter(|c| !c.is_whitespace()).collect();
                for module in ["anthropic", "openai", "responses"] {
                    assert!(
                        !compact.contains(&format!("ingress::{module}"))
                            && !compact.contains(&format!("ingress::{{{module}")),
                        "external ingress parser module reference: {}",
                        path.display()
                    );
                }
            }
        }
    }
}

fn forbidden_ingress(source: &str) -> bool {
    let compact: String = source.chars().filter(|c| !c.is_whitespace()).collect();
    // The gateway imports named entry points (ingest, Headers, IngressOptions,
    // Surface, random_tool_use_id); it does not import the ingress module.
    compact.contains("useomni_dialects::ingressas")
        || compact.contains("useomni_dialects::ingress;")
        || compact.contains("useomni_dialects::ingress::*")
        || compact.contains("pubuseomni_dialects::ingress")
        || ["anthropic", "openai", "responses"].iter().any(|module| {
            compact.contains(&format!("{module}::parse("))
                || compact.contains(&format!("{module}::parse::<"))
        })
}

#[test]
fn ingress_exposure_negative_fixtures() {
    for source in [
        "use omni_dialects::ingress as parser; fn call(){ parser::openai::parse(); }",
        "use omni_dialects::ingress::*; fn call(){ openai::parse(); }",
        "pub use omni_dialects::ingress as parser; parser::openai::parse(body, headers, opts)",
        "use omni_dialects::ingress::*; openai::parse(body, headers, opts)",
        "use omni_dialects::ingress as parser;",
        "arbitrary::responses::parse(body, headers, opts)",
        "anthropic::parse(body, headers, opts)",
    ] {
        assert!(forbidden_ingress(source), "{source}");
    }
    assert!(!forbidden_ingress(
        "use omni_dialects::ingress::{Headers, IngressOptions, Surface, ingest, random_tool_use_id};"
    ));
}

fn reexports(root: &Path) -> Vec<String> {
    fn visit(root: &Path, path: &Path, out: &mut Vec<String>) {
        for entry in std::fs::read_dir(path).expect("source directory") {
            let path = entry.expect("entry").path();
            if path.is_dir() {
                visit(root, &path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let source = std::fs::read_to_string(&path).expect("source");
                for statement in source.split("pub use ").skip(1) {
                    let statement = statement.split_once(';').expect("use terminator").0;
                    let statement = statement.split_whitespace().collect::<Vec<_>>().join(" ");
                    out.push(format!(
                        "{}\tpub use {statement};",
                        path.strip_prefix(root).expect("relative").display()
                    ));
                }
            }
        }
    }
    let mut out = Vec::new();
    for owner in ["omni-ir", "omni-dialects", "omni-providers"] {
        visit(root, &root.join(owner).join("src"), &mut out);
    }
    out.sort();
    out
}

#[test]
fn owner_reexports_are_pinned() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crates");
    let actual = reexports(root);
    let expected: Vec<_> = include_str!("owner_reexports.tsv")
        .lines()
        .map(str::to_owned)
        .collect();
    assert_eq!(
        actual, expected,
        "review every new or renamed owner re-export"
    );
    let mut negative = actual.clone();
    negative.push(
        "omni-providers/src/lib.rs\tpub use custom::wire::to_custom_chat_wire as assemble;".into(),
    );
    negative.sort();
    assert_ne!(negative, expected, "reviewer's owner-reexport fixture");
}
