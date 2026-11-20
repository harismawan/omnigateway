//! In-flight accounting and recent use per (credential, model), the
//! single-process `createLoadRegistry` (`dispatch/loadRegistry.ts`) that
//! `rank` reads: counts for the load term and round-robin, the last release
//! and an EWMA of time-to-first-token for latency.
//!
//! Bounded: a pair's history is forgotten [`HISTORY_TTL`] after its last
//! release (TS keeps it for the process's life; past an hour the router's
//! idle/latency terms for a pair nobody uses are moot), and at most
//! [`HISTORY_CAP`] pairs are kept, oldest release first out.
//!
//! Readers get an `Arc` of the maps, swapped on every change, so a ranking
//! takes a pointer, not a copy.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use omni_router::{RecentUse, health_key};

/// Weight of the newest latency sample.
const EWMA_ALPHA: f64 = 0.3;
/// How long an unused pair's history is kept.
pub const HISTORY_TTL_MS: f64 = 3_600_000.0;
/// Most pairs with history.
pub const HISTORY_CAP: usize = 10_000;

#[derive(Default)]
struct State {
    local: Arc<HashMap<String, f64>>,
    history: Arc<HashMap<String, RecentUse>>,
    /// When expired history was last swept; sweeps run at most once a
    /// minute, or at once when over the cap.
    swept_at: f64,
    /// `localCounts()`: in-flight slots per provider, in the insertion order
    /// of TS's `Map` (an entry leaves at zero and re-enters at the end).
    providers: Vec<(String, u64)>,
}

const SWEEP_EVERY_MS: f64 = 60_000.0;

/// One per process.
#[derive(Default)]
pub struct LoadRegistry {
    state: Mutex<State>,
    fleet: Option<Arc<omni_cluster_limit::load::LoadView>>,
}

impl std::fmt::Debug for LoadRegistry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoadRegistry").finish_non_exhaustive()
    }
}

impl LoadRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn shared(view: Arc<omni_cluster_limit::load::LoadView>) -> Arc<Self> {
        Arc::new(Self {
            fleet: Some(view),
            ..Self::default()
        })
    }

    pub(crate) fn fleet_metrics(&self) -> Option<&omni_cluster_limit::load::LoadMetrics> {
        self.fleet.as_ref().map(|view| &view.metrics)
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Claims a slot; the count moves before this returns.
    pub fn acquire(self: &Arc<Self>, credential_id: &str, model: &str, provider: &str) -> LoadSlot {
        let key = health_key(credential_id, model);
        {
            let mut st = self.lock();
            *Arc::make_mut(&mut st.local)
                .entry(key.clone())
                .or_insert(0.0) += 1.0;
            match st.providers.iter_mut().find(|(p, _)| p == provider) {
                Some((_, n)) => *n += 1,
                None => st.providers.push((provider.to_owned(), 1)),
            }
        }
        let fleet = self.fleet.as_ref().map(|fleet| fleet.acquire(&key));
        LoadSlot {
            registry: Some(self.clone()),
            key,
            provider: provider.to_owned(),
            ttft_ms: None,
            fleet,
        }
    }

    /// `localCounts()`: this process's in-flight slots per provider.
    pub fn provider_counts(&self) -> Vec<(String, u64)> {
        self.lock().providers.clone()
    }

    /// In-flight count per `healthKey`; a missing key is zero.
    pub fn counts(&self) -> Arc<HashMap<String, f64>> {
        let local = self.lock().local.clone();
        let Some(remote) = self.fleet.as_ref().map(|f| f.remote()) else {
            return local;
        };
        if remote.is_empty() {
            return local;
        }
        if local.is_empty() {
            return remote;
        }
        let mut both = remote.as_ref().clone();
        for (key, n) in local.iter() {
            *both.entry(key.clone()).or_default() += n;
        }
        Arc::new(both)
    }

    /// This process's record per `healthKey`.
    pub fn recent(&self) -> Arc<HashMap<String, RecentUse>> {
        self.lock().history.clone()
    }

    fn release(&self, key: &str, provider: &str, ttft_ms: Option<i64>, now: f64) {
        let mut st = self.lock();
        if let Some(i) = st.providers.iter().position(|(p, _)| p == provider) {
            st.providers[i].1 -= 1;
            if st.providers[i].1 == 0 {
                st.providers.remove(i);
            }
        }
        let sweep = now - st.swept_at >= SWEEP_EVERY_MS;
        if sweep {
            st.swept_at = now;
        }
        let history = Arc::make_mut(&mut st.history);
        let prior = history.get(key).and_then(|r| r.ewma_ttft_ms);
        #[allow(clippy::cast_precision_loss)]
        let ewma = match (ttft_ms, prior) {
            (None, p) => p,
            (Some(t), None) => Some(t as f64),
            (Some(t), Some(p)) => Some(p * (1.0 - EWMA_ALPHA) + t as f64 * EWMA_ALPHA),
        };
        history.insert(
            key.to_owned(),
            RecentUse {
                last_released_at: now,
                ewma_ttft_ms: ewma,
            },
        );
        if sweep || history.len() > HISTORY_CAP {
            history.retain(|_, r| now - r.last_released_at < HISTORY_TTL_MS);
        }
        if history.len() > HISTORY_CAP {
            let mut by_age: Vec<(String, f64)> = history
                .iter()
                .map(|(k, r)| (k.clone(), r.last_released_at))
                .collect();
            by_age.sort_by(|a, b| a.1.total_cmp(&b.1));
            for (k, _) in by_age.into_iter().take(history.len() - HISTORY_CAP) {
                history.remove(&k);
            }
        }
        let local = Arc::make_mut(&mut st.local);
        if let Some(n) = local.get_mut(key) {
            *n -= 1.0;
            if *n <= 0.0 {
                local.remove(key);
            }
        }
    }

    /// Test hook: release at an explicit instant.
    pub fn release_at(&self, key: &str, ttft_ms: Option<i64>, now: f64) {
        self.release(key, "", ttft_ms, now);
    }
}

/// A claimed slot. Released once: by [`LoadSlot::release`], or on drop with
/// the TTFT recorded by [`LoadSlot::observed`] (TS's attempt `finally` calls
/// `releaseSlot(log.ttftMs)` on every way out, a cancel included).
#[derive(Debug)]
#[must_use = "dropping the slot releases it"]
pub struct LoadSlot {
    registry: Option<Arc<LoadRegistry>>,
    key: String,
    provider: String,
    ttft_ms: Option<i64>,
    fleet: Option<omni_cluster_limit::load::LoadSlot>,
}

impl LoadSlot {
    pub fn key(&self) -> &str {
        &self.key
    }

    /// The attempt committed after `ttft_ms`.
    pub fn observed(&mut self, ttft_ms: i64) {
        self.ttft_ms = Some(ttft_ms);
    }

    /// Idempotent.
    pub fn release(&mut self, ttft_ms: Option<i64>) {
        drop(self.fleet.take());
        if let Some(r) = self.registry.take() {
            #[allow(clippy::cast_precision_loss)]
            r.release(
                &self.key,
                &self.provider,
                ttft_ms,
                crate::clock::now_ms() as f64,
            );
        }
    }
}

impl Drop for LoadSlot {
    fn drop(&mut self) {
        self.release(self.ttft_ms);
    }
}

/// The half-open probe claims (`coord.gauge` under `probe:<healthKey>`): one
/// probe per pair in this process. Entries exist only while claimed.
#[derive(Default, Debug)]
pub struct Probes {
    held: Mutex<HashMap<String, u32>>,
    remote: Option<omni_coord::redis::Remote>,
}

impl Probes {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn shared(remote: omni_coord::redis::Remote) -> Arc<Self> {
        Arc::new(Self {
            remote: Some(remote),
            ..Self::default()
        })
    }

    /// The released fleet policy uses an expiring probe, not a renewed lease.
    /// The named release guard also covers cancellation while Redis is replying.
    pub async fn claim(self: &Arc<Self>, key: &str) -> (u64, ProbeClaim) {
        if let Some(remote) = &self.remote {
            let holder = omni_crypto::codex::uuid_v4_from(&omni_crypto::apikey::generate());
            let claim = ProbeClaim {
                probes: None,
                key: key.to_owned(),
                remote: Some((remote.clone(), holder)),
            };
            if let Some((remote, holder)) = &claim.remote
                && let Ok(before) = remote
                    .gauge_acquire(key, probe_now(), 180_000, Some(holder))
                    .await
            {
                return (before, claim);
            }
        }
        let (before, claim) = self.acquire(key);
        (u64::from(before), claim)
    }

    /// Claims and reports how many were held before this claim.
    pub fn acquire(self: &Arc<Self>, key: &str) -> (u32, ProbeClaim) {
        let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        let n = held.entry(key.to_owned()).or_insert(0);
        let before = *n;
        *n += 1;
        (
            before,
            ProbeClaim {
                probes: Some(self.clone()),
                key: key.to_owned(),
                remote: None,
            },
        )
    }
}

/// Released on drop.
pub struct ProbeClaim {
    probes: Option<Arc<Probes>>,
    key: String,
    remote: Option<(omni_coord::redis::Remote, String)>,
}

impl Drop for ProbeClaim {
    fn drop(&mut self) {
        if let Some((remote, holder)) = &self.remote
            && remote
                .gauge_release_detached(&self.key, probe_now(), Some(holder))
                .is_err()
        {
            tracing::debug!(
                reason = "coord release refused",
                "probe release deferred to expiry"
            );
        }
        if let Some(p) = self.probes.take() {
            let mut held = p.held.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(n) = held.get_mut(&self.key) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    held.remove(&self.key);
                }
            }
        }
    }
}

#[allow(clippy::cast_precision_loss)]
fn probe_now() -> f64 {
    crate::clock::now_ms() as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_count_release_once_and_fold_ttft() {
        let r = LoadRegistry::new();
        let mut a = r.acquire("c", "m", "p");
        let b = r.acquire("c", "m", "p");
        assert_eq!(r.counts().get("c::m"), Some(&2.0));
        a.release(Some(100));
        a.release(Some(999));
        assert_eq!(r.counts().get("c::m"), Some(&1.0));
        assert_eq!(r.recent()["c::m"].ewma_ttft_ms, Some(100.0));
        drop(b);
        assert!(r.counts().is_empty());
        assert_eq!(r.recent()["c::m"].ewma_ttft_ms, Some(100.0));
        let mut c = r.acquire("c", "m", "p");
        c.release(Some(200));
        let e = r.recent()["c::m"].ewma_ttft_ms.expect("ewma");
        assert!((e - 130.0).abs() < 1e-9);
    }

    /// `localCounts()`: a `Map` per provider, entries leaving at zero and
    /// re-entering last, as `omni_inflight` lists them.
    #[test]
    fn provider_counts_keep_map_order() {
        let r = LoadRegistry::new();
        let a = r.acquire("c", "m", "p");
        let b = r.acquire("d", "m", "q");
        let c = r.acquire("e", "m", "p");
        assert_eq!(
            r.provider_counts(),
            vec![("p".to_owned(), 2), ("q".to_owned(), 1)]
        );
        drop(a);
        drop(c);
        let again = r.acquire("c", "m", "p");
        assert_eq!(
            r.provider_counts(),
            vec![("q".to_owned(), 1), ("p".to_owned(), 1)]
        );
        drop(b);
        drop(again);
        assert!(r.provider_counts().is_empty());
    }

    #[test]
    fn a_dropped_slot_releases_with_its_observed_ttft() {
        let r = LoadRegistry::new();
        let mut a = r.acquire("c", "m", "p");
        a.observed(42);
        drop(a);
        assert_eq!(r.recent()["c::m"].ewma_ttft_ms, Some(42.0));
    }

    #[test]
    fn history_expires_and_is_capped() {
        let r = LoadRegistry::new();
        r.release_at("old::m", None, 0.0);
        r.release_at("new::m", None, HISTORY_TTL_MS + 1.0);
        let recent = r.recent();
        assert!(!recent.contains_key("old::m"));
        assert!(recent.contains_key("new::m"));
        for i in 0..(HISTORY_CAP + 50) {
            #[allow(clippy::cast_precision_loss)]
            r.release_at(&format!("c{i}::m"), None, HISTORY_TTL_MS + 2.0 + i as f64);
        }
        let recent = r.recent();
        assert_eq!(recent.len(), HISTORY_CAP);
        assert!(recent.contains_key(&format!("c{}::m", HISTORY_CAP + 49)));
        assert!(!recent.contains_key("c0::m"));
    }

    #[test]
    fn readers_share_one_map_until_it_changes() {
        let r = LoadRegistry::new();
        let _a = r.acquire("c", "m", "p");
        let x = r.counts();
        let y = r.counts();
        assert!(Arc::ptr_eq(&x, &y));
    }

    #[test]
    fn a_probe_claim_reports_the_holder_before_it() {
        let p = Probes::new();
        let (first, a) = p.acquire("k");
        let (second, b) = p.acquire("k");
        assert_eq!((first, second), (0, 1));
        drop(a);
        drop(b);
        let (again, _c) = p.acquire("k");
        assert_eq!(again, 0);
    }
}
