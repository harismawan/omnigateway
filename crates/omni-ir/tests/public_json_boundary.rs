//! Conservative API inventory tripwire, not an ownership proof. Inventories
//! every explicitly public function/method in src, a superset of JSON APIs
//! (including declarations behind private modules). This catches signature
//! changes as well as additions/removals. It cannot resolve macro re-exports,
//! trait methods, generic JSON carriers or effective module visibility.
//! Safety decisions and known limits live in public_json_boundary.tsv.
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
