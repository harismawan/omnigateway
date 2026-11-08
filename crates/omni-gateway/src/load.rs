//! In-flight accounting and recent use per (credential, model), the
//! single-process `createLoadRegistry` (`dispatch/loadRegistry.ts`) that
//! `rank` reads: counts for the load term and round-robin, the last release
//! and an EWMA of time-to-first-token for latency.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use omni_router::{RecentUse, health_key};

/// Weight of the newest latency sample.
const EWMA_ALPHA: f64 = 0.3;

#[derive(Default)]
struct State {
    local: HashMap<String, f64>,
    history: HashMap<String, RecentUse>,
}

/// One per process.
#[derive(Default)]
pub struct LoadRegistry {
    state: Mutex<State>,
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

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Claims a slot; the count moves before this returns.
    pub fn acquire(self: &Arc<Self>, credential_id: &str, model: &str) -> LoadSlot {
        let key = health_key(credential_id, model);
        *self.lock().local.entry(key.clone()).or_insert(0.0) += 1.0;
        LoadSlot {
            registry: Some(self.clone()),
            key,
        }
    }

    /// In-flight count per `healthKey`; a missing key is zero. A copy, so a
    /// ranking sees one consistent picture.
    pub fn counts(&self) -> HashMap<String, f64> {
        self.lock().local.clone()
    }

    /// This process's record per `healthKey`.
    pub fn recent(&self) -> HashMap<String, RecentUse> {
        self.lock().history.clone()
    }

    fn release(&self, key: &str, ttft_ms: Option<i64>, now: f64) {
        let mut st = self.lock();
        let prior = st.history.get(key).and_then(|r| r.ewma_ttft_ms);
        #[allow(clippy::cast_precision_loss)]
        let ewma = match (ttft_ms, prior) {
            (None, p) => p,
            (Some(t), None) => Some(t as f64),
            (Some(t), Some(p)) => Some(p * (1.0 - EWMA_ALPHA) + t as f64 * EWMA_ALPHA),
        };
        st.history.insert(
            key.to_owned(),
            RecentUse {
                last_released_at: now,
                ewma_ttft_ms: ewma,
            },
        );
        if let Some(n) = st.local.get_mut(key) {
            *n -= 1.0;
            if *n <= 0.0 {
                st.local.remove(key);
            }
        }
    }
}

/// A claimed slot. Released once: by [`LoadSlot::release`] with the
/// attempt's TTFT, or on drop with none.
#[derive(Debug)]
#[must_use = "dropping the slot releases it"]
pub struct LoadSlot {
    registry: Option<Arc<LoadRegistry>>,
    key: String,
}

impl LoadSlot {
    pub fn key(&self) -> &str {
        &self.key
    }

    /// Idempotent.
    pub fn release(&mut self, ttft_ms: Option<i64>) {
        if let Some(r) = self.registry.take() {
            #[allow(clippy::cast_precision_loss)]
            r.release(&self.key, ttft_ms, crate::clock::now_ms() as f64);
        }
    }
}

impl Drop for LoadSlot {
    fn drop(&mut self) {
        self.release(None);
    }
}

/// The half-open probe claims (`coord.gauge` under `probe:<healthKey>`): one
/// probe per pair in this process.
#[derive(Default, Debug)]
pub struct Probes {
    held: Mutex<HashMap<String, u32>>,
}

impl Probes {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
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
            },
        )
    }
}

/// Released on drop.
#[derive(Debug)]
pub struct ProbeClaim {
    probes: Option<Arc<Probes>>,
    key: String,
}

impl Drop for ProbeClaim {
    fn drop(&mut self) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slots_count_release_once_and_fold_ttft() {
        let r = LoadRegistry::new();
        let mut a = r.acquire("c", "m");
        let b = r.acquire("c", "m");
        assert_eq!(r.counts().get("c::m"), Some(&2.0));
        a.release(Some(100));
        a.release(Some(999));
        assert_eq!(r.counts().get("c::m"), Some(&1.0));
        assert_eq!(r.recent()["c::m"].ewma_ttft_ms, Some(100.0));
        drop(b);
        assert!(r.counts().is_empty());
        assert_eq!(r.recent()["c::m"].ewma_ttft_ms, Some(100.0));
        let mut c = r.acquire("c", "m");
        c.release(Some(200));
        let e = r.recent()["c::m"].ewma_ttft_ms.expect("ewma");
        assert!((e - 130.0).abs() < 1e-9);
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
