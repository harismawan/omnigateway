//! The frozen maintenance timers: no immediate tick, per-node heartbeat,
//! leased hourly sweep. Blocking work is owned and drained on shutdown.
use omni_coord::Coord;
use omni_store::writer::WriterHandle;
use std::{path::PathBuf, sync::Arc, time::Duration};

pub const HEARTBEAT: Duration = Duration::from_secs(10);
pub const SWEEP: Duration = Duration::from_secs(3600);
pub const LEASE_TTL_MS: u64 = 7_200_000;

pub struct Maintenance {
    stop: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl Maintenance {
    pub async fn stop(&mut self) {
        self.stop.send_replace(true);
        drop((&mut self.task).await);
    }
}

impl Drop for Maintenance {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        self.task.abort();
    }
}

fn timer(period: Duration) -> tokio::time::Interval {
    let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    tick
}

pub fn start(
    path: PathBuf,
    offset: i64,
    node: String,
    writer: WriterHandle,
    coord: Arc<dyn Coord>,
) -> Maintenance {
    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let task = tokio::spawn(async move {
        let mut heartbeat = timer(HEARTBEAT);
        let mut sweep = timer(SWEEP);
        let mut jobs = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                _ = stopped.changed() => break,
                Some(_) = jobs.join_next(), if !jobs.is_empty() => {},
                _ = heartbeat.tick() => {
                    let path = path.clone();
                    let node = node.clone();
                    jobs.spawn_blocking(move || {
                        let _access = omni_store::lifecycle::access();
                        let result = omni_store::open_connection(&path).and_then(|c| omni_store::maintenance::heartbeat(&c, &node, crate::clock::now_ms()));
                        if let Err(e) = result { tracing::warn!(reason = %e, "heartbeat failed"); }
                    });
                }
                _ = sweep.tick() => {
                    let path = path.clone();
                    let node = node.clone();
                    let writer = writer.clone();
                    let coord = coord.clone();
                    jobs.spawn(async move {
                        if !coord.lease_acquire("maintenance", &node, LEASE_TTL_MS).await { return; }
                        run_sweep(path, offset, node, writer).await;
                    });
                }
            }
        }
        while jobs.join_next().await.is_some() {}
    });
    Maintenance { stop, task }
}

async fn run_sweep(path: PathBuf, offset: i64, node: String, writer: WriterHandle) {
    let _ = writer; // Recovery must not use the lossy request-path queue.
    let pending = tokio::task::spawn_blocking({
        let path = path.clone();
        move || {
            let _access = omni_store::lifecycle::access();
            let mut c = omni_store::open_connection(&path)?;
            omni_store::writer::recover_pending(&mut c, &node, crate::clock::now_ms(), offset)
        }
    })
    .await;
    match pending {
        Ok(Ok(count)) if count > 0 => tracing::info!(count, "retired interrupted requests"),
        Ok(Ok(_)) => {}
        Ok(Err(e)) => tracing::error!(reason = %e, "pending sweep failed"),
        Err(e) => tracing::error!(reason = %e, "pending sweep failed"),
    }
    let files = tokio::task::spawn_blocking({
        let path = path.clone();
        move || {
            let _access = omni_store::lifecycle::access();
            let result = (|| -> Result<usize, String> {
                let s = omni_store::SqliteStore::open(&path, offset)
                    .map_err(|e| e.to_string())?
                    .get_settings()
                    .map_err(|e| e.to_string())?;
                let snapshots = omni_control::database::prune_snapshots(
                    &path,
                    crate::clock::now_ms(),
                    s.snapshot_keep_latest,
                    s.snapshot_max_age_days,
                )?;
                Ok(snapshots
                    + omni_control::database::sweep_staging(&path, crate::clock::now_ms())?)
            })();
            match result {
                Ok(count) => tracing::debug!(count, "snapshots and staging files swept"),
                Err(e) => tracing::error!(reason = %e, "snapshot sweeping failed"),
            }
        }
    });
    let logs = tokio::task::spawn_blocking(move || {
        let _access = omni_store::lifecycle::access();
        match prune_logs(&path, offset, crate::clock::now_ms()) {
            Ok([raw, daily, quota, bodies]) => tracing::debug!(
                rawCount = raw,
                dailyCount = daily,
                quotaSampleCount = quota,
                count = bodies,
                "request logs pruned"
            ),
            Err(e) => tracing::error!(reason = %e, "log pruning failed"),
        }
    });
    drop(tokio::join!(files, logs));
}

pub fn prune_logs(path: &std::path::Path, offset: i64, now: i64) -> Result<[usize; 4], String> {
    let store = omni_store::SqliteStore::open(path, offset).map_err(|e| e.to_string())?;
    let raw_settings =
        omni_store::settings::operator_raw(store.connection()).map_err(|e| e.to_string())?;
    let (horizon, body_horizon) = omni_store::maintenance::horizons(raw_settings.as_deref(), now)
        .map_err(|e| e.to_string())?;
    let c = store.connection();

    let raw = omni_store::maintenance::prune(c, horizon).map_err(|e| e.to_string())?;
    let daily = omni_store::maintenance::prune_daily(c, now as f64 - 400.0 * 86_400_000.0)
        .map_err(|e| e.to_string())?;
    let quota =
        omni_store::maintenance::prune_quota_samples(c, horizon).map_err(|e| e.to_string())?;
    let dir = path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("request_bodies");
    let bodies = omni_control::database::prune_bodies(c, &dir, body_horizon)?;
    let cap = omni_control::database::prune_bodies_to_cap(c, &dir, 100_000)?;
    let orphans = omni_control::database::sweep_body_orphans(c, &dir)?;
    Ok([raw, daily, quota, bodies + cap + orphans])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(start_paused = true)]
    async fn first_tick_is_delayed_and_heartbeat_keeps_ten_second_interval() {
        let mut beat = timer(HEARTBEAT);
        let mut sweep = timer(SWEEP);
        let start = tokio::time::Instant::now();
        beat.tick().await;
        assert_eq!(start.elapsed(), HEARTBEAT);
        beat.tick().await;
        assert_eq!(start.elapsed(), 2 * HEARTBEAT);
        sweep.tick().await;
        assert_eq!(start.elapsed(), SWEEP);
        sweep.tick().await;
        assert_eq!(start.elapsed(), 2 * SWEEP);
    }

    #[tokio::test(start_paused = true)]
    async fn another_holders_lease_skips_sweep_not_heartbeats() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("db");
        let store = omni_store::SqliteStore::open(&path, 0).expect("store");
        store.connection().execute("INSERT INTO request_logs(id,at,requested_model,status,duration_ms,state,node_id) VALUES ('pending',1,'m',0,0,'pending','dead')", []).expect("seed");
        let writer =
            omni_store::writer::Writer::spawn(&path, omni_store::writer::WriterConfig::default())
                .expect("writer");
        let coord = Arc::new(omni_coord::MemoryCoord::new(Arc::new(|| 0.0)));
        assert!(
            coord
                .lease_acquire("maintenance", "other", LEASE_TTL_MS)
                .await
        );
        let mut maintenance = start(path, 0, "mine".into(), writer.handle(), coord);
        tokio::task::yield_now().await;
        tokio::time::advance(SWEEP).await;
        tokio::task::yield_now().await;
        maintenance.stop().await;
        let c = store.connection();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM nodes WHERE id='mine'", [], |r| r
                .get::<_, i64>(0))
                .expect("heartbeat"),
            1
        );
        assert_eq!(
            c.query_row(
                "SELECT state FROM request_logs WHERE id='pending'",
                [],
                |r| r.get::<_, String>(0)
            )
            .expect("pending"),
            "pending"
        );
        writer.close().await.expect("close");
    }
}
