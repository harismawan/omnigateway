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
pub mod overlay;
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

/// Pre-seeds every limited key in the snapshot: at once (the boot
/// snapshot, and anything a refresh swapped in before this task started),
/// then on every snapshot swap for each key that is new or whose limits
/// changed. Keys are diffed by (id, limits), so a key that gains limits is
/// seeded too. `preseed` is idempotent; the diff only keeps the queue quiet.
pub fn spawn_preseeder(
    holder: Arc<SnapshotHolder>,
    limiter: Arc<RateLimiter>,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut seen: std::collections::HashMap<String, serde_json::Value> =
            std::collections::HashMap::new();
        // `None`: nothing seen yet, so the first pass covers the current snapshot.
        let mut generation: Option<u64> = None;
        let mut tick = tokio::time::interval(interval);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            // Read the generation before the snapshot: a swap between the two
            // is seen again on the next tick, never missed.
            let now_gen = holder.generation();
            if generation == Some(now_gen) {
                continue;
            }
            generation = Some(now_gen);
            let snap = holder.load();
            let mut current = std::collections::HashMap::with_capacity(snap.keys_by_hash.len());
            for k in snap.keys_by_hash.values() {
                let limits = k
                    .limits
                    .as_ref()
                    .map_or(serde_json::Value::Null, omni_store::LimitConfig::to_json);
                if seen.get(&k.id) != Some(&limits)
                    && let Some(l) = &k.limits
                    && !l.is_unlimited()
                {
                    #[allow(clippy::cast_precision_loss)]
                    limiter.preseed(&k.id, l, clock::now_ms() as f64);
                }
                current.insert(k.id.clone(), limits);
            }
            seen = current;
        }
    })
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
    /// Bun's `idleTimeout` (255 s, its maximum, which TS sets): how long a
    /// request's headers may take, how long a keep-alive connection may sit
    /// between requests, and how long the request body may go without a byte.
    /// There is no total body deadline, as in TS.
    pub idle_timeout: Duration,
    /// `OMNI_BENCH=1`: serve `POST /__omni/bench/flush`, the bench harness's
    /// writer barrier. Off by default; not a TS route, and never for
    /// production: it makes the caller wait on the database.
    pub bench_endpoints: bool,
    /// The barrier's server-side deadline (30 s); tests shorten it.
    pub bench_flush_timeout: Duration,
    /// The writer's queue capacity, if not [`WriterConfig`]'s default; tests
    /// shrink it.
    pub writer_capacity: Option<usize>,
}

/// `idleTimeout: 255`.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(255);

impl Default for Options {
    fn default() -> Self {
        Self {
            keepalive: KEEPALIVE,
            stop_deadline: STOP_DEADLINE,
            idle_timeout: IDLE_TIMEOUT,
            bench_endpoints: false,
            bench_flush_timeout: Duration::from_secs(30),
            writer_capacity: None,
        }
    }
}

/// The HTTP/1 server configuration every connection is served with.
/// `idle` is the header read timeout: armed from the moment hyper waits for a
/// request head, so it bounds both a slow head and the idle wait between
/// keep-alive requests.
pub fn http1_builder(idle: Duration) -> hyper::server::conn::http1::Builder {
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder.timer(hyper_util::rt::TokioTimer::new());
    builder.header_read_timeout(idle);
    builder
}

/// Boots the gateway inside the current runtime and starts serving.
#[allow(clippy::too_many_lines)]
pub async fn start(config: Config, options: Options) -> Result<Running, String> {
    clock::init_request_ids()?;
    let now = clock::now_ms();
    let node_id = clock::uuid_v4();
    // PBKDF2 at 210 000 rounds is most of boot (~24 ms in release) and is a
    // storage contract, so it is not shortened: it runs on its own blocking
    // thread while the store opens, migrates and sweeps, which need no key.
    let kdf = {
        let secret = config.encryption_key.clone();
        tokio::task::spawn_blocking(move || omni_crypto::field::derive_key(&secret))
    };
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
    let key = kdf.await.map_err(|e| e.to_string())?;

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
            capacity: options
                .writer_capacity
                .unwrap_or(WriterConfig::default().capacity),
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
    // Boot keys are pre-seeded by the preseeder's first pass.
    let refresher = holder
        .clone()
        .spawn_refresher(store, Duration::from_millis(500));
    let preseeder = spawn_preseeder(holder.clone(), limiter.clone(), Duration::from_millis(500));
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

    let health = Arc::new(dispatch::HealthOverlay::default());
    let overlay_sweeper =
        dispatch::HealthOverlay::spawn_sweeper(health.clone(), overlay::OVERLAY_TTL);
    let deps = Arc::new(dispatch::Deps {
        http: Arc::new(omni_providers::http::Client::new()),
        writer: handle.clone(),
        holder,
        load: load::LoadRegistry::new(),
        probes: load::Probes::new(),
        providers: omni_router::Providers::builtin(),
        health: health.clone(),
        now: clock::now_ms,
        rand: clock::random,
    });
    let app = Arc::new(server::App {
        deps,
        limiter,
        miss,
        node_id,
        keepalive: options.keepalive,
        idle_timeout: options.idle_timeout,
        bench_endpoints: options.bench_endpoints,
        bench_flush_timeout: options.bench_flush_timeout,
    });

    let listener = TcpListener::bind((config.host.as_str(), config.port))
        .await
        .map_err(|e| format!("listen on {}:{} failed: {e}", config.host, config.port))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    tracing::info!(host = %config.host, port = addr.port(), "omnigateway listening");

    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let deadline = options.stop_deadline;
    let idle = options.idle_timeout;
    let task = tokio::spawn(async move {
        let graceful = hyper_util::server::graceful::GracefulShutdown::new();
        let builder = http1_builder(idle);
        // Every connection task, so a drain that runs out of time can cancel
        // and join them (their finishers file 499s) before the writer closes.
        let mut conns = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                Some(_) = conns.join_next(), if !conns.is_empty() => {}
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
                    conns.spawn(async move {
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
        // Connections still open past the deadline are cancelled here and
        // joined: dropping each one drops its response body, whose finisher
        // files the 499 row into the writer, which is closed only after.
        conns.abort_all();
        while conns.join_next().await.is_some() {}
        drop(app);
        refresher.abort();
        preseeder.abort();
        overlay_sweeper.abort();
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
