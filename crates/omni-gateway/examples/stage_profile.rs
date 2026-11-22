//! Per-stage timing of the request path, on the benchmark's own payloads.
//!
//! `perf` is not usable on the bench rig (`perf_event_paranoid=2`), so this
//! times each stage in-process with `Instant` loops:
//!
//!   cargo run --profile profiling -p omni-gateway --example stage_profile -- \
//!     <agent.json> <c2000.sse>
//!
//! `agent.json` is `agentBody("bench-c1")` from `scripts/bench-gateway.ts`;
//! `c2000.sse` is the body `bench-gateway-upstream.ts` sends for
//! `mock-c2000-d0`. `scripts/bench-fixtures.ts` writes both.

use std::collections::VecDeque;
use std::hint::black_box;
use std::time::{Duration, Instant};

use omni_dialects::egress::{AnthropicStream, StreamEncoder};
use omni_dialects::ingress::{Headers, IngressOptions, Surface, ingest, random_tool_use_id};
use omni_ir::stream::StreamEvent;
use omni_providers::codec::{CodecInput, Credentials, ProviderCodec, StreamDecoder};
use omni_providers::custom::CustomCodec;
use omni_providers::custom::decode::ChatDecoder;
use omni_providers::sse::{SseMessage, SseParser};

/// As the binary: `OMNI_STAGE_SYSTEM_ALLOC=1` is not offered; rebuild without
/// this line to compare against glibc malloc.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn time<R>(name: &str, iters: u32, mut f: impl FnMut() -> R) -> Duration {
    for _ in 0..(iters / 10).max(1) {
        black_box(f());
    }
    let started = Instant::now();
    for _ in 0..iters {
        black_box(f());
    }
    let per = started.elapsed() / iters;
    println!("{name:<44} {:>10.1} µs", per.as_secs_f64() * 1e6);
    per
}

/// `OMNI_STAGE_SAMPLE=<stage>`: runs one stage for 3 s under a SIGPROF
/// sampler and prints its hottest functions (self, then inclusive).
fn sample<R>(mut f: impl FnMut() -> R) {
    let guard = pprof::ProfilerGuardBuilder::default()
        .frequency(2000)
        .build()
        .expect("profiler");
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(3) {
        black_box(f());
    }
    let report = guard.report().build().expect("report");
    let mut own: std::collections::HashMap<String, isize> = Default::default();
    let mut incl: std::collections::HashMap<String, isize> = Default::default();
    let mut total = 0;
    for (frames, count) in &report.data {
        total += count;
        let names: Vec<String> = frames
            .frames
            .iter()
            .map(|f| f.first().map_or_else(|| "?".into(), |s| s.name()))
            .collect();
        if let Some(n) = names.first() {
            *own.entry(n.clone()).or_default() += count;
        }
        let mut seen = std::collections::HashSet::new();
        for n in names {
            if seen.insert(n.clone()) {
                *incl.entry(n).or_default() += count;
            }
        }
    }
    for (title, m) in [("self", own), ("inclusive", incl)] {
        let mut v: Vec<_> = m.into_iter().collect();
        v.sort_by_key(|a| std::cmp::Reverse(a.1));
        println!("-- {title} ({total} samples)");
        for (n, c) in v.into_iter().take(35) {
            #[allow(clippy::cast_precision_loss)]
            let pct = c as f64 * 100.0 / total.max(1) as f64;
            println!("{pct:6.2}%  {}", n.chars().take(140).collect::<String>());
        }
    }
}

fn headers() -> Headers {
    let mut h = Headers::new();
    h.append("content-type", "application/json");
    h.append("anthropic-version", "2023-06-01");
    h
}

fn ingest_agent(body: &str, h: &Headers) -> omni_ir::request::ChatRequest {
    let mut mint = random_tool_use_id;
    let mut opts = IngressOptions {
        new_tool_use_id: &mut mint,
    };
    ingest(Surface::Anthropic, body, h, &mut opts)
        .expect("ingest")
        .request
}

/// The upstream body as the transport hands it over: 16 KiB reads.
fn chunks(sse: &[u8]) -> Vec<&[u8]> {
    sse.chunks(16 * 1024).collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let agent = std::fs::read_to_string(&args[1]).expect("agent.json");
    let sse = std::fs::read(&args[2]).expect("c2000.sse");
    let h = headers();

    println!(
        "sizes: StreamEvent {} B, Result<StreamEvent, GatewayError> {} B",
        std::mem::size_of::<StreamEvent>(),
        std::mem::size_of::<Result<StreamEvent, omni_ir::error::GatewayError>>()
    );
    println!("== boot ==");
    time("PBKDF2 field key (210k iterations)", 5, || {
        omni_crypto::field::derive_key("bench-only-encryption-key-0123456789")
    });
    println!("== agent-100k ingest ({} bytes) ==", agent.len());
    time("depth_bound pre-scan", 2000, || {
        omni_ir::deep::depth_bound(&agent)
    });
    time("deep::parse (depth_of + serde_stacker)", 2000, || {
        omni_ir::deep::parse(&agent).map(omni_ir::deep::Owned)
    });
    time("serde_json::from_str (reference)", 2000, || {
        serde_json::from_str::<serde_json::Value>(&agent).ok()
    });
    let bound = omni_ir::deep::depth_bound(&agent);
    time("deep::parse_bounded (ingest's parse)", 2000, || {
        omni_ir::deep::parse_bounded(&agent, bound).map(omni_ir::deep::Owned)
    });
    let value = omni_dialects::ingress::parse_body(&agent).expect("parse");
    time("anthropic::parse (validate + IR)", 2000, || {
        let mut mint = random_tool_use_id;
        let mut opts = IngressOptions {
            new_tool_use_id: &mut mint,
        };
        omni_dialects::ingress::anthropic::parse(&value, &h, &mut opts).expect("parse")
    });
    if std::env::var("OMNI_STAGE_SAMPLE").as_deref() == Ok("anthropic") {
        sample(|| {
            let mut mint = random_tool_use_id;
            let mut opts = IngressOptions {
                new_tool_use_id: &mut mint,
            };
            omni_dialects::ingress::anthropic::parse(&value, &h, &mut opts).expect("parse")
        });
    }
    time("ingest total (scan+parse+validate+IR)", 2000, || {
        ingest_agent(&agent, &h)
    });
    let chat = ingest_agent(&agent, &h);
    let creds = Credentials {
        access_token: None,
        api_key: Some("sk".into()),
        provider_data:
            serde_json::json!({"origin": "http://127.0.0.1:18100", "protocol": "chat_completions"})
                .as_object()
                .cloned()
                .unwrap_or_default(),
    };
    let input = CodecInput {
        request: &chat,
        model: "mock-c1-d0",
        credentials: &creds,
        request_id: Some("r"),
        auto_cache_enabled: Some(false),
        max_output_tokens: None,
        request_started_at: Some(0.0),
    };
    time("custom wire encode (IR→map)", 2000, || {
        omni_providers::custom::wire::to_custom_chat_wire(&chat, "mock-c1-d0")
    });
    time("build_request total (wire + jsjson)", 2000, || {
        CustomCodec.build_request(&input).expect("build")
    });
    let built = CustomCodec.build_request(&input).expect("build");
    println!("  upstream body {} bytes", built.request.body.len());
    time("ChatRequest clone", 2000, || chat.clone());

    println!("== many-chunks decode ({} bytes) ==", sse.len());
    let parts = chunks(&sse);
    time("SSE parse (all chunks)", 500, || {
        let mut p = SseParser::new();
        let mut out = Vec::new();
        for c in &parts {
            p.push(c, &mut out).expect("sse");
        }
        out
    });
    let mut msgs: Vec<SseMessage> = Vec::new();
    {
        let mut p = SseParser::new();
        for c in &parts {
            p.push(c, &mut msgs).expect("sse");
        }
    }
    println!("  {} messages", msgs.len());
    time("chat decode (all messages)", 500, || {
        let mut d = ChatDecoder::new();
        let mut out = VecDeque::new();
        for m in &msgs {
            if d.message(m, &mut out).is_err() {
                break;
            }
        }
        out
    });
    time("serde_json parse of each data (reference)", 500, || {
        msgs.iter()
            .filter_map(|m| serde_json::from_str::<serde_json::Value>(&m.data).ok())
            .count()
    });
    let mut events: Vec<StreamEvent> = Vec::new();
    {
        let mut d = ChatDecoder::new();
        let mut out = VecDeque::new();
        for m in &msgs {
            if d.message(m, &mut out).is_err() {
                break;
            }
        }
        events.extend(out);
    }
    println!("  {} events", events.len());
    time("anthropic egress encode (all events)", 500, || {
        let mut enc = StreamEncoder::Anthropic(AnthropicStream::new("req_x"));
        let mut buf = String::new();
        let mut total = 0;
        for e in &events {
            enc.push(e, &mut buf);
            let frame = bytes::Bytes::copy_from_slice(buf.as_bytes());
            total += frame.len();
            buf.clear();
        }
        total
    });
}
