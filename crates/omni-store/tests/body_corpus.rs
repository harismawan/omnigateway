//! The Rust envelope reader (`omni_store::pg::bodies::decode`) against the
//! frozen TS reader's verdicts on its own test corpus: every legacy, binary
//! and gzip case `packages/store/test/bodies.test.ts` puts to
//! `decodeArtifact` (malformed legacy text, header bounds, authentication
//! failures, non-UTF-8 and non-object plaintexts, concatenated members,
//! trailing padding and junk, expansion mismatches, codec-from-header, bombs,
//! ceilings), each with no digest, its own digest, and a wrong one.
//!
//! Generated per run by `conformance/store/body-corpus.ts` (30 MB of JSON,
//! too large to check in). A pure-file test, so it needs Bun but no server;
//! it fails rather than skips when Bun is missing and `OMNI_TEST_DATABASE_URL`
//! marks this as the conformance job.

mod common;

use common::{bun_available, bun_required, bun_script, ts};

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

#[test]
fn the_rust_reader_returns_the_frozen_readers_verdict_on_its_corpus() {
    let name = "the_rust_reader_returns_the_frozen_readers_verdict_on_its_corpus";
    let configured = std::env::var("OMNI_TEST_DATABASE_URL").is_ok_and(|u| !u.is_empty());
    if configured {
        bun_required(name);
    } else if !bun_available(name) {
        return;
    }
    let dir = tempfile::tempdir().expect("tempdir");
    let script = format!(
        "await import({:?});\n",
        ts("conformance/store/body-corpus.ts")
    );
    let out = bun_script(dir.path(), &script, "");
    let corpus: serde_json::Value = serde_json::from_str(out.trim()).expect("corpus json");
    let key = omni_crypto::field::derive_key(corpus["secret"].as_str().expect("secret"));
    let cases = corpus["cases"].as_array().expect("cases");
    assert!(cases.len() >= 300, "{} cases", cases.len());
    let mut opened = 0;
    let mut mismatched = Vec::new();
    for c in cases {
        let name = c["name"].as_str().expect("name");
        let bytes = unhex(c["bytes"].as_str().expect("bytes"));
        let digest = c["digest"].as_str();
        let want_ok = c["ok"].as_bool().expect("ok");
        let got = omni_store::pg::bodies::decode(&key, &bytes, digest);
        let agrees = match (&got, want_ok) {
            (Some(artifact), true) => {
                opened += 1;
                *artifact == c["artifact"]
            }
            (None, false) => true,
            _ => false,
        };
        if !agrees {
            mismatched.push(format!(
                "{name} (digest {}): ts ok={want_ok}, rust ok={}",
                digest.map_or("none", |d| if d.starts_with("0000") {
                    "wrong"
                } else {
                    "own"
                }),
                got.is_some()
            ));
        }
    }
    assert!(
        mismatched.is_empty(),
        "{} mismatches:\n{}",
        mismatched.len(),
        mismatched.join("\n")
    );
    assert_eq!(opened, 16, "the corpus's readable cases all opened");
    println!("{} verdicts agree, {opened} opened", cases.len());
}
