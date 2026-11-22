//! The gateway binary under a SIGPROF sampler (`pprof`), for rigs where
//! `perf_event_paranoid` forbids perf events. Same env as `omnigateway`; on
//! SIGTERM it prints the hottest functions, self and inclusive, to stderr.
//!
//!   cargo build --profile profiling -p omni-gateway --example profile_gateway
//!   OMNI_PROFILE_TOP=60 target/profiling/examples/profile_gateway

use std::collections::HashMap;

use omni_gateway::{Options, logging, start};
use omni_gateway_core::config::{load_config, process_env};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() {
    let guard = pprof::ProfilerGuardBuilder::default()
        .frequency(999)
        .build()
        .expect("profiler");
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        let config = load_config(&process_env(), omni_store::rollup::host_day_offset_minutes)
            .expect("config");
        logging::install(logging::level_of(config.log_level));
        let running = start(config, Options::default()).await.expect("start");
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("signal");
        term.recv().await;
        running.shutdown();
        running.wait().await.ok();
    });
    let report = guard.report().build().expect("report");
    let top: usize = std::env::var("OMNI_PROFILE_TOP")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(50);
    let mut own: HashMap<String, isize> = HashMap::new();
    let mut incl: HashMap<String, isize> = HashMap::new();
    let mut total = 0;
    for (frames, count) in &report.data {
        total += count;
        let names: Vec<String> = frames
            .frames
            .iter()
            .map(|f| f.first().map_or_else(|| "?".into(), |s| s.name()))
            .collect();
        if let Some(first) = names.first() {
            *own.entry(first.clone()).or_default() += count;
        }
        let mut seen = std::collections::HashSet::new();
        for n in names {
            if seen.insert(n.clone()) {
                *incl.entry(n).or_default() += count;
            }
        }
    }
    let show = |title: &str, m: &HashMap<String, isize>| {
        let mut v: Vec<_> = m.iter().collect();
        v.sort_by(|a, b| b.1.cmp(a.1));
        eprintln!("== {title} ({total} samples) ==");
        for (name, c) in v.into_iter().take(top) {
            #[allow(clippy::cast_precision_loss)]
            let pct = *c as f64 * 100.0 / total.max(1) as f64;
            let short: String = name.chars().take(150).collect();
            eprintln!("{pct:6.2}%  {short}");
        }
    };
    show("self", &own);
    show("inclusive", &incl);
    // `OMNI_PROFILE_CALLERS=memcpy`: who calls the functions matching it,
    // three frames up.
    if let Ok(needle) = std::env::var("OMNI_PROFILE_CALLERS") {
        let mut callers: HashMap<String, isize> = HashMap::new();
        for (frames, count) in &report.data {
            let names: Vec<String> = frames
                .frames
                .iter()
                .map(|f| f.first().map_or_else(|| "?".into(), |s| s.name()))
                .collect();
            if names.first().is_some_and(|n| n.contains(&needle)) {
                let chain: Vec<String> = names
                    .iter()
                    .skip(1)
                    .take(4)
                    .map(|n| n.chars().take(70).collect())
                    .collect();
                *callers.entry(chain.join(" <- ")).or_default() += count;
            }
        }
        show(&format!("callers of {needle}"), &callers);
    }
}
