//! The gateway's `.env` loading against Bun 1.4.4's own auto-load: the
//! same files, the same precedence, the same parse and `$VAR` expansion.
//! Each case writes files into a temp dir and runs `bun -e` there.

use omni_gateway_core::dotenv::load_env;
use std::collections::BTreeMap;
use std::process::Command;

const PROBE: &[&str] = &[
    "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S",
    "T", "U", "V", "W", "X", "Y", "Z", "AA", "AB", "AC", "AD", "AE", "AF", "AG", "AH", "AI", "AJ",
    "AK", "LOCAL", "DEV", "PROD", "TST", "K-1", "K.1", "1K", "lower", "COLON", "BOM",
];

const MAIN: &str = "\u{feff}BOM=1\nA=fromfile\nB=fromfile\nC=$A-expanded\nD=\"quoted $A\"\nE='single $A'\nF=\\$A\nexport G=exported\nH=with # comment\nI=\"multi\nline\"\nJ = spaced \nK=${A}braced\nL=$UNDEFINED_THING-x\nM=${NOPE:-dflt}\nN=\"a\\nb\"\nO='a\\nb'\nP=\nQ=\"has \\\"esc\\\"\"\nR=a=b\n#S=commented\n T = lead\nU=`back`\nV=${B:-dflt}\nW=$A$A\nX=pre${A}post\nY=${A\nZ=$\nAA=\"x\" # trailing\nAB=crlf\r\nAC=${NO-def}\nAD=$AK\nAK=later\nAE=\"unterminated\nAF=after\nK-1=dash\nK.1=dot\n1K=digit\nlower=l\nCOLON: colon value\nAG=${A:-${B}}\nAH=\\${A}\nAI=$1x\nAJ=\"  pad  \"\n";

fn bun_env(dir: &std::path::Path, extra: &[(&str, &str)]) -> BTreeMap<String, Option<String>> {
    let script = format!(
        "const keys = {}; console.log(JSON.stringify(Object.fromEntries(keys.map(k => [k, process.env[k] ?? null]))))",
        serde_json::to_string(PROBE).expect("keys")
    );
    let mut cmd = Command::new("bun");
    cmd.arg("-e").arg(script).current_dir(dir).env_clear();
    cmd.env("PATH", std::env::var("PATH").unwrap_or_default());
    cmd.env("HOME", std::env::var("HOME").unwrap_or_default());
    for (k, v) in extra {
        cmd.env(k, v);
    }
    let out = cmd.output().expect("bun");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_slice(&out.stdout).expect("json")
}

fn rust_env(dir: &std::path::Path, extra: &[(&str, &str)]) -> BTreeMap<String, Option<String>> {
    let mut ambient: Vec<(String, String)> = vec![
        ("PATH".into(), std::env::var("PATH").unwrap_or_default()),
        ("HOME".into(), std::env::var("HOME").unwrap_or_default()),
    ];
    ambient.extend(
        extra
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned())),
    );
    let env = load_env(dir, ambient).expect("load");
    PROBE
        .iter()
        .map(|k| ((*k).to_owned(), env.get(*k).cloned()))
        .collect()
}

#[test]
fn the_env_equals_what_bun_loads_into_process_env() {
    if !Command::new("bun")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
    {
        println!("skipping: bun is not on PATH");
        return;
    }
    type Pairs = Vec<(&'static str, &'static str)>;
    let scenarios: Vec<(Pairs, Pairs)> = vec![
        (vec![(".env", MAIN)], vec![]),
        (vec![(".env", MAIN)], vec![("B", "ambient"), ("A", "")]),
        (
            vec![
                (".env", "A=env\nB=env\n"),
                (".env.local", "A=local\nLOCAL=local\n"),
                (".env.development", "A=dev\nDEV=dev\n"),
                (".env.production", "PROD=prod\n"),
                (".env.test", "TST=test\n"),
            ],
            vec![],
        ),
        (
            vec![
                (".env", "A=env\nB=env\n"),
                (".env.local", "A=local\n"),
                (".env.production", "PROD=prod\nB=${A}-p\n"),
                (".env.production.local", "C=pl\n"),
            ],
            vec![("NODE_ENV", "production")],
        ),
        (
            vec![
                (".env", "A=env\n"),
                (".env.local", "LOCAL=ignored-under-test\n"),
                (".env.test", "TST=t\n"),
                (".env.test.local", "A=tl\n"),
            ],
            vec![("NODE_ENV", "test")],
        ),
        (
            vec![(".env", "A=env\n"), (".env.development", "DEV=d\n")],
            vec![("NODE_ENV", "staging")],
        ),
        (vec![], vec![("A", "only-ambient")]),
    ];
    for (files, extra) in scenarios {
        let dir = tempfile::tempdir().expect("tempdir");
        for (name, body) in &files {
            std::fs::write(dir.path().join(name), body).expect("write");
        }
        assert_eq!(
            rust_env(dir.path(), &extra),
            bun_env(dir.path(), &extra),
            "files {:?} env {extra:?}",
            files.iter().map(|f| f.0).collect::<Vec<_>>()
        );
    }
}
