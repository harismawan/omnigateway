//! The `omnigateway` binary's library: boot (`apps/gateway/src/index.ts`),
//! the HTTP server, dispatch, egress, cancellation and shutdown.
//!
//! Boot order, as TS: configuration, the store (migrated), a heartbeat and the
//! pending-row sweep, the snapshot, the writer and limiter, then listen.
//! SIGTERM/SIGINT stop accepting, let connections drain up to TS's 5 s
//! deadline, flush the writer, and exit 0. A second signal exits 1.

pub mod clock;
pub mod dispatch;
pub mod finish;
pub mod jsc_json;
pub mod load;
pub mod logging;
pub mod models;
pub mod price;
pub mod server;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use hyper_util::rt::TokioIo;
use omni_gateway_core::config::Config;
use omni_gateway_core::ratelimit::RateLimiter;
use omni_gateway_core::snapshot::{MissConfig, MissResolver, SnapshotHolder};
use omni_store::SqliteStore;
use omni_store::writer::{Writer, WriterConfig};
use tokio::net::TcpListener;

/// `STOP_DEADLINE_MS`.
pub const STOP_DEADLINE: Duration = Duration::from_secs(5);
/// `NODE_GRACE_MS`.
const NODE_GRACE_MS: i64 = 60_000;
/// `KEEPALIVE_MS`.
pub const KEEPALIVE: Duration = Duration::from_secs(10);

/// `heartbeat` then `sweepPending` (`store.maintenance.heartbeat`,
/// `store.usage.sweepPending`): own pending rows, and pending rows of nodes
/// with no live heartbeat, are completed as 499 `interrupted` with zero
/// duration, through the writer like any other completion.
fn sweep_pending(
    store: &SqliteStore,
    node_id: &str,
    now: i64,
) -> Result<Vec<omni_store::writer::RequestLog>, omni_store::StoreError> {
    let c = store.connection();
    c.execute(
        "INSERT OR REPLACE INTO nodes (id, seen_at) VALUES (?, ?)",
        rusqlite::params![node_id, now],
    )?;
    c.execute(
        "DELETE FROM nodes WHERE seen_at < ?",
        rusqlite::params![now - 86_400_000],
    )?;
    let mut stmt = c.prepare(
        "SELECT id, at, api_key_id, requested_model, resolved_provider, resolved_model,
                credential_id, attempts, input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens, ttft_ms, cost_usd, degradations
           FROM request_logs
          WHERE state = 'pending'
            AND (node_id = ? OR node_id NOT IN (SELECT id FROM nodes WHERE seen_at > ?))",
    )?;
    let rows = stmt.query_map(rusqlite::params![node_id, now - NODE_GRACE_MS], |r| {
        let mut log = omni_store::writer::RequestLog::new(r.get::<_, String>(0)?, r.get(1)?, 499);
        log.api_key_id = r.get(2)?;
        log.requested_model = r.get(3)?;
        log.resolved_provider = r.get(4)?;
        log.resolved_model = r.get(5)?;
        log.credential_id = r.get(6)?;
        log.attempts = r.get(7)?;
        log.input_tokens = r.get(8)?;
        log.output_tokens = r.get(9)?;
        log.cache_read_tokens = r.get(10)?;
        log.cache_write_tokens = r.get(11)?;
        log.ttft_ms = r.get(12)?;
        log.cost_usd = r.get(13)?;
        let degradations: String = r.get(14)?;
        log.degradations = serde_json::from_str(&degradations).unwrap_or_default();
        log.error_code = Some("interrupted".into());
        log.duration_ms = 0;
        Ok(log)
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// A running gateway: the bound address and a way to stop it.
pub struct Running {
    pub addr: std::net::SocketAddr,
    stop: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<Result<(), String>>,
}

impl std::fmt::Debug for Running {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Running")
            .field("addr", &self.addr)
            .finish_non_exhaustive()
    }
}

impl Running {
    /// Starts a graceful shutdown.
    pub fn shutdown(&self) {
        self.stop.send_replace(true);
    }

    /// Waits for the server to finish draining and the writer to flush.
    pub async fn wait(self) -> Result<(), String> {
        self.task
            .await
            .map_err(|e| format!("gateway task failed: {e}"))?
    }
}

/// What a test may override at boot.
#[derive(Debug, Clone)]
pub struct Options {
    pub keepalive: Duration,
    pub stop_deadline: Duration,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            keepalive: KEEPALIVE,
            stop_deadline: STOP_DEADLINE,
        }
    }
}

/// Boots the gateway inside the current runtime and starts serving.
#[allow(clippy::too_many_lines)]
pub async fn start(config: Config, options: Options) -> Result<Running, String> {
    let now = clock::now_ms();
    let node_id = clock::uuid_v4();
    let key = omni_crypto::field::derive_key(&config.encryption_key);
    let path = std::path::PathBuf::from(&config.database_path);
    let offset = config.day_offset_minutes;

    let (store, swept) = {
        let path = path.clone();
        let node_id = node_id.clone();
        tokio::task::spawn_blocking(move || {
            let store = SqliteStore::open(&path, offset).map_err(|e| e.to_string())?;
            let swept = sweep_pending(&store, &node_id, now).map_err(|e| e.to_string())?;
            Ok::<_, String>((store, swept))
        })
        .await
        .map_err(|e| e.to_string())??
    };
    tracing::debug!(path = %path.display(), "store opened");

    let holder = {
        let key = key.clone();
        tokio::task::spawn_blocking(move || {
            #[allow(clippy::cast_precision_loss)]
            SnapshotHolder::build(&store, key, now as f64)
                .map(|h| (Arc::new(h), store))
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??
    };
    let (holder, store) = holder;

    let (commit_tx, commit_rx) = tokio::sync::mpsc::channel(4096);
    let writer = Writer::spawn(
        &path,
        WriterConfig {
            node_id: node_id.clone(),
            day_offset_minutes: offset,
            commit_sink: Some(commit_tx),
            ..WriterConfig::default()
        },
    )
    .map_err(|e| e.to_string())?;
    let handle = writer.handle();
    if !swept.is_empty() {
        let count = swept.len();
        for log in swept {
            if !handle.send(omni_store::writer::LogEvent::Finish(log)) {
                tracing::warn!("request log writer full during the boot sweep");
            }
        }
        tracing::info!(count = count, "retired interrupted requests");
    }

    let limiter = RateLimiter::new();
    let (asker, applier) = limiter.spawn_consumer(handle.clone(), commit_rx);
    {
        let snap = holder.load();
        for k in snap.keys_by_hash.values() {
            if let Some(limits) = &k.limits
                && !limits.is_unlimited()
            {
                #[allow(clippy::cast_precision_loss)]
                limiter.preseed(&k.id, limits, now as f64);
            }
        }
    }
    let refresher = holder
        .clone()
        .spawn_refresher(store, Duration::from_millis(500));
    let miss_store = tokio::task::spawn_blocking({
        let path = path.clone();
        move || SqliteStore::open(&path, offset).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let miss = MissResolver::new(
        holder.clone(),
        Arc::new(Mutex::new(miss_store)),
        MissConfig::default(),
    );

    let deps = Arc::new(dispatch::Deps {
        http: Arc::new(omni_providers::http::Client::new()),
        writer: handle.clone(),
        holder,
        load: load::LoadRegistry::new(),
        probes: load::Probes::new(),
        providers: omni_router::Providers::builtin(),
        health: dispatch::HealthOverlay::default(),
        now: clock::now_ms,
        rand: clock::random,
    });
    let app = Arc::new(server::App {
        deps,
        limiter,
        miss,
        node_id,
        keepalive: options.keepalive,
    });

    let listener = TcpListener::bind((config.host.as_str(), config.port))
        .await
        .map_err(|e| format!("listen on {}:{} failed: {e}", config.host, config.port))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    tracing::info!(host = %config.host, port = addr.port(), "omnigateway listening");

    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let deadline = options.stop_deadline;
    let task = tokio::spawn(async move {
        let graceful = hyper_util::server::graceful::GracefulShutdown::new();
        let mut builder = hyper::server::conn::http1::Builder::new();
        builder.timer(hyper_util::rt::TokioTimer::new());
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((sock, _)) = accepted else { continue };
                    if sock.set_nodelay(true).is_err() {
                        tracing::debug!("could not set TCP_NODELAY");
                    }
                    let app = app.clone();
                    let service = hyper::service::service_fn(move |req| {
                        server::handle(app.clone(), req)
                    });
                    let conn = graceful.watch(builder.serve_connection(TokioIo::new(sock), service));
                    tokio::spawn(async move {
                        if let Err(e) = conn.await {
                            tracing::debug!(reason = %e, "connection ended with an error");
                        }
                    });
                }
                _ = stopped.changed() => break,
            }
        }
        drop(listener);
        tracing::info!(reason = "signal", "shutdown requested");
        if tokio::time::timeout(deadline, graceful.shutdown())
            .await
            .is_err()
        {
            tracing::warn!(
                reason = "signal",
                "shutdown timed out waiting for connections to drain"
            );
        }
        // Responses still streaming past the deadline are dropped with the
        // runtime; their finishers file 499 rows before the writer closes,
        // because each connection task is aborted only after this point.
        drop(app);
        refresher.abort();
        asker.abort();
        let stats = writer.close().await;
        applier.abort();
        match stats {
            Ok(s) => {
                if s.dropped > 0 || s.failed > 0 {
                    tracing::warn!(
                        count = s.dropped,
                        rawCount = s.failed,
                        "request log writer lost events (count=dropped, rawCount=failed)"
                    );
                }
                Ok(())
            }
            Err(e) => {
                tracing::error!(reason = %e, "request log writer failed to flush");
                Err(e.to_string())
            }
        }
    });
    Ok(Running { addr, stop, task })
}
