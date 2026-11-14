//! The `omnigateway` binary's library: boot (`apps/gateway/src/index.ts`),
//! the HTTP server, dispatch, egress, cancellation and shutdown.
//!
//! Boot order, as TS: configuration, the store (migrated), a heartbeat and the
//! pending-row sweep, the snapshot, the writer and limiter, then listen.
//! SIGTERM/SIGINT stop accepting, let connections drain up to TS's 5 s
//! deadline, flush the writer, and exit 0. A second signal exits 1.

pub mod admin_auth;
pub mod admin_routes;
pub mod api;
pub mod client_routes;
pub mod clock;
pub mod dispatch;
pub mod finish;
pub mod jsc_json;
pub mod load;
pub mod logging;
pub mod models;
mod output_budget;
pub mod overlay;
pub mod price;
pub mod server;
pub mod static_files;
pub mod telemetry;

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
            for k in snap.keys() {
                let limits = k
                    .limits
                    .as_ref()
                    // Well-formed view on purpose: a lone-surrogate override
                    // is never seeded (TS never builds its subject).
                    .map_or(
                        serde_json::Value::Null,
                        omni_store::LimitConfig::to_json_well_formed,
                    );
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

/// The default dashboard directory: the first of `<exe dir>/public` and the
/// checkout's `apps/dashboard/dist` that exists, else the latter.
fn default_static_dir() -> String {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(std::path::Path::to_path_buf));
    let mut candidates = Vec::new();
    if let Some(d) = &exe_dir {
        candidates.push(d.join("public"));
        // `target/<profile>/omnigateway` in a checkout.
        candidates.push(d.join("../../apps/dashboard/dist"));
    }
    candidates
        .iter()
        .find(|p| p.exists())
        .or(candidates.last())
        .map(|p| {
            std::path::absolute(p)
                .unwrap_or_else(|_| p.clone())
                .to_string_lossy()
                .into_owned()
        })
        .unwrap_or_else(|| "public".to_owned())
}

/// Plugins are not run by this release (spec, non-goals). Where TS would
/// load `<root>/plugins/<id>` (each directory, in sorted order; `root` is
/// `OMNI_ROOT`, else the database's directory), one `warn` per entry; then
/// TS's `plugins resolved` line with the count actually loaded, zero.
pub fn warn_plugins(root: Option<&str>, database_path: &str) {
    let root = root.map_or_else(
        || {
            std::path::Path::new(database_path)
                .parent()
                .map(std::path::Path::to_path_buf)
                .unwrap_or_default()
        },
        std::path::PathBuf::from,
    );
    let dir = std::path::absolute(root.join("plugins")).unwrap_or_else(|_| root.join("plugins"));
    let mut ids: Vec<String> = std::fs::read_dir(&dir)
        .map(|it| {
            it.filter_map(Result::ok)
                // `Dirent.isDirectory()`: a symlink is not followed.
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    for id in &ids {
        tracing::warn!(plugin = %id, reason = "plugins are not supported in this release",
            "plugin skipped");
    }
    tracing::info!(count = 0, path = %dir.display(), "plugins resolved");
}

/// A running gateway: the bound address and a way to stop it.
pub struct Running {
    pub addr: std::net::SocketAddr,
    stop: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<Result<(), String>>,
    #[cfg(test)]
    app: Arc<server::App>,
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
    /// Startup seed installation bound; includes all limited boot subjects.
    pub boot_seed_timeout: Duration,
    /// Deterministic seed scheduling delay for embedded/test startup probes.
    pub seed_delay: Duration,
    /// `VERSION` (`omni_build_info`); see [`telemetry::version`].
    pub version: String,
    /// `OMNI_ROOT`, where `plugins/` lives (else the database's directory).
    pub root: Option<String>,
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
            boot_seed_timeout: Duration::from_secs(30),
            seed_delay: Duration::ZERO,
            version: "0.0.0-dev".to_owned(),
            root: None,
        }
    }
}

/// The HTTP/1 server configuration every connection is served with.
/// `idle` is the header read timeout: armed from the moment hyper waits for a
/// request head, so it bounds both a slow head and the idle wait between
/// keep-alive requests.
///
/// hyper's own `date` header is off: Bun writes one on every response but a
/// HEAD's, so [`server::handle`] stamps it (see `server::stamp_date`).
pub fn http1_builder(idle: Duration) -> hyper::server::conn::http1::Builder {
    let mut builder = hyper::server::conn::http1::Builder::new();
    builder.timer(hyper_util::rt::TokioTimer::new());
    builder.header_read_timeout(idle);
    builder.auto_date_header(false);
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

    let (commit_tx, mut commit_rx) = tokio::sync::mpsc::channel(4096);
    let writer = Writer::spawn(
        &path,
        WriterConfig {
            node_id: node_id.clone(),
            day_offset_minutes: offset,
            commit_sink: Some(commit_tx),
            seed_delay: options.seed_delay,
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
    // Before any listener/background consumer: serial ordered writer seeds,
    // receiving and installing each result rather than merely queueing work.
    // Per-key draining also keeps large boot snapshots within queue budgets.
    tokio::time::timeout(options.boot_seed_timeout, async {
        for key in holder.load().keys() {
            let Some(limits) = &key.limits else {
                continue;
            };
            #[allow(clippy::cast_precision_loss)]
            limiter.preseed(&key.id, limits, clock::now_ms() as f64);
            for job in limiter.take_seed_jobs() {
                let query = RateLimiter::seed_query(&job);
                if !handle.seed(query.clone()) {
                    return Err("boot seed writer queue unavailable".to_string());
                }
                loop {
                    let event = commit_rx.recv().await.ok_or("boot seed sink closed")?;
                    let installed = match &event {
                        omni_store::writer::Committed::Seed {
                            query: received,
                            result,
                        } => {
                            result
                                .as_ref()
                                .map_err(|e| format!("boot seed failed: {e}"))?;
                            received.subject == query.subject && received.tag == query.tag
                        }
                        omni_store::writer::Committed::Gap => {
                            return Err("boot completion delivery gap".into());
                        }
                        _ => false,
                    };
                    limiter.apply(event);
                    if installed {
                        break;
                    }
                }
            }
            if !limiter.is_preseeded(&key.id, limits) {
                return Err("boot seed capacity exceeded; not all windows installed".into());
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "boot seed installation timed out".to_string())??;
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
    // The admin surface's own connection: password rows and client-session
    // key checks, never on the request path's.
    let admin_store = tokio::task::spawn_blocking({
        let path = path.clone();
        move || SqliteStore::open(&path, offset).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    // The admin routes' config connection: keys, models, settings.
    let control_store = tokio::task::spawn_blocking({
        let path = path.clone();
        move || SqliteStore::open(&path, offset).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let admin = {
        let now: admin_auth::Clock = Arc::new(clock::now_ms);
        // Sessions live in this process: a restart ends every one (spec:
        // in-process store for a single node; D2 plugs a shared one in).
        let kv = Arc::new(admin_auth::MemoryKv::new(now.clone()));
        admin_auth::AdminAuth::new(admin_store, kv, now, admin_auth::SESSION_TTL_MS)
    };

    // `dashboardDir()`: `OMNI_STATIC_DIR` taken literally when set. Without
    // it TS tries `./public` and `../../dashboard/dist` beside its bundle;
    // the Rust binary has no bundle directory, so it tries `public/` beside
    // the executable and the checkout's `apps/dashboard/dist`.
    let static_dir = config.static_dir.clone().unwrap_or_else(default_static_dir);
    let static_root = static_files::resolve_root(&static_dir);
    if std::path::Path::new(&static_dir).exists() {
        tracing::info!(path = %static_dir, "dashboard directory resolved");
    } else {
        tracing::info!(path = %static_dir, "dashboard directory absent");
    }
    warn_plugins(options.root.as_deref(), &config.database_path);

    // All fallible startup work precedes task spawning. A failed bind drops
    // the owned writer (which signals stop), with no detached refresher tasks.
    let listener = TcpListener::bind((config.host.as_str(), config.port))
        .await
        .map_err(|e| format!("listen on {}:{} failed: {e}", config.host, config.port))?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let (asker, applier) = limiter.spawn_consumer(handle.clone(), commit_rx);
    let refresher = holder
        .clone()
        .spawn_refresher(store, Duration::from_millis(500));
    let preseeder = spawn_preseeder(holder.clone(), limiter.clone(), Duration::from_millis(500));

    let health = Arc::new(dispatch::HealthOverlay::default());
    let overlay_sweeper =
        dispatch::HealthOverlay::spawn_sweeper(health.clone(), overlay::OVERLAY_TTL);
    let telemetry = Arc::new(telemetry::Telemetry::new(
        config.metrics_token.is_some(),
        config.metrics_max_series,
        &options.version,
    ));
    let http = {
        let t = telemetry.clone();
        let client = omni_providers::http::Client::new();
        if t.enabled() {
            client.with_on_response_head(Arc::new(move |provider, ms| t.http_head(provider, ms)))
        } else {
            client
        }
    };
    let deps = Arc::new(dispatch::Deps {
        http: Arc::new(http),
        telemetry,
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
        deadline_workers: server::DeadlineWorkers::new(),
        deps,
        limiter,
        miss,
        node_id,
        keepalive: options.keepalive,
        idle_timeout: options.idle_timeout,
        bench_endpoints: options.bench_endpoints,
        bench_flush_timeout: options.bench_flush_timeout,
        metrics_token: config.metrics_token.clone(),
        static_root,
        admin,
        base_url_https: api::base_url_is_https(&config.base_url),
        control: admin_routes::ControlStore::new(control_store),
        credential_key: key.clone(),
        body_logging_allowed: config.body_logging_allowed,
        day_offset_minutes: offset,
        reported_catalog_problems: std::sync::Mutex::default(),
    });

    tracing::info!(host = %config.host, port = addr.port(), "omnigateway listening");

    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let deadline = options.stop_deadline;
    let idle = options.idle_timeout;
    #[cfg(test)]
    let test_app = app.clone();
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
        // Abort only requests cancellation. Join the body pumps as well so
        // their source/Finisher destructors finish before the writer closes.
        app.deadline_workers.shutdown().await;
        #[cfg(test)]
        app.deadline_workers.before_writer_close();
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
    Ok(Running {
        addr,
        stop,
        task,
        #[cfg(test)]
        app: test_app,
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::io::AsyncWriteExt as _;

    /// Review A4-I1 over HTTP: a client that hangs up while its login's
    /// Argon2 verification runs does not free that verification's slot. The
    /// stored hash uses t=40 (19 MiB, a few seconds), so the job outlives
    /// the connection by a wide margin.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_hung_up_login_keeps_its_hashing_slot_until_argon2_finishes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("gateway.db");
        {
            let store = omni_store::SqliteStore::open(&path, 0).expect("open");
            // `Bun.password.hash("correct-horse-battery", {argon2id, m=19456, t=40})`,
            // with t raised: verification honours the stored parameters.
            store
                .connection()
                .execute(
                    "INSERT INTO settings (key, value) VALUES ('adminPasswordHash', ?)",
                    ["$argon2id$v=19$m=19456,t=40,p=1$t+bb0UkoQ0wovwgdTOvnEc7mm1XTbABXL7r8RMlrGCc$KvvTq59OWsxxKPGifAvoPd2OVA5js6CNGZoVpFGKQ1Y"],
                )
                .expect("hash");
        }
        let env = std::collections::HashMap::from([
            (
                "OMNI_ENCRYPTION_KEY".into(),
                "test-encryption-key-0123456789".into(),
            ),
            ("OMNI_DB_PATH".into(), path.to_str().expect("path").into()),
        ]);
        let mut config = omni_gateway_core::config::load_config(&env, || 0).expect("config");
        config.port = 0;
        let running = crate::start(config, crate::Options::default())
            .await
            .expect("start");
        let permits = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
        assert_eq!(running.app.admin.idle_hashing_permits(), permits);

        let mut s = tokio::net::TcpStream::connect(running.addr)
            .await
            .expect("connect");
        let body = r#"{"password":"anything-at-all"}"#;
        s.write_all(
            format!(
                "POST /api/login HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .expect("write");
        // Wait for verification to take its slot, then hang up.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while running.app.admin.idle_hashing_permits() == permits {
            assert!(
                tokio::time::Instant::now() < deadline,
                "verify never started"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        drop(s);
        // Long enough for hyper to drop the cancelled request future.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            running.app.admin.idle_hashing_permits(),
            permits - 1,
            "the hung-up login's slot was freed while Argon2 still ran"
        );
        // The slot comes back once the job itself ends.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        while running.app.admin.idle_hashing_permits() < permits {
            assert!(
                tokio::time::Instant::now() < deadline,
                "slot never returned"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        running.shutdown();
        running.wait().await.expect("stop");
    }
}
