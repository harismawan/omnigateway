//! `load_config` against TS `loadConfig` (`packages/control/src/config.ts`)
//! run under Bun: the same outcome, field for field, or the same error text.

use omni_gateway_core::config::{Config, load_config};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Write as _;
use std::process::{Command, Stdio};

const KEY: &str = "0123456789abcdef";

fn cases() -> Vec<Vec<(&'static str, &'static str)>> {
    let k = ("OMNI_ENCRYPTION_KEY", KEY);
    let mut v: Vec<Vec<(&str, &str)>> = vec![
        vec![],
        vec![("OMNI_ENCRYPTION_KEY", "short")],
        vec![("OMNI_ENCRYPTION_KEY", "123456789012345")],
        vec![("OMNI_ENCRYPTION_KEY", "ééééééééééééééé")],
        vec![("OMNI_ENCRYPTION_KEY", "😀😀😀😀😀😀😀😀")],
        vec![k],
    ];
    let one =
        |name: &'static str, values: &[&'static str]| -> Vec<Vec<(&'static str, &'static str)>> {
            values.iter().map(|val| vec![k, (name, *val)]).collect()
        };
    v.extend(one(
        "OMNI_PORT",
        &[
            "0",
            "1",
            "65535",
            "65536",
            "80a",
            " 80",
            "+80",
            "08080",
            "",
            "1e3",
            "9000.0",
            "99999999999999999999",
        ],
    ));
    v.extend(one("OMNI_HOST", &["", "  ", " 0.0.0.0 ", "::"]));
    v.extend(one(
        "OMNI_BASE_URL",
        &["https://x.example///", "/", "  ", " https://a/b/ "],
    ));
    v.extend(one("OMNI_DB_PATH", &["", "  ", " /var/db "]));
    v.extend(one("OMNI_STATIC_DIR", &["", "  ", " /srv/dist "]));
    v.extend(one("OMNI_LOG_FILE", &["", " /var/log/o.log "]));
    v.extend(one(
        "OMNI_CLUSTER_MODE",
        &["true", "TRUE", " yes ", "1", "on", "off", ""],
    ));
    v.extend(one("OMNI_DATABASE_URL", &["postgres://x", "  "]));
    v.extend(one("OMNI_REDIS_URL", &["redis://x"]));
    v.push(vec![
        k,
        ("OMNI_CLUSTER_MODE", "true"),
        ("OMNI_DATABASE_URL", "mysql://x"),
        ("OMNI_REDIS_URL", "redis://x"),
    ]);
    v.push(vec![
        k,
        ("OMNI_CLUSTER_MODE", "true"),
        ("OMNI_DATABASE_URL", " postgresql://x "),
    ]);
    v.push(vec![
        k,
        ("OMNI_CLUSTER_MODE", "true"),
        ("OMNI_DATABASE_URL", "postgres://x"),
        ("OMNI_REDIS_URL", " redis://r "),
    ]);
    v.extend(one(
        "OMNI_DAY_OFFSET_MINUTES",
        &[
            "0", "330", "-330", "1440", "-1440", "1441", "+60", "6.5", " 60 ", "abc", "", "-0",
        ],
    ));
    v.extend(one("OMNI_BODY_LOGGING_ALLOWED", &["true", "nope"]));
    v.extend(one(
        "OMNI_LOG_LEVEL",
        &["debug", " WARN ", "trace", "constructor", "", "  "],
    ));
    v.extend(one("OMNI_METRICS_TOKEN", &["", " tok "]));
    v.extend(one(
        "OMNI_METRICS_MAX_SERIES",
        &["0", "1", "10", "-1", "1.5", "", " 5"],
    ));
    v.extend(one("OMNI_OTLP_ENDPOINT", &["http://c:4318///", "  "]));
    v.extend(one("OMNI_OTLP_HEADERS", &[" a=b ", ""]));
    v.extend(one(
        "OMNI_TRACE_SAMPLE",
        &[
            "0", "1", "0.25", "1.01", "-0.1", "", " 0.5 ", "abc", "Infinity", "0x1", "1e-1", ".5",
            "5.",
        ],
    ));
    v
}

fn to_json(c: &Config) -> Value {
    json!({
        "logLevel": c.log_level.as_str(),
        "logLevelFallbackFrom": c.log_level_fallback_from,
        "port": c.port,
        "host": c.host,
        "databasePath": c.database_path,
        "encryptionKey": c.encryption_key,
        "baseUrl": c.base_url,
        "staticDir": c.static_dir,
        "bodyLoggingAllowed": c.body_logging_allowed,
        "logFile": c.log_file,
        "clusterMode": c.cluster_mode,
        "databaseUrl": c.database_url,
        "redisUrl": c.redis_url,
        "dayOffsetMinutes": c.day_offset_minutes,
        "dayOffsetFallbackFrom": c.day_offset_fallback_from,
        "metricsToken": c.metrics_token,
        "metricsMaxSeries": c.metrics_max_series,
        "otlpEndpoint": c.otlp_endpoint,
        "otlpHeaders": c.otlp_headers,
        "traceSample": c.trace_sample,
    })
}

const SCRIPT: &str = r#"
import { loadConfig } from "ROOT/packages/control/src/config.ts";
const cases = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify(cases.map((env) => {
  try { return { ok: loadConfig(env) }; } catch (e) { return { err: e.message }; }
})));
"#;

#[test]
fn load_config_equals_the_ts_load_config() {
    let ok = Command::new("bun")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !ok {
        println!("skipping: bun is not on PATH");
        return;
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("root");
    let file = std::env::temp_dir().join(format!("omni-config-{}.ts", std::process::id()));
    std::fs::write(&file, SCRIPT.replace("ROOT", &root.display().to_string())).expect("script");
    let envs: Vec<Value> = cases()
        .iter()
        .map(|c| Value::Object(c.iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect()))
        .collect();
    let mut child = Command::new("bun")
        .arg(&file)
        // The host offset must agree on both sides.
        .env("TZ", "Asia/Kolkata")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("bun");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(Value::Array(envs).to_string().as_bytes())
        .expect("write");
    let out = child.wait_with_output().expect("output");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let ts: Vec<Value> = serde_json::from_slice(&out.stdout).expect("ts json");

    for (case, expected) in cases().into_iter().zip(ts) {
        let env: HashMap<String, String> = case
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        // Same host offset as the Bun child (IST, +330).
        let got = match load_config(&env, || 330) {
            Ok(c) => json!({ "ok": to_json(&c) }),
            Err(e) => json!({ "err": e.to_string() }),
        };
        assert_eq!(
            omni_ir::jsjson::to_string(&got),
            omni_ir::jsjson::to_string(&expected),
            "env {case:?}"
        );
    }
}

/// No `.env` is read: a `.env` beside the working directory changes nothing.
#[test]
fn config_reads_the_process_environment_and_no_dotenv() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        dir.path().join(".env"),
        "OMNI_PORT=1234\nOMNI_ENCRYPTION_KEY=from-dotenv-0123456789\n",
    )
    .expect("w");
    let exe = std::env::current_exe().expect("exe");
    let out = std::process::Command::new(exe)
        .args([
            "--exact",
            "probe_config_in_child",
            "--nocapture",
            "--include-ignored",
        ])
        .current_dir(dir.path())
        .env("OMNI_PROBE", "1")
        .env("OMNI_ENCRYPTION_KEY", "from-process-0123456789")
        .env_remove("OMNI_PORT")
        .output()
        .expect("child");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "{stdout}{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        stdout.contains("PROBE port=9000 key=from-process-0123456789"),
        "{stdout}"
    );
}

#[test]
#[ignore = "run by config_reads_the_process_environment_and_no_dotenv"]
fn probe_config_in_child() {
    if std::env::var("OMNI_PROBE").is_err() {
        return;
    }
    let c = load_config(&omni_gateway_core::config::process_env(), || 0).expect("config");
    println!("PROBE port={} key={}", c.port, c.encryption_key);
}
