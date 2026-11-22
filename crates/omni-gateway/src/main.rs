//! `omnigateway`: the gateway process.

use omni_gateway::{Options, logging, start};
use omni_gateway_core::config::{LogLevel, load_config, process_env};

/// mimalloc rather than glibc malloc: the request path allocates small
/// values per upstream chunk on every worker, and glibc's arena locks and
/// free-list work were a third of a streaming request's CPU.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() -> std::process::ExitCode {
    // Before argv allocation: mimalloc arenas must not fault 2 MiB transparent
    // huge pages for a mostly idle heap. CLI returns before runtime creation.
    #[cfg(target_os = "linux")]
    if nix::sys::prctl::set_thp_disable(true).is_err() {
        eprintln!("could not disable transparent huge pages; continuing");
    }
    let mut args = std::env::args();
    let executable = args.next().unwrap_or_default();
    let mut rest: Vec<_> = args.collect();
    if std::path::Path::new(&executable)
        .file_name()
        .is_some_and(|n| n == "omni")
    {
        return omni_cli::run(rest);
    }
    if rest.first().is_some_and(|s| s == "omni") {
        rest.remove(0);
        return omni_cli::run(rest);
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("could not start the runtime: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let code = if rest.as_slice() == ["cluster-bucket-sweep"] {
        runtime.block_on(cluster_bucket_sweep())
    } else {
        runtime.block_on(run())
    };
    // Connection tasks still alive past the drain deadline are dropped here.
    runtime.shutdown_timeout(std::time::Duration::from_millis(100));
    code
}

/// A separate one-shot, never part of ordinary replica startup. The operator
/// must stop every writer in the selected namespace before invoking it.
async fn cluster_bucket_sweep() -> std::process::ExitCode {
    let Some(url) = process_env()
        .remove("OMNI_REDIS_URL")
        .filter(|v| !v.is_empty())
    else {
        eprintln!("cluster bucket sweep requires OMNI_REDIS_URL");
        return std::process::ExitCode::FAILURE;
    };
    logging::install(logging::level_of(LogLevel::Info));
    let Ok(coord) = omni_coord::redis::RedisCoord::connect(&url, Default::default()).await else {
        tracing::error!("cluster bucket sweep coordinator connection failed");
        return std::process::ExitCode::FAILURE;
    };
    let result = coord.remote().sweep_buckets().await;
    coord.shutdown().await;
    if result.is_err() {
        tracing::error!("cluster bucket sweep failed; keep the fleet stopped and retry");
        return std::process::ExitCode::FAILURE;
    }
    tracing::info!("cluster bucket sweep complete");
    std::process::ExitCode::SUCCESS
}

async fn run() -> std::process::ExitCode {
    let env = process_env();
    let config = match load_config(&env, omni_store::rollup::host_day_offset_minutes) {
        Ok(c) => c,
        Err(e) => {
            logging::install(logging::level_of(LogLevel::Info));
            tracing::error!(reason = %e, "gateway boot failed");
            return std::process::ExitCode::FAILURE;
        }
    };
    logging::install(logging::level_of(config.log_level));
    if let Some(from) = &config.log_level_fallback_from {
        tracing::info!(reason = %from, "invalid log level; using info");
    }
    match &config.day_offset_fallback_from {
        None => tracing::info!(host = %config.host, port = config.port,
            dayOffsetMinutes = config.day_offset_minutes, "omnigateway booting"),
        Some(from) => tracing::info!(host = %config.host, port = config.port,
            dayOffsetMinutes = config.day_offset_minutes, reason = %from,
            "omnigateway booting; invalid day offset, using host offset"),
    }
    // The bench harness's writer barrier, off unless asked for.
    let options = Options {
        bench_endpoints: env.get("OMNI_BENCH").is_some_and(|v| v == "1"),
        version: omni_gateway::telemetry::version(&env),
        root: env.get("OMNI_ROOT").cloned(),
        ..Options::default()
    };
    let mut running = match start(config, options).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(reason = %e, "gateway boot failed");
            return std::process::ExitCode::FAILURE;
        }
    };

    let mut term = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(reason = %e, "gateway boot failed");
            return std::process::ExitCode::FAILURE;
        }
    };
    tokio::select! {
        result = running.wait_for_stop() => return match result {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(_) => std::process::ExitCode::FAILURE,
        },
        _ = term.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
    running.shutdown();
    let waiting = running.wait();
    tokio::pin!(waiting);
    tokio::select! {
        result = &mut waiting => match result {
            Ok(()) => std::process::ExitCode::SUCCESS,
            Err(_) => std::process::ExitCode::FAILURE,
        },
        // A second signal escalates.
        _ = term.recv() => std::process::ExitCode::FAILURE,
        _ = tokio::signal::ctrl_c() => std::process::ExitCode::FAILURE,
    }
}
