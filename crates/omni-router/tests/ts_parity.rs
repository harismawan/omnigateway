//! Differential test: generated scenarios ranked by the TS router
//! (`packages/router/src/index.ts`, under Bun) and by this crate must give
//! the same candidates in the same order, with the same scores, reasons and
//! probes, and the same exclusions.

mod common;

use common::*;
use omni_router::{RankInput, RecentUse, Snapshot, health_key, rank};
use omni_store::{AuthType, BreakerState, QuotaWindow, Strategy, WindowType};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Write as _;
use std::process::{Command, Stdio};

/// xorshift64*, so the scenarios are the same on every run.
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
    fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
    #[allow(clippy::cast_precision_loss)]
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        #[allow(clippy::cast_possible_truncation)]
        &items[self.below(items.len() as u64) as usize]
    }
}

const PROVIDERS: [&str; 4] = ["anthropic", "custom", "kimi", "nonesuch"];
const MODELS: [&str; 3] = ["m1", "m2", "claude-opus-4"];

struct Scenario {
    snapshot_json: Value,
    snapshot: Snapshot,
    model: omni_store::VirtualModel,
    request_json: Value,
    rand: f64,
    load: HashMap<String, f64>,
    recent: HashMap<String, RecentUse>,
}

#[allow(clippy::cast_precision_loss, clippy::cast_possible_wrap)]
fn scenario(rng: &mut Rng) -> Scenario {
    let ncred = 1 + rng.below(5);
    let mut credentials = Vec::new();
    for i in 0..ncred {
        let provider = *rng.pick(&PROVIDERS[..3]);
        let mut c = cred_of(&format!("c{i}"), provider);
        if provider == "custom" {
            c.auth_type = AuthType::ApiKey;
            c.provider_data = json!({ "endpointId": *rng.pick(&["e1", "e2"]) });
        }
        c.enabled = rng.chance(85);
        c.tier = (1 + rng.below(3)) as f64;
        c.weight = *rng.pick(&[1.0, 0.5, 2.0, 3.0]);
        if rng.chance(20) {
            c.expires_at = Some(if rng.chance(50) { 999_000 } else { 2_000_000 });
            c.has_refresh_token = rng.chance(50);
        }
        if rng.chance(15) {
            c.auth_type = AuthType::ApiKey;
        }
        credentials.push(c);
    }
    let mut health = Vec::new();
    let mut quota: Vec<QuotaWindow> = Vec::new();
    let mut load = HashMap::new();
    let mut recent = HashMap::new();
    for c in &credentials {
        for m in MODELS {
            if rng.chance(30) {
                health.push(health_with(&c.id, |h| {
                    h.model = m.into();
                    h.consecutive_failures = rng.below(6) as i64;
                    h.breaker_state = rng
                        .pick(&[
                            BreakerState::Closed,
                            BreakerState::Open,
                            BreakerState::HalfOpen,
                        ])
                        .clone();
                    h.opened_at = rng
                        .chance(70)
                        .then(|| 1_000_000 - (rng.below(200_000) as i64));
                    h.rate_limited_until = rng
                        .chance(20)
                        .then(|| 1_000_000 + (rng.below(20_000) as i64) - 10_000);
                }));
            }
            if rng.chance(30) {
                load.insert(health_key(&c.id, m), rng.below(4) as f64);
            }
            if rng.chance(40) {
                recent.insert(
                    health_key(&c.id, m),
                    RecentUse {
                        last_released_at: NOW - rng.below(100_000) as f64,
                        ewma_ttft_ms: rng.chance(70).then(|| rng.below(3000) as f64),
                    },
                );
            }
        }
        if rng.chance(50) {
            for wt in [WindowType::FiveHour, WindowType::Weekly] {
                if rng.chance(60) {
                    quota.push(quota_with(
                        &c.id,
                        rng.below(120) as f64,
                        rng.chance(85).then_some(100.0),
                        |q| {
                            q.window_type = wt.clone();
                            q.observed_at = if rng.chance(85) {
                                NOW - rng.below(600_000) as f64
                            } else {
                                0.0
                            };
                            q.resets_at = rng
                                .chance(70)
                                .then(|| NOW + rng.below(20_000_000) as f64 - 1_000_000.0);
                            q.window_ms = rng.chance(30).then_some(10_800_000.0);
                        },
                    ));
                }
            }
        }
    }
    let ntargets = 1 + rng.below(4);
    let mut targets = Vec::new();
    for _ in 0..ntargets {
        let provider = *rng.pick(&PROVIDERS);
        let model = *rng.pick(&MODELS);
        targets.push(target_with(|t| {
            t.provider = provider.into();
            t.model = model.into();
            t.tier = (1 + rng.below(3)) as f64;
            t.weight = *rng.pick(&[1.0, 0.5, 2.0]);
            t.cost_per_m_tok = pricing(
                *rng.pick(&[0.0, 1.0, 3.0, 15.0]),
                *rng.pick(&[0.0, 2.0, 15.0, 75.0]),
            );
            if rng.chance(30) {
                t.cost_per_m_tok.cache_read = Some(0.3);
            }
            if provider == "custom" {
                t.endpoint_id = Some(json!(*rng.pick(&["e1", "e2"])));
            }
            t.capabilities.tools = rng.chance(85);
            t.capabilities.images = rng.chance(70);
            t.capabilities.reasoning = rng.chance(70);
            if rng.chance(15) {
                t.credential_id = Some(format!("c{}", rng.below(ncred + 1)));
            }
        }));
    }
    let strategy = rng
        .pick(&[
            Strategy::Score,
            Strategy::Priority,
            Strategy::RoundRobin,
            Strategy::Weighted,
        ])
        .clone();
    let model = model(targets, strategy);

    let mut request = json!({
        "model": "fast", "stream": true,
        "messages": [{ "role": "user", "content": [{ "type": "text", "text": "x".repeat(rng.below(5000) as usize) }] }]
    });
    if rng.chance(30) {
        request["tools"] = portable_tool();
    }
    if rng.chance(15) {
        request["messages"][0]["content"]
            .as_array_mut()
            .expect("content")
            .push(json!({ "type": "image", "mediaType": "image/png", "data": "A" }));
    }
    if rng.chance(20) {
        request["reasoning"] = json!({ "mode": *rng.pick(&["adaptive", "off", "betweenTools"]) });
    }
    if rng.chance(20) {
        request["messages"][0]["content"][0]["cacheControl"] = json!({ "type": "ephemeral" });
    }
    if rng.chance(20) {
        request["maxTokens"] = json!(rng.below(2000));
    }
    // Native parts in a tool result, in the system prompt or a message: TS
    // reads only the message ones as an owner.
    if rng.chance(10) {
        let block = json!({ "type": "toolResult", "toolUseId": "t", "content": "",
            "native": [{ "type": "providerNative", "provider": *rng.pick(&PROVIDERS[..3]),
                "blockType": "document", "data": {} }] });
        if rng.chance(50) {
            request["system"] = json!([block]);
        } else {
            request["messages"][0]["content"]
                .as_array_mut()
                .expect("content")
                .push(block);
        }
    }
    if rng.chance(8) {
        request["tools"] = json!([{ "kind": "provider", "provider": *rng.pick(&PROVIDERS[..3]),
            "type": "t", "name": "n", "wire": {} }]);
    }
    let settings = json!({
        "weights": { "tier": rng.below(11), "health": rng.below(4), "quota": rng.below(3),
            "cost": rng.below(3), "latency": rng.below(2), "load": rng.below(3) },
        "breakerThreshold": 1 + rng.below(4),
        "quotaPollIntervalMs": *rng.pick(&[60_000, 300_000]),
    });
    let snapshot_json = json!({
        "credentials": credentials,
        "health": health,
        "quota": quota,
        "settings": settings,
    });
    let snap = snapshot(Snap {
        credentials,
        health,
        quota,
        models: Vec::new(),
        settings,
    });
    Scenario {
        snapshot_json,
        snapshot: snap,
        model,
        request_json: request,
        rand: rng.unit(),
        load,
        recent,
    }
}

fn result_json(out: &omni_router::RankResult<'_>) -> Value {
    json!({
        "candidates": out.candidates.iter().map(|c| json!({
            "credential": c.credential.id,
            "model": c.target.model,
            "probe": c.probe,
            "score": c.score,
            "reasons": {
                "tier": c.reasons.tier, "health": c.reasons.health, "quota": c.reasons.quota,
                "cost": c.reasons.cost, "latency": c.reasons.latency, "load": c.reasons.load,
            },
        })).collect::<Vec<_>>(),
        "excluded": out.excluded.iter().map(|e| json!({
            "kind": e.kind.as_str(), "credentialId": e.credential_id, "model": e.model, "reason": e.reason,
        })).collect::<Vec<_>>(),
    })
}

const SCRIPT: &str = r#"
import { rank, healthKey } from "ROOT/packages/router/src/index.ts";
import { credential, snapshot } from "ROOT/packages/testkit/src/index.ts";
const cases = JSON.parse(await Bun.stdin.text());
const out = cases.map((c) => {
  const snap = snapshot({
    credentials: c.snapshot.credentials.map((x) => credential(x)),
    health: c.snapshot.health,
    quota: c.snapshot.quota,
    settings: c.snapshot.settings,
  });
  const r = rank({
    request: c.request, model: c.model, snapshot: snap, now: c.now, rand: c.rand,
    load: new Map(Object.entries(c.load)), recent: new Map(Object.entries(c.recent)),
  });
  return {
    candidates: r.candidates.map((x) => ({ credential: x.credential.id, model: x.target.model,
      probe: x.probe, score: x.score, reasons: x.reasons })),
    excluded: r.excluded.map((e) => ({ kind: e.kind, credentialId: e.credentialId, model: e.model, reason: e.reason })),
  };
});
console.log(JSON.stringify(out));
"#;

/// Numbers as `JSON.stringify` prints them, so `1` and `1.0` compare equal.
fn js(v: &Value) -> String {
    omni_ir::jsjson::to_string(v)
}

#[test]
fn rank_equals_the_ts_router_on_generated_scenarios() {
    let ok = Command::new("bun")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success());
    if !ok {
        println!("skipping: bun is not on PATH");
        return;
    }
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let scenarios: Vec<Scenario> = (0..400).map(|_| scenario(&mut rng)).collect();
    let cases: Vec<Value> = scenarios
        .iter()
        .map(|s| {
            json!({
                "snapshot": s.snapshot_json,
                "model": s.model,
                "request": s.request_json,
                "now": NOW,
                "rand": s.rand,
                "load": s.load,
                "recent": s.recent.iter().map(|(k, r)| (k.clone(), json!({
                    "lastReleasedAt": r.last_released_at, "ewmaTtftMs": r.ewma_ttft_ms,
                }))).collect::<serde_json::Map<_, _>>(),
            })
        })
        .collect();

    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("root");
    let file = std::env::temp_dir().join(format!("omni-rank-{}.ts", std::process::id()));
    std::fs::write(&file, SCRIPT.replace("ROOT", &root.display().to_string())).expect("script");
    let mut child = Command::new("bun")
        .arg(&file)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("bun");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(Value::Array(cases).to_string().as_bytes())
        .expect("write");
    let out = child.wait_with_output().expect("bun output");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let ts: Vec<Value> = serde_json::from_slice(&out.stdout).expect("ts json");

    let mut nonempty = 0;
    for (i, (s, expected)) in scenarios.iter().zip(ts).enumerate() {
        let request: omni_ir::request::ChatRequest =
            serde_json::from_value(s.request_json.clone()).expect("request");
        let input = RankInput {
            request: &request,
            model: &s.model,
            snapshot: &s.snapshot,
            now: NOW,
            rand: s.rand,
            load: Some(&s.load),
            recent: Some(&s.recent),
            providers: None,
        };
        let got = result_json(&rank(&input));
        if !got["candidates"].as_array().expect("c").is_empty() {
            nonempty += 1;
        }
        assert_eq!(
            js(&got),
            js(&expected),
            "scenario {i}: {}",
            js(&s.model_json())
        );
    }
    // The generator must exercise ranking, not only exclusion.
    assert!(nonempty > 150, "only {nonempty} scenarios ranked anything");
}

trait ModelJson {
    fn model_json(&self) -> Value;
}

impl ModelJson for Scenario {
    fn model_json(&self) -> Value {
        json!({ "model": self.model, "request": self.request_json, "snapshot": self.snapshot_json })
    }
}
