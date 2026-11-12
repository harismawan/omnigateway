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
        // Backslash targets reach the router (hyper accepts `\` in a
        // request-target) and normalize to `/`, as WHATWG URL does.
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

use omni_gateway::static_files::{Decision, decide};

/// A2 fix round 1 (I1, a documented security divergence from TS): the SPA
/// fallback's `index.html` is canonicalized and contained exactly like a
/// requested file. A root whose `index.html` links outside answers 404 for a
/// missing navigation route, where frozen TS serves the outside file.
#[test]
fn spa_fallback_index_must_stay_inside_the_root() {
    let dir = tempfile::tempdir().expect("tmp");
    let root = dir.path().join("dash");
    std::fs::create_dir(&root).expect("root");
    std::fs::write(dir.path().join("secret.txt"), "TOP SECRET\n").expect("secret");
    std::os::unix::fs::symlink("../secret.txt", root.join("index.html")).expect("link");
    let root = std::fs::canonicalize(&root).expect("canon");
    for path in ["/missing/route", "/", "/index.html"] {
        assert_eq!(
            decide(Some(&root), path, Some("text/html")),
            Decision::NotFound,
            "{path}"
        );
    }
    // An index linking to a file inside the root is still served.
    std::fs::write(root.join("real.html"), "<p>ok</p>").expect("real");
    std::fs::remove_file(root.join("index.html")).expect("rm");
    std::os::unix::fs::symlink("real.html", root.join("index.html")).expect("link");
    match decide(Some(&root), "/missing/route", Some("text/html")) {
        Decision::File {
            path, content_type, ..
        } => {
            assert_eq!(path, root.join("real.html"));
            assert_eq!(content_type, "text/html");
        }
        other => panic!("{other:?}"),
    }
}

/// A2 I2, ruling "keep TS parity": only `/api` and `/v1` are refused before
/// disk. `/metrics` with no token, `/metrics/x` and `/health/x` are dashboard
/// paths like any other, so a navigation request gets the SPA index and a
/// file with that name is served, as frozen TS does.
#[test]
fn reserved_route_names_are_dashboard_paths_as_in_ts() {
    let dir = tempfile::tempdir().expect("tmp");
    let root = std::fs::canonicalize(dir.path()).expect("canon");
    std::fs::write(root.join("index.html"), "<p>index</p>").expect("index");
    std::fs::write(root.join("metrics"), "a file named metrics").expect("file");
    for path in ["/health/x", "/metrics/x"] {
        assert!(
            matches!(decide(Some(&root), path, Some("text/html")), Decision::File { ref path, .. } if path.ends_with("index.html")),
            "{path}"
        );
        assert_eq!(
            decide(Some(&root), path, None),
            Decision::NotFound,
            "{path}"
        );
    }
    assert!(matches!(
        decide(Some(&root), "/metrics", None),
        Decision::File { ref path, .. } if path.ends_with("metrics")
    ));
    for path in ["/api", "/api/x", "/v1", "/v1/x"] {
        assert_eq!(
            decide(Some(&root), path, Some("text/html")),
            Decision::NotFound,
            "{path}"
        );
    }
}

/// `OMNI_STATIC_DIR` may be relative: it resolves against the working
/// directory, as `path.resolve` does, and a missing one disables serving.
#[test]
fn a_relative_static_dir_resolves_against_the_working_directory() {
    let cwd = std::env::current_dir().expect("cwd");
    let rel = "tests";
    assert_eq!(
        omni_gateway::static_files::resolve_root(rel),
        Some(std::fs::canonicalize(cwd.join(rel)).expect("canon"))
    );
    assert_eq!(
        omni_gateway::static_files::resolve_root("definitely/missing/dir"),
        None
    );
}

/// The routing fast path borrows a plain path and normalizes the rest.
#[test]
fn pathname_borrows_plain_paths() {
    use std::borrow::Cow;
    for p in [
        "/v1/chat/completions",
        "/v1/messages",
        "/health",
        "/metrics",
    ] {
        assert!(
            matches!(omni_gateway::static_files::pathname(p), Cow::Borrowed(_)),
            "{p}"
        );
    }
    assert_eq!(
        omni_gateway::static_files::pathname("/x/../v1/models"),
        "/v1/models"
    );
    assert_eq!(omni_gateway::static_files::pathname("/a%2e%2e"), "/a%2e%2e");
}
