//! Frozen-TS oracles for the request bodies the `/api` routes hand to the
//! shared control operations: `putSettings` (`settingsSchema` and the stored
//! row) and `parseOrThrow(modelSchema, …)`. The CLI never reached these
//! with arbitrary JSON; the HTTP surface does.
use std::process::Command;

fn bun(script: &str, lines: &[String]) -> Vec<String> {
    let repo = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    let mut child = Command::new("bun")
        .current_dir(repo)
        .args(["-e", script])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("Bun oracle required");
    {
        use std::io::Write as _;
        let mut stdin = child.stdin.take().expect("stdin");
        for l in lines {
            writeln!(stdin, "{}", serde_json::to_string(l).expect("line")).expect("write");
        }
    }
    let out = child.wait_with_output().expect("bun");
    assert!(out.status.success(), "{out:?}");
    serde_json::from_slice(&out.stdout).expect("answers")
}

fn settings_vectors() -> Vec<String> {
    let base = r#""weights":{"tier":1,"health":2,"quota":3,"cost":4,"latency":5,"load":6},"maxAttempts":3,"requestDeadlineMs":0,"breakerThreshold":3,"breakerCooldownMs":30000,"logRetentionDays":30,"quotaPollIntervalMs":0,"rtkEnabled":false,"autoCacheEnabled":true,"ponytailMode":"off","bodyLoggingEnabled":false,"bodyLoggingCaptureStreamChunks":false"#;
    let with = |extra: &str| format!("{{{base}{extra}}}");
    let mut v: Vec<String> = ["{}", "[]", "null", "5", "1e400", "-1e400", "\"s\"", "true"]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    v.push(with(""));
    for extra in [
        r#","extra":1"#,
        r#","__proto__":{"rtkEnabled":true}"#,
        r#","maxAttempts":0"#,
        r#","maxAttempts":11"#,
        r#","maxAttempts":2.5"#,
        r#","maxAttempts":1e400"#,
        r#","maxAttempts":-1e400"#,
        r#","maxAttempts":1e300"#,
        r#","maxAttempts":-1e300"#,
        r#","maxAttempts":"3""#,
        r#","maxAttempts":null"#,
        r#","requestDeadlineMs":-1"#,
        r#","requestDeadlineMs":-0"#,
        r#","breakerCooldownMs":0"#,
        r#","bodyRetentionDays":0"#,
        r#","bodyRetentionDays":3651"#,
        r#","bodyRetentionDays":null"#,
        r#","bodyRetentionDays":7"#,
        r#","snapshotKeepLatest":101"#,
        r#","snapshotKeepLatest":100,"snapshotMaxAgeDays":3650"#,
        r#","ponytailMode":"lite""#,
        r#","ponytailMode":"LITE""#,
        r#","ponytailMode":null"#,
        r#","rtkEnabled":1"#,
        r#","rtkEnabled":true,"autoCacheEnabled":false"#,
        r#","guardrailModel":null"#,
        r#","guardrailModel":"  m  ""#,
        r#","guardrailModel":"   ""#,
        r#","guardrailModel":5"#,
        r#","guardrailModel":"\ud800""#,
        r#","guardrailTimeoutMs":60001"#,
        r#","guardrailTimeoutMs":60000"#,
        r#","guardrailHistoryTurns":11"#,
        r#","guardrailHistoryTurns":0"#,
        r#","smartRouterEnabled":"yes""#,
        r#","smartRouterEnabled":true,"smartRouterClassifierModel":"c","smartRouterLocalModel":" l ""#,
        r#","smartRouterPolicy":null"#,
        r#","smartRouterPolicy":" p ""#,
        r#","smartRouterPolicy":"""#,
        r#","smartRouterTimeoutMs":0"#,
        r#","smartRouterClassifierModel":null"#,
        r#","rtkEnabled":1e400"#,
        r#","guardrailModel":-1e400"#,
        r#","ponytailMode":1e400"#,
        r#","smartRouterEnabled":[]"#,
        r#","guardrailModel":{}"#,
    ] {
        v.push(with(extra));
    }
    for weights in [
        r#"{"tier":1,"health":2,"quota":3,"cost":4,"latency":5,"load":6,"recency":1}"#,
        r#"{"tier":1,"health":2,"quota":3,"cost":4,"latency":5}"#,
        r#"{"tier":1e400,"health":2,"quota":3,"cost":4,"latency":5,"load":6}"#,
        r#"{"tier":-1.5,"health":0,"quota":3,"cost":4,"latency":5,"load":6}"#,
        r#"[]"#,
        r#"null"#,
        r#"{"tier":[[[[1]]]],"health":2,"quota":3,"cost":4,"latency":5,"load":6}"#,
        r#"{"tier":1,"health":2,"quota":3,"cost":4,"latency":5,"load":6,"5":1,"a":2}"#,
    ] {
        v.push(format!(
            "{{{}}}",
            base.replacen(
                r#""weights":{"tier":1,"health":2,"quota":3,"cost":4,"latency":5,"load":6}"#,
                &format!(r#""weights":{weights}"#),
                1
            )
        ));
    }
    let long = |c: &str, n: usize| c.repeat(n);
    v.push(with(&format!(r#","guardrailModel":"{}""#, long("m", 256))));
    v.push(with(&format!(r#","guardrailModel":"{}""#, long("m", 257))));
    v.push(with(&format!(
        r#","guardrailModel":"{}""#,
        long("\u{1F600}", 200)
    )));
    v.push(with(&format!(
        r#","smartRouterPolicy":"{}""#,
        long("\u{1F600}", 3000)
    )));
    v.push(with(&format!(
        r#","smartRouterPolicy":" {} ""#,
        long("p", 4000)
    )));
    v.push(with(&format!(
        r#","smartRouterPolicy":"{}""#,
        long("p", 4001)
    )));
    let deep = format!("{}0{}", "[".repeat(3000), "]".repeat(3000));
    v.push(with(&format!(r#","extra":{deep}"#)));
    v.push(with(&format!(r#","maxAttempts":{deep}"#)));
    v.push(format!(
        "{{{}}}",
        base.replacen(r#""tier":1,"#, &format!(r#""tier":{deep},"#), 1)
    ));
    v.push(format!(
        "{{{}}}",
        base.replacen(
            r#""tier":1,"#,
            &format!(r#""tier":1,"zz":{{"a":{deep}}},"#),
            1
        )
    ));
    v
}

/// `putSettings` on a fresh database: the stored row, or the refusal.
#[test]
fn settings_bodies_answer_as_frozen_ts_put_settings() {
    let script = r#"
import { createStore, deriveKey } from './packages/store/src/index.ts';
import { putSettings } from './packages/control/src/settings.ts';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
const key = await deriveKey('oracle');
const lines = (await Bun.stdin.text()).split('\n').filter(Boolean);
const out = [];
for (const line of lines) {
  const dir = mkdtempSync('/tmp/opencode/settings-oracle-');
  const store = await createStore({ path: dir + '/db', encryptionKey: key });
  try { await putSettings(store, JSON.parse(JSON.parse(line))); }
  catch (e) { out.push('err ' + e.code + ' ' + e.message); store.close(); rmSync(dir, { recursive: true }); continue; }
  store.close();
  const db = new Database(dir + '/db');
  out.push('ok ' + db.query("SELECT value FROM settings WHERE key='settings'").get().value);
  db.close();
  rmSync(dir, { recursive: true });
}
process.stdout.write(JSON.stringify(out));
"#;
    let vectors = settings_vectors();
    let frozen = bun(script, &vectors);
    let mut failures = Vec::new();
    for (body, want) in vectors.iter().zip(&frozen) {
        let store = omni_store::SqliteStore::open(":memory:", 0).expect("store");
        let value = crate::operator_json::parse(body).expect("vector");
        let got = match crate::settings::put(&store, &value) {
            Ok(_) => format!(
                "ok {}",
                omni_store::settings::operator_raw(store.connection())
                    .expect("row")
                    .unwrap_or_default()
            ),
            Err(e) => match e.split_once(": ") {
                Some((code, msg)) if code == "BAD_REQUEST" => format!("err {code} {msg}"),
                _ => format!("err ? {e}"),
            },
        };
        if &got != want {
            failures.push(format!(
                "{}\n  ts:   {}\n  rust: {}",
                &body[..body.len().min(200)],
                &want[..want.len().min(400)],
                &got[..got.len().min(400)]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} differ:\n{}",
        failures.len(),
        vectors.len(),
        failures.join("\n")
    );
}

fn model_vectors() -> Vec<String> {
    let t = r#"{"provider":"anthropic","model":"claude-x","tier":1,"weight":1,"costPerMTok":{"input":1,"output":2},"capabilities":{"tools":true,"images":false,"reasoning":true}}"#;
    let m = |targets: &str| {
        format!(r#"{{"id":"m","strategy":"score","isAlias":false,"targets":[{targets}]}}"#)
    };
    let mut v: Vec<String> = ["{}", "[]", "null", "1e400", "\"x\""]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    v.push(m(t));
    v.push(m(""));
    v.push(format!(
        r#"{{"id":"m","strategy":"score","isAlias":false,"targets":[{t}],"extra":1}}"#
    ));
    v.push(r#"{"id":"","strategy":"x","isAlias":1,"targets":5}"#.to_owned());
    v.push(format!(
        r#"{{"id":5,"strategy":"score","isAlias":false,"targets":[{t}]}}"#
    ));
    v.push(format!(
        r#"{{"id":"m","strategy":"Score","isAlias":false,"targets":[{t}]}}"#
    ));
    v.push(format!(
        r#"{{"id":"m","strategy":"score","isAlias":1e400,"targets":[{t}]}}"#
    ));
    v.push(format!(
        r#"{{"id":"\ud800","strategy":"score","isAlias":false,"targets":[{t}]}}"#
    ));
    for repl in [
        (r#""tier":1"#, r#""tier":0"#),
        (r#""tier":1"#, r#""tier":1.5"#),
        (r#""tier":1"#, r#""tier":1e400"#),
        (r#""tier":1"#, r#""tier":-1e400"#),
        (r#""weight":1"#, r#""weight":0"#),
        (r#""weight":1"#, r#""weight":1e-9"#),
        (r#""provider":"anthropic""#, r#""provider":"Anthropic""#),
        (r#""provider":"anthropic""#, r#""provider":"custom""#),
        (r#""provider":"anthropic""#, r#""provider":"plug-in""#),
        (r#""provider":"anthropic""#, r#""provider":"""#),
        (r#""model":"claude-x""#, r#""model":"""#),
        (r#""model":"claude-x""#, r#""model":"\ud800""#),
        (r#""input":1"#, r#""input":-1"#),
        (r#""input":1"#, r#""input":1,"cacheRead":0"#),
        (r#""input":1"#, r#""input":1,"other":0"#),
        (r#""tools":true"#, r#""tools":1"#),
        (r#""tools":true"#, r#""tools":true,"x":1"#),
        (r#""tier":1"#, r#""tier":1,"credentialId":" a_b-1 ""#),
        (r#""tier":1"#, r#""tier":1,"credentialId":"a b""#),
        (r#""tier":1"#, r#""tier":1,"credentialId":"""#),
        (r#""tier":1"#, r#""tier":1,"endpointId":"e""#),
        (r#""tier":1"#, r#""tier":1,"contextWindow":0"#),
        (r#""tier":1"#, r#""tier":1,"maxOutputTokens":1.5"#),
        (r#""tier":1"#, r#""tier":1,"zz":1,"5":2"#),
        (r#""tier":1"#, r#""tier":1,"__proto__":{}"#),
    ] {
        v.push(m(&t.replacen(repl.0, repl.1, 1)));
    }
    v.push(m(&format!(
        "{},{}",
        t,
        t.replacen(
            r#""provider":"anthropic""#,
            r#""provider":"custom","endpointId":" ep ""#,
            1
        )
    )));
    v.push(m("null"));
    v.push(m("[]"));
    let long_cred = "c".repeat(65);
    v.push(m(&t.replacen(
        r#""tier":1"#,
        &format!(r#""tier":1,"credentialId":"{long_cred}""#),
        1,
    )));
    let deep = format!("{}0{}", "[".repeat(3000), "]".repeat(3000));
    v.push(format!(
        r#"{{"id":"m","strategy":"score","isAlias":false,"targets":[{t}],"x":{deep}}}"#
    ));
    v
}

#[test]
fn model_bodies_answer_as_frozen_ts_model_schema() {
    let script = r#"
import { modelSchema, parseOrThrow } from './packages/control/src/schemas.ts';
const lines = (await Bun.stdin.text()).split('\n').filter(Boolean);
const out = [];
for (const line of lines) {
  try { out.push('ok ' + JSON.stringify(parseOrThrow(modelSchema, JSON.parse(JSON.parse(line))))); }
  catch (e) { out.push('err BAD_REQUEST: ' + e.message); }
}
process.stdout.write(JSON.stringify(out));
"#;
    let vectors = model_vectors();
    let frozen = bun(script, &vectors);
    let mut failures = Vec::new();
    for (body, want) in vectors.iter().zip(&frozen) {
        let value = crate::operator_json::parse(body).expect("vector");
        let got = match crate::model_schema::parse(&value) {
            Ok(v) => format!("ok {}", omni_ir::jsjson::stringify(&v).unwrap_or_default()),
            Err(e) => format!("err {e}"),
        };
        if &got != want {
            failures.push(format!(
                "{}\n  ts:   {want}\n  rust: {got}",
                &body[..body.len().min(300)]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} differ:\n{}",
        failures.len(),
        vectors.len(),
        failures.join("\n")
    );
}
