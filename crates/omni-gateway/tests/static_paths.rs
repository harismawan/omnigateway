//! Request paths against the runtime frozen TS runs on:
//! `conformance/vectors/static-paths.json` (written by `static-paths.ts`)
//! holds Bun's `new URL(...).pathname` and `decodeURIComponent` of it per
//! request-target. The content-type table is checked for the frozen runtime's
//! answers in `static-mime.tsv` (`static-mime.ts --check` guards drift).

use omni_gateway::static_files::{content_type, decode_uri_component, normalize_path};
use serde_json::Value;

#[test]
fn pathname_and_decode_match_bun() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../conformance/vectors/static-paths.json"
    );
    let doc: Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("vectors")).expect("json");
    let mut failed = Vec::new();
    let mut checked = 0;
    for c in doc["cases"].as_array().expect("cases") {
        let target = c["target"].as_str().expect("target");
        let pathname = c["pathname"].as_str().expect("pathname");
        let decoded = c["decoded"].as_str();
        // Backslash targets never reach the router (hyper's URI parser
        // refuses them with 400); the normalizer still matches WHATWG.
        let got = normalize_path(target);
        if got != pathname {
            failed.push(format!("{target:?}: pathname {got:?} != {pathname:?}"));
        }
        let got_decoded = decode_uri_component(pathname);
        if got_decoded.as_deref() != decoded {
            failed.push(format!(
                "{target:?}: decoded {got_decoded:?} != {decoded:?}"
            ));
        }
        checked += 1;
    }
    assert!(checked >= 50);
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

#[test]
fn content_types_are_the_frozen_runtime_table() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/data/static-mime.tsv");
    let text = std::fs::read_to_string(path).expect("tsv");
    let mut types = std::collections::HashMap::new();
    let mut unknown = String::new();
    for line in text.lines().filter(|l| !l.starts_with('#')) {
        let f: Vec<&str> = line.split('\t').collect();
        match f[0] {
            "unknown" => unknown = f[1].to_owned(),
            "type" => {
                types.insert(f[1].to_owned(), f[2] == "1");
            }
            _ => {}
        }
    }
    let mut n = 0;
    for line in text.lines().filter(|l| l.starts_with("ext\t")) {
        let f: Vec<&str> = line.split('\t').collect();
        let (ext, ty) = (f[1], f[2]);
        for name in [
            format!("/r/f.{ext}"),
            format!("/r/F.{}", ext.to_uppercase()),
        ] {
            let (got, disposition) = content_type(&name);
            assert_eq!(got, ty, "{name}");
            assert_eq!(disposition, types[ty], "{name}");
        }
        n += 1;
    }
    assert!(n > 1000);
    // `extension()` edge cases, as Bun's `bun_paths::extension` defines them.
    for (name, ty) in [
        ("/r/noext", unknown.as_str()),
        ("/r/.hidden", unknown.as_str()),
        ("/r/a.", unknown.as_str()),
        ("/r/.js", unknown.as_str()),
        ("/r/dir.js/x", unknown.as_str()),
        ("/r/a..txt", "text/plain;charset=utf-8"),
        ("/r/.d.ts", "text/javascript;charset=utf-8"),
        ("/r/a.tar.gz", "application/gzip"),
        ("/r/index.html", "text/html;charset=utf-8"),
        ("/r/H.HTML", "text/html;charset=utf-8"),
    ] {
        assert_eq!(content_type(name).0, ty, "{name}");
    }
    assert!(!content_type("/r/index.html").1);
    assert_eq!(types.get("text/html"), Some(&false));
    assert!(content_type("/r/noext").1);
}
