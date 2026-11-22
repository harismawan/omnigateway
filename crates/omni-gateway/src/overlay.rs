//! The health rows this process wrote, until the store surely has them.
//!
//! A health transition must never compute from a stale row. Here the row
//! reaches the store
//! through the batched writer, and the snapshot refresher can rebuild from
//! the store before that batch commits, which would put the older row back.
//! The overlay is what the next transition starts from, and what is patched
//! back over a rebuilt snapshot, until [`OVERLAY_TTL`] says the store has
//! caught up. An outside write to the same pair inside that window (the CLI
//! resetting health) is overridden by this process's own row until the window
//! ends.
//!
//! Bounded: a sweeper task drops expired rows every 5 s with or without
//! traffic, every insert and read drops them too, and at most
//! [`OVERLAY_CAP`] rows are held (the oldest goes first). An evicted row is
//! only a lost guard against one race, never lost health: its write is
//! already in the writer's queue.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use omni_gateway_core::snapshot::SnapshotHolder;
use omni_store::CredentialHealth;
use tokio::time::Instant;

/// Well past the writer's batch interval (200 ms).
pub const OVERLAY_TTL: Duration = Duration::from_secs(5);
/// Most rows held.
pub const OVERLAY_CAP: usize = 4096;

#[derive(Debug, Default)]
pub struct HealthOverlay {
    rows: Mutex<Rows>,
}

#[derive(Debug, Default)]
pub struct Rows {
    map: HashMap<String, (CredentialHealth, Instant)>,
}

impl Rows {
    fn sweep(&mut self, now: Instant) {
        self.map
            .retain(|_, (_, at)| now.duration_since(*at) < OVERLAY_TTL);
    }

    /// The row for `key` if it is still fresh.
    pub fn fresh(&mut self, key: &str) -> Option<CredentialHealth> {
        self.sweep(Instant::now());
        self.map.get(key).map(|(row, _)| row.clone())
    }

    pub fn insert(&mut self, key: String, row: CredentialHealth) {
        let now = Instant::now();
        self.sweep(now);
        self.map.insert(key, (row, now));
        while self.map.len() > OVERLAY_CAP {
            let Some(oldest) = self
                .map
                .iter()
                .min_by_key(|(_, (_, at))| *at)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            self.map.remove(&oldest);
        }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

impl HealthOverlay {
    /// Drops expired rows every `every`, whether or not any request comes:
    /// an idle gateway holds no stale rows past one period. Owned by the
    /// gateway and aborted at shutdown.
    pub fn spawn_sweeper(
        overlay: std::sync::Arc<HealthOverlay>,
        every: Duration,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(every);
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                overlay.lock().sweep(Instant::now());
            }
        })
    }

    /// The rows, under the one lock that serializes health read-modify-writes.
    pub fn lock(&self) -> MutexGuard<'_, Rows> {
        self.rows.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Patches every fresh row the snapshot disagrees with. Cheap when
    /// nothing failed recently: the map is empty.
    pub fn reconcile(&self, holder: &SnapshotHolder) {
        let mut rows = self.lock();
        if rows.map.is_empty() {
            return;
        }
        rows.sweep(Instant::now());
        let snap = holder.load();
        for (key, (row, _)) in &rows.map {
            if snap.routing.health.get(key) != Some(row) {
                holder.patch_health(row.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str) -> CredentialHealth {
        omni_router::blank_health(id, "m")
    }

    #[tokio::test(start_paused = true)]
    async fn rows_expire_on_read_and_insert_without_a_dispatch() {
        let o = HealthOverlay::default();
        o.lock().insert("a".into(), row("a"));
        assert!(o.lock().fresh("a").is_some());
        tokio::time::advance(OVERLAY_TTL).await;
        assert!(o.lock().fresh("a").is_none());
        assert!(o.lock().is_empty());
        o.lock().insert("b".into(), row("b"));
        tokio::time::advance(OVERLAY_TTL).await;
        o.lock().insert("c".into(), row("c"));
        assert_eq!(o.lock().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn rows_expire_with_no_traffic_at_all() {
        let o = std::sync::Arc::new(HealthOverlay::default());
        let sweeper = HealthOverlay::spawn_sweeper(o.clone(), OVERLAY_TTL);
        o.lock().insert("a".into(), row("a"));
        // No fresh/insert/reconcile from here on: only the sweeper runs.
        tokio::time::sleep(OVERLAY_TTL * 3).await;
        assert_eq!(o.rows.lock().expect("rows").len(), 0);
        sweeper.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn the_overlay_is_capped_oldest_first() {
        let o = HealthOverlay::default();
        for i in 0..(OVERLAY_CAP + 10) {
            o.lock().insert(format!("k{i}"), row("x"));
            tokio::time::advance(Duration::from_micros(1)).await;
        }
        let mut rows = o.lock();
        assert_eq!(rows.len(), OVERLAY_CAP);
        assert!(rows.fresh("k0").is_none());
        assert!(rows.fresh(&format!("k{}", OVERLAY_CAP + 9)).is_some());
    }
}
