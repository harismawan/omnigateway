//! Differential test: the same scripted sequence of admits, completions and
//! clock moves, run through TS `ApiKeyRateLimiter` (memory coord, a real
//! store, under Bun) and through this limiter, must give the same outcome at
//! every step: admitted or refused, `retryAfterMs`, and the headroom the
//! rate-limit headers render.
//!
//! Rust seeds in the background; the script pre-seeds every subject before
//! the first step (as the spec says conformance does), after the historical
//! rows are written, so both sides start from the same picture.

use omni_gateway_core::ratelimit::{Admission, RateLimiter};
use omni_ratelimit::HeadroomByDimension;
use omni_store::SqliteStore;
use omni_store::limits::parse_limits;
use rusqlite::params;
use serde_json::{Value, json};
use std::io::Write as _;
use std::process::{Command, Stdio};

const T0: f64 = 10_020_000.0;
const HOUR: f64 = 3_600_000.0;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const LIMITS: &[&str] = &[
    r#"{"requests":{"1m":3}}"#,
    r#"{"requests":{"1m":5,"5h":4},"concurrency":2}"#,
    r#"{"tokens":{"5h":500,"1w":2000}}"#,
    r#"{"spend":{"5h":1.5}}"#,
    r#"{"requests":{"1m":2},"models":{"opus":{"requests":{"5h":3},"tokens":{"1w":400}}}}"#,
    r#"{"models":{"opus":{"concurrency":1,"spend":{"1w":2}}}}"#,
    r#"{"requests":{"1m":4,"1w":6},"tokens":{"5h":300},"models":{"opus":{"requests":{"1m":1}}}}"#,
];

#[allow(clippy::cast_precision_loss)]
fn script(rng: &mut Rng) -> (Vec<Value>, Vec<Value>) {
    let mut history = Vec::new();
    for _ in 0..rng.below(6) {
        history.push(json!({
            "at": T0 - (rng.below(6 * 24) as f64) * HOUR - rng.below(3_600_000) as f64,
            "model": if rng.below(2) == 0 { "fast" } else { "opus" },
            "tokens": rng.below(200),
            "cost": (rng.below(100) as f64) / 100.0,
        }));
    }
    let mut steps = Vec::new();
    let mut clock = T0;
    for _ in 0..25 {
        match rng.below(10) {
            0..=3 => steps.push(json!({ "op": "admit", "model": if rng.below(3) == 0 { "opus" } else { "fast" } })),
            4..=5 => steps.push(json!({ "op": "complete", "tokens": rng.below(150), "cost": (rng.below(80) as f64) / 100.0 })),
            6 => steps.push(json!({ "op": "release" })),
            7 => steps.push(json!({ "op": "consume", "model": if rng.below(2) == 0 { "opus" } else { "fast" } })),
            _ => {
                clock += [1_000.0, 30_000.0, 61_000.0, HOUR][usize::try_from(rng.below(4)).unwrap_or(0)];
                steps.push(json!({ "op": "at", "ms": clock }));
            }
        }
    }
    (history, steps)
}

const TS: &str = r#"
import { memoryCoord } from "ROOT/packages/coord/src/index.ts";
import { ApiKeyRateLimiter } from "ROOT/apps/gateway/src/auth/rateLimit.ts";
import { memoryStore, requestLog, seedApiKey } from "ROOT/packages/testkit/src/index.ts";
const cases = JSON.parse(await Bun.stdin.text());
const out = [];
for (const c of cases) {
  const store = await memoryStore();
  const { key } = await seedApiKey(store, { limits: c.limits });
  let n = 0;
  const row = async (at, model, tokens, cost) => store.usage.append(requestLog({
    id: `r${n++}`, apiKeyId: key.id, requestedModel: model, at,
    inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost }));
  for (const h of c.history) await row(h.at, h.model, h.tokens, h.cost);
  let clock = c.t0;
  const limiter = new ApiKeyRateLimiter({ store, now: () => clock, coord: memoryCoord() });
  // Pre-seed every subject: an admission of each model, released at once.
  for (const m of ["fast", "opus"]) { try { (await limiter.admit(key.id, c.limits, m)).release(); } catch {} }
  const held = [];
  let lastModel = "fast";
  const steps = [];
  for (const s of c.steps) {
    if (s.op === "at") { clock = s.ms; steps.push(null); continue; }
    if (s.op === "release") { held.shift()?.release(); steps.push(null); continue; }
    if (s.op === "complete") {
      await row(clock, lastModel, s.tokens, s.cost);
      limiter.debit(key.id, lastModel, { tokens: s.tokens, costUsd: s.cost });
      steps.push(null); continue;
    }
    lastModel = s.model;
    try {
      if (s.op === "consume") { await limiter.consume(key.id, c.limits, s.model); steps.push({ ok: {} }); continue; }
      const a = await limiter.admit(key.id, c.limits, s.model);
      held.push(a);
      steps.push({ ok: a.headroom });
    } catch (e) {
      if (e.code !== "RATE_LIMIT") throw e;
      steps.push({ refused: { retryAfterMs: e.retryAfterMs, headroom: e.headroom ?? {} } });
    }
  }
  store.close();
  out.push(steps);
}
console.log(JSON.stringify(out));
"#;

fn headroom_json(h: &HeadroomByDimension) -> Value {
    let mut m = serde_json::Map::new();
    for (name, entry) in [
        ("requests", h.requests),
        ("tokens", h.tokens),
        ("spend", h.spend),
    ] {
        if let Some(e) = entry {
            m.insert(
                name.into(),
                json!({ "window": e.window.as_str(), "limit": e.limit, "used": e.used,
                        "remaining": e.remaining, "resetAt": e.reset_at }),
            );
        }
    }
    Value::Object(m)
}

#[allow(clippy::cast_possible_truncation)]
fn run_rust(limits_json: &str, history: &[Value], steps: &[Value]) -> Vec<Value> {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = SqliteStore::open(dir.path().join("omni.db"), 0).expect("store");
    let limits = parse_limits(limits_json).expect("limits");
    let mut n = 0;
    let row = |n: &mut usize, at: f64, model: &str, tokens: f64, cost: f64| {
        *n += 1;
        store
            .connection()
            .execute(
                "INSERT INTO request_logs (id, at, api_key_id, requested_model, status, duration_ms, input_tokens, cost_usd)
                 VALUES (?,?,?,?,200,0,?,?)",
                params![format!("r{n}"), at as i64, "k1", model, tokens as i64, cost],
            )
            .expect("row");
    };
    for h in history {
        row(
            &mut n,
            h["at"].as_f64().expect("at"),
            h["model"].as_str().expect("m"),
            h["tokens"].as_f64().expect("t"),
            h["cost"].as_f64().expect("c"),
        );
    }
    // The key-wide 1w seed reads the hourly rollup.
    omni_store::rollup::rebuild_rollup(store.connection()).expect("rollup");
    let limiter = RateLimiter::new();
    let mut clock = T0;
    // The same pre-seed admissions TS makes (each claims a ring slot), then
    // the background seed, run before the first step.
    // TS seeds inside its first admission (blocking); Rust seeds in the
    // background. Seed first, then make the same pre-seed admissions, so
    // both judge them against the same picture.
    for m in ["fast", "opus"] {
        limiter.prepare("k1", &limits, m, clock);
    }
    limiter.seed_pending(&store);
    for m in ["fast", "opus"] {
        drop(limiter.admit("k1", &limits, m, clock));
    }
    let mut held: std::collections::VecDeque<Admission> = std::collections::VecDeque::new();
    let mut last = "fast".to_owned();
    let mut out = Vec::new();
    for s in steps {
        match s["op"].as_str().expect("op") {
            "at" => {
                clock = s["ms"].as_f64().expect("ms");
                out.push(Value::Null);
            }
            "release" => {
                held.pop_front();
                out.push(Value::Null);
            }
            "complete" => {
                let (t, c) = (
                    s["tokens"].as_f64().expect("t"),
                    s["cost"].as_f64().expect("c"),
                );
                row(&mut n, clock, &last, t, c);
                limiter.debit("k1", &last, t, c, clock, clock);
                out.push(Value::Null);
            }
            op => {
                last = s["model"].as_str().expect("model").to_owned();
                let refused = |e: omni_gateway_core::ratelimit::RateLimitExceeded| json!({ "refused": { "retryAfterMs": e.retry_after_ms, "headroom": headroom_json(&e.headroom) } });
                if op == "consume" {
                    out.push(match limiter.consume("k1", &limits, &last, clock) {
                        Ok(()) => json!({ "ok": {} }),
                        Err(e) => refused(e),
                    });
                } else {
                    out.push(match limiter.admit("k1", &limits, &last, clock) {
                        Ok(a) => {
                            let v = json!({ "ok": headroom_json(&a.headroom) });
                            held.push_back(a);
                            v
                        }
                        Err(e) => refused(e),
                    });
                }
            }
        }
    }
    out
}

#[test]
fn the_limiter_equals_the_ts_limiter_step_for_step() {
    if !Command::new("bun")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
    {
        println!("skipping: bun is not on PATH");
        return;
    }
    let mut rng = Rng(0x2545_f491_4f6c_dd1d);
    let mut cases = Vec::new();
    for i in 0..140 {
        let limits = LIMITS[i % LIMITS.len()];
        let (history, steps) = script(&mut rng);
        cases.push((limits, history, steps));
    }
    let input: Vec<Value> = cases
        .iter()
        .map(|(l, h, s)| json!({ "limits": serde_json::from_str::<Value>(l).expect("json"), "history": h, "steps": s, "t0": T0 }))
        .collect();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("root");
    let file = std::env::temp_dir().join(format!("omni-rl-{}.ts", std::process::id()));
    std::fs::write(&file, TS.replace("ROOT", &root.display().to_string())).expect("script");
    let mut child = Command::new("bun")
        .arg(&file)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("bun");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(Value::Array(input).to_string().as_bytes())
        .expect("w");
    let out = child.wait_with_output().expect("out");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let ts: Vec<Vec<Value>> = serde_json::from_slice(&out.stdout).expect("json");

    let (mut refusals, mut admits) = (0, 0);
    for (i, ((limits, history, steps), expected)) in cases.iter().zip(ts).enumerate() {
        let got = run_rust(limits, history, steps);
        for (j, (g, e)) in got.iter().zip(&expected).enumerate() {
            if g.get("refused").is_some() {
                refusals += 1;
            } else if g.get("ok").is_some() {
                admits += 1;
            }
            assert_eq!(
                omni_ir::jsjson::to_string(g),
                omni_ir::jsjson::to_string(e),
                "case {i} step {j} ({}) limits {limits}\nhistory {history:?}\nsteps {:?}",
                steps[j],
                &steps[..=j]
            );
        }
    }
    assert!(
        refusals > 100 && admits > 300,
        "{refusals} refusals, {admits} admits"
    );
}
