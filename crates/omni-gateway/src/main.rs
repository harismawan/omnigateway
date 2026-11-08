//! `omnigateway`: the gateway process.

use omni_gateway::{Options, logging, start};
use omni_gateway_core::config::{LogLevel, load_config, process_env};

fn main() -> std::process::ExitCode {
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
    let running = match start(config, Options::default()).await {
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
