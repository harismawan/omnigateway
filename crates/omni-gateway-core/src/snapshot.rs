//! The in-memory snapshot every request is served from (spec, "The request
//! path" rule 1): API keys by hash, the routing snapshot (models,
//! credentials with decrypted secrets, health, quota, settings).
//!
//! One `Arc<GatewaySnapshot>` behind an [`ArcSwap`]: a request loads it once
//! and keeps that view for its life; a rebuild swaps a new one in without
//! blocking anyone. The [`SnapshotHolder::spawn_refresher`] task polls
//! `PRAGMA data_version` and rebuilds off the request path, as TS's
//! `createRoutingSnapshotCache` does on its next `get` after the version
//! moves. Health is patched in place, as TS applies `healthSaved`.
//!
//! Degradation per model: a `virtual_models` row that does not read is left
//! out with a `warn` naming it, and every other model is served.

use arc_swap::ArcSwap;
use omni_crypto::field::FieldKey;
use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::js::trim;
use omni_router::Snapshot;
use omni_store::{ApiKey, CredentialHealth, LimitConfig, SqliteStore, StoreError};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// One consistent view: keys and routing read in one transaction.
#[derive(Debug, Clone)]
pub struct GatewaySnapshot {
    /// Keyed by `api_keys.hash` (sha256 hex of the raw key).
    pub keys_by_hash: HashMap<String, Arc<ApiKey>>,
    pub routing: Snapshot,
}

/// A key that passed authentication: usable, with readable limits.
#[derive(Debug, Clone)]
pub struct AuthenticatedKey {
    pub key: Arc<ApiKey>,
    pub limits: LimitConfig,
}

impl std::ops::Deref for AuthenticatedKey {
    type Target = ApiKey;
    fn deref(&self) -> &ApiKey {
        &self.key
    }
}

#[derive(Debug, Clone)]
pub enum AuthOutcome {
    Ok(AuthenticatedKey),
    /// Not in the snapshot: resolve the hash through
    /// [`crate::miss::MissResolver::resolve`], then authenticate again.
    Miss,
    Refused(GatewayError),
}

/// `extractToken`: `Bearer <token>` (case-insensitive), a bare token, or none.
pub fn extract_token(header: Option<&str>) -> Option<&str> {
    let value = trim(header?);
    if value.is_empty() {
        return None;
    }
    // `/^Bearer\s+(.+)$/i`: "bearer" then at least one whitespace then one
    // or more characters.
    if value.len() > 6 && value.as_bytes()[..6].eq_ignore_ascii_case(b"bearer") {
        let rest = &value[6..];
        if rest.starts_with(omni_ir::js::is_js_whitespace) {
            let token = trim(rest);
            if !token.is_empty() {
                return Some(token);
            }
        }
    }
    Some(value)
}

/// `apiKeyHeader`: the one credential header to authenticate, refusing two
/// that disagree. `Ok(None)` is neither header present.
pub fn api_key_header<'a>(
    authorization: Option<&'a str>,
    x_api_key: Option<&'a str>,
) -> Result<Option<&'a str>, GatewayError> {
    match (authorization, x_api_key) {
        (None, x) => Ok(x),
        (a, None) => Ok(a),
        (a, x) => match (extract_token(a), extract_token(x)) {
            (Some(a), Some(x)) if a == x => Ok(Some(a)),
            _ => Err(auth("conflicting API key headers")),
        },
    }
}

fn auth(message: &str) -> GatewayError {
    GatewayError::new(ErrorCode::Auth, message).gateway_authored()
}

/// Judges a found (or missing) key, as `authenticateApiKey` does after its
/// store lookup: usable first, then limits readable.
fn judge(key: Option<&Arc<ApiKey>>, now_ms: i64) -> Result<AuthenticatedKey, GatewayError> {
    let Some(key) = key.filter(|k| k.usable(now_ms)) else {
        return Err(auth("invalid API key"));
    };
    match &key.limits {
        Some(limits) => Ok(AuthenticatedKey {
            key: key.clone(),
            limits: limits.clone(),
        }),
        None => {
            tracing::error!(api_key_id = %key.id, "api key refused: limits unreadable");
            Err(
                GatewayError::new(ErrorCode::Internal, "api key configuration is unusable")
                    .gateway_authored(),
            )
        }
    }
}

impl GatewaySnapshot {
    /// `authenticateApiKey` against the snapshot. `header` is the value
    /// `apiKeyHeader` chose (Bearer or x-api-key).
    pub fn authenticate(&self, header: Option<&str>, now_ms: i64) -> AuthOutcome {
        let Some(raw) = extract_token(header) else {
            return AuthOutcome::Refused(auth("missing or malformed Authorization header"));
        };
        let hash = omni_crypto::apikey::hash(raw);
        match self.keys_by_hash.get(&hash) {
            None => AuthOutcome::Miss,
            some => match judge(some, now_ms) {
                Ok(k) => AuthOutcome::Ok(k),
                Err(e) => AuthOutcome::Refused(e),
            },
        }
    }

    /// The verdict for a hash after the fallback read found nothing.
    pub fn refuse_unknown() -> GatewayError {
        auth("invalid API key")
    }
}

/// Owns the current snapshot and the key the secrets are opened with.
pub struct SnapshotHolder {
    current: ArcSwap<GatewaySnapshot>,
    key: FieldKey,
    /// `data_version` read just before the boot read, on the connection
    /// the refresher is then handed. Anything committed after it is a move.
    boot_version: i64,
    /// Bumped by every wholesale replacement (each rebuild), so a negative
    /// key lookup recorded before it is known to be stale.
    generation: AtomicU64,
}

impl std::fmt::Debug for SnapshotHolder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SnapshotHolder").finish_non_exhaustive()
    }
}

/// Reads everything a snapshot needs, in one read transaction.
pub fn read_snapshot(
    store: &SqliteStore,
    key: &FieldKey,
    now: f64,
) -> Result<GatewaySnapshot, StoreError> {
    let data = store.snapshot_reads(key)?;
    let models = data
        .models
        .into_iter()
        .filter_map(|row| match row {
            Ok(m) => Some(m),
            Err(e) => {
                tracing::warn!(model = %e.id, reason = %e.reason,
                    "virtual model unreadable; left out of the routing snapshot");
                None
            }
        })
        .collect();
    let keys_by_hash = data
        .api_keys
        .into_iter()
        .map(|k| (k.hash.clone(), Arc::new(k)))
        .collect();
    Ok(GatewaySnapshot {
        keys_by_hash,
        routing: Snapshot::new(
            data.credentials,
            data.health,
            data.quota,
            models,
            data.settings,
            now,
        ),
    })
}

fn now_ms() -> f64 {
    #[allow(clippy::cast_precision_loss)]
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

impl SnapshotHolder {
    /// The boot read. Fails boot if the store cannot be read at all.
    pub fn build(store: &SqliteStore, key: FieldKey, now: f64) -> Result<Self, StoreError> {
        let boot_version = store.data_version()?;
        let first = read_snapshot(store, &key, now)?;
        Ok(Self {
            current: ArcSwap::from_pointee(first),
            key,
            boot_version,
            generation: AtomicU64::new(0),
        })
    }

    /// The current snapshot. Lock-free; hold it for the whole request.
    pub fn load(&self) -> Arc<GatewaySnapshot> {
        self.current.load_full()
    }

    /// Replaces the snapshot wholesale.
    pub fn store(&self, next: GatewaySnapshot) {
        self.current.store(Arc::new(next));
        self.generation.fetch_add(1, Ordering::AcqRel);
    }

    /// How many wholesale replacements have happened since boot.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Re-reads the store and swaps the result in. Blocking: call it from
    /// the refresher or `spawn_blocking`, never on a request task.
    pub fn rebuild(&self, store: &SqliteStore) -> Result<(), StoreError> {
        let next = read_snapshot(store, &self.key, now_ms())?;
        self.store(next);
        Ok(())
    }

    /// `healthSaved`: this process's own health write, patched into the
    /// held snapshot so routing sees it before the next rebuild.
    pub fn patch_health(&self, row: CredentialHealth) {
        self.current.rcu(|cur| {
            let mut next = GatewaySnapshot::clone(cur);
            next.routing.health.insert(
                omni_router::health_key(&row.credential_id, &row.model),
                row.clone(),
            );
            next
        });
    }

    /// The one read a snapshot miss (a brand-new key) falls back to. A key
    /// found is added to the snapshot, so the next request does not read.
    /// Blocking, and unguarded: the request path goes through
    /// [`crate::miss::MissResolver`], which caches negatives, coalesces and
    /// budgets these reads.
    pub fn lookup_miss(
        &self,
        store: &SqliteStore,
        hash: &str,
    ) -> Result<Option<Arc<ApiKey>>, StoreError> {
        let Some(found) = store.find_api_key_by_hash(hash)? else {
            return Ok(None);
        };
        let found = Arc::new(found);
        let added = found.clone();
        self.current.rcu(move |cur| {
            let mut next = GatewaySnapshot::clone(cur);
            next.keys_by_hash.insert(added.hash.clone(), added.clone());
            next
        });
        Ok(Some(found))
    }

    /// Polls `PRAGMA data_version` every `interval` and rebuilds when it
    /// moves. `store` must be the connection [`Self::build`] read from:
    /// `data_version` is per connection. The store connection is owned by the task; all its I/O runs
    /// in `spawn_blocking`. A failed poll or rebuild keeps serving the last
    /// snapshot and is logged; the next tick tries again. Abort the handle
    /// to stop it.
    pub fn spawn_refresher(
        self: Arc<Self>,
        store: SqliteStore,
        interval: Duration,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let store = Arc::new(std::sync::Mutex::new(store));
            let mut version = self.boot_version;
            let mut ticker = tokio::time::interval(interval);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let holder = self.clone();
                let store = store.clone();
                let seen = version;
                let polled = tokio::task::spawn_blocking(move || {
                    let store = store
                        .lock()
                        .map_err(|_| "store mutex poisoned".to_owned())?;
                    let now = store.data_version().map_err(|e| e.to_string())?;
                    if now != seen {
                        holder.rebuild(&store).map_err(|e| e.to_string())?;
                    }
                    Ok::<i64, String>(now)
                })
                .await;
                match polled {
                    Ok(Ok(v)) => version = v,
                    Ok(Err(e)) => tracing::warn!(error = %e, "routing snapshot refresh failed"),
                    Err(e) => tracing::warn!(error = %e, "routing snapshot refresh task failed"),
                }
            }
        })
    }
}

pub use crate::miss::{MissConfig, MissResolver, MissResult};
