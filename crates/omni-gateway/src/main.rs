//! `omnigateway`: the gateway process.

use omni_gateway::{Options, logging, start};
use omni_gateway_core::config::{LogLevel, load_config, process_env};

/// mimalloc rather than glibc malloc: the request path allocates small
/// values per upstream chunk on every worker, and glibc's arena locks and
/// free-list work were a third of a streaming request's CPU.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn main() -> std::process::ExitCode {
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
    // Before the first allocation of any size: with transparent huge pages
    // `always`, mimalloc's 32 MiB arena reservations fault in 2 MiB at a
    // time, so a mostly idle heap is resident in huge pages (idle RSS 17.5
    // MiB against 8.4 MiB without). The throughput difference measured as
    // noise. Inherited by nothing: the gateway spawns no processes.
    // `prctl` is Linux's; elsewhere there is no THP to opt out of.
    #[cfg(target_os = "linux")]
    if nix::sys::prctl::set_thp_disable(true).is_err() {
        eprintln!("could not disable transparent huge pages; continuing");
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
    let code = runtime.block_on(run());
    // Connection tasks still alive past the drain deadline are dropped here.
    runtime.shutdown_timeout(std::time::Duration::from_millis(100));
    code
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
        ..Options::default()
    };
    let running = match start(config, options).await {
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
