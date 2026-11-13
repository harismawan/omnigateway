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
use omni_store::keys::KeyRowError;
use omni_store::{ApiKey, CredentialHealth, LimitConfig, SqliteStore, StoreError};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// One key in the snapshot: readable, or a row TS's `toKey` throws on,
/// which is refused at auth with that error and nothing else.
pub type KeyEntry = Result<Arc<ApiKey>, Arc<KeyRowError>>;

/// One consistent view: keys and routing read in one transaction.
#[derive(Debug, Clone)]
pub struct GatewaySnapshot {
    /// Keyed by `api_keys.hash` (sha256 hex of the raw key).
    pub keys_by_hash: HashMap<String, KeyEntry>,
    pub routing: Snapshot,
}

impl GatewaySnapshot {
    /// The readable keys.
    pub fn keys(&self) -> impl Iterator<Item = &Arc<ApiKey>> {
        self.keys_by_hash.values().filter_map(|e| e.as_ref().ok())
    }
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
fn judge(entry: Option<&KeyEntry>, now_ms: i64) -> Result<AuthenticatedKey, GatewayError> {
    // `findByHash` throws for a row `toKey` cannot read, before any other
    // check: the proxy answers it as `INTERNAL` with the thrown message.
    let key = match entry {
        Some(Err(unreadable)) => {
            return Err(
                GatewayError::new(ErrorCode::Internal, unreadable.message.clone())
                    .gateway_authored(),
            );
        }
        Some(Ok(key)) => Some(key),
        None => None,
    };
    // `toKey` logs this on every read of the row, usable or not, before
    // `authenticateApiKey` judges it.
    if let Some(k) = key
        && k.limits.is_none()
    {
        tracing::error!(apiKeyId = %k.id, "api key limits unreadable");
    }
    let Some(key) = key.filter(|k| k.usable(now_ms)) else {
        return Err(auth("invalid API key"));
    };
    match &key.limits {
        Some(limits) => Ok(AuthenticatedKey {
            key: key.clone(),
            limits: limits.clone(),
        }),
        None => {
            tracing::error!(apiKeyId = %key.id, "api key refused: limits unreadable");
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
    writers: std::sync::Mutex<()>,
    // Lock order: authoritative W, then short publication P. Health takes P only.
    publication: std::sync::Mutex<()>,
    jobs: AtomicU64,
    jobs_done: tokio::sync::Notify,
    current: ArcSwap<GatewaySnapshot>,
    key: FieldKey,
    /// `data_version` read just before the boot read, on the connection
    /// the refresher is then handed. Anything committed after it is a move.
    boot_version: i64,
    /// Bumped by every wholesale replacement (each rebuild), so a negative
    /// key lookup recorded before it is known to be stale.
    generation: AtomicU64,
}

struct PublicationJob(Arc<SnapshotHolder>);
impl Drop for PublicationJob {
    fn drop(&mut self) {
        if self.0.jobs.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.jobs_done.notify_waiters();
        }
    }
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
        .map(|k| match k {
            Ok(k) => (k.hash.clone(), Ok(Arc::new(k))),
            Err(e) => {
                tracing::debug!(apiKeyId = %e.id, reason = %e.message,
                    "api key unreadable; refused at auth until repaired");
                (e.hash.clone(), Err(Arc::new(e)))
            }
        })
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
            writers: std::sync::Mutex::new(()),
            publication: std::sync::Mutex::new(()),
            jobs: AtomicU64::new(0),
            jobs_done: tokio::sync::Notify::new(),
            current: ArcSwap::from_pointee(first),
            key,
            boot_version,
            generation: AtomicU64::new(0),
        })
    }

    fn publication_job(self: &Arc<Self>) -> PublicationJob {
        self.jobs.fetch_add(1, Ordering::AcqRel);
        PublicationJob(self.clone())
    }

    /// After stopping producers, wait for even cancelled callers' blocking jobs.
    /// The caller applies its existing shutdown grace deadline.
    pub async fn drain_publications(&self) {
        loop {
            let notified = self.jobs_done.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.jobs.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }

    /// The current snapshot. Lock-free; hold it for the whole request.
    pub fn load(&self) -> Arc<GatewaySnapshot> {
        self.current.load_full()
    }

    /// How many wholesale replacements have happened since boot.
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Re-reads the store and swaps the result in. Blocking: call it from
    /// the refresher or `spawn_blocking`, never on a request task.
    pub fn rebuild(&self, store: &SqliteStore) -> Result<(), StoreError> {
        self.rebuild_read(|| read_snapshot(store, &self.key, now_ms()))
    }

    fn rebuild_read(
        &self,
        read: impl FnOnce() -> Result<GatewaySnapshot, StoreError>,
    ) -> Result<(), StoreError> {
        let _writer = self
            .writers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let next = read()?;
        let _publication = self
            .publication
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.current.store(Arc::new(next));
        self.generation.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }

    /// `healthSaved`: this process's own health write, patched into the
    /// held snapshot so routing sees it before the next rebuild.
    pub fn patch_health(&self, row: CredentialHealth) {
        let _publication = self
            .publication
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let cur = self.current.load_full();
        let mut next = GatewaySnapshot::clone(&cur);
        next.routing.health.insert(
            omni_router::health_key(&row.credential_id, &row.model),
            row.clone(),
        );
        self.current.store(Arc::new(next));
    }

    /// Read and publish under the authoritative writer lock. The callback must
    /// begin a fresh database read, not return a previously captured row.
    /// Blocking only: never call on an async worker.
    fn patch_credential(
        &self,
        id: &str,
        read: impl FnOnce() -> Result<Option<omni_store::Credential>, StoreError>,
    ) -> Result<(), StoreError> {
        self.patch_credential_at_publish(id, read, || {})
    }

    fn patch_credential_at_publish(
        &self,
        id: &str,
        read: impl FnOnce() -> Result<Option<omni_store::Credential>, StoreError>,
        mut before_store: impl FnMut(),
    ) -> Result<(), StoreError> {
        let _writer = self
            .writers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let row = read()?;
        let _publication = self
            .publication
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let cur = self.current.load_full();
        let mut next = GatewaySnapshot::clone(&cur);
        if let Some(row) = &row {
            if let Some(current) = next.routing.credentials.iter_mut().find(|c| c.id == id) {
                *current = row.clone();
            }
        } else {
            next.routing.credentials.retain(|c| c.id != id);
        }
        before_store();
        self.current.store(Arc::new(next));
        Ok(())
    }

    /// Adapter for the async backend. W is acquired only on the blocking pool;
    /// the backend read starts after acquisition and completes before publish.
    pub async fn refresh_credential(
        self: &Arc<Self>,
        store: Arc<omni_store::Store>,
        id: String,
    ) -> Result<(), StoreError> {
        let holder = self.clone();
        let runtime = tokio::runtime::Handle::current();
        let job = self.publication_job();
        tokio::task::spawn_blocking(move || {
            let _job = job;
            holder.patch_credential(&id, || match store.as_ref() {
                omni_store::Store::Sqlite { store, .. } => {
                    let db = store
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let tx = db.connection().unchecked_transaction()?;
                    let row = omni_store::credentials::get(&tx, &holder.key, &id)?;
                    tx.commit()?;
                    Ok(row)
                }
                omni_store::Store::Postgres(_) => {
                    runtime.block_on(store.credential(&holder.key, &id))
                }
            })
        })
        .await
        .map_err(|e| StoreError::Writer(format!("snapshot task: {e}")))?
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
    ) -> Result<Option<KeyEntry>, StoreError> {
        self.lookup_miss_after_read(store, hash, || {})
    }

    fn lookup_miss_after_read(
        &self,
        store: &SqliteStore,
        hash: &str,
        after_read: impl FnOnce(),
    ) -> Result<Option<KeyEntry>, StoreError> {
        let observed = self.current.load_full();
        let Some(found) = store.find_api_key_entry(hash)? else {
            return Ok(None);
        };
        after_read();
        let found: KeyEntry = match found {
            Ok(k) => Ok(Arc::new(k)),
            Err(e) => Err(Arc::new(e)),
        };
        let _publication = self
            .publication
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let current = self.current.load_full();
        if !Arc::ptr_eq(&current, &observed) {
            return Ok(current.keys_by_hash.get(hash).cloned());
        }
        let mut next = GatewaySnapshot::clone(&observed);
        next.keys_by_hash.insert(hash.to_owned(), found.clone());
        // The exact snapshot read before the database lookup must still be
        // current at publication. A separate generation check would race.
        self.current.store(Arc::new(next));
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
                let job = self.publication_job();
                let polled = tokio::task::spawn_blocking(move || {
                    let _job = job;
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
                    Ok(Err(e)) => tracing::warn!(reason = %e, "routing snapshot refresh failed"),
                    Err(e) => tracing::warn!(reason = %e, "routing snapshot refresh task failed"),
                }
            }
        })
    }
}

pub use crate::miss::{MissConfig, MissResolver, MissResult};

#[cfg(test)]
mod publication_tests {
    use super::*;

    #[test]
    #[allow(clippy::unwrap_used)]
    fn queued_health_and_rebuild_complete_after_one_credential_publication() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("queued.db");
        let db = SqliteStore::open(&path, 0).unwrap();
        let holder = SnapshotHolder::build(&db, omni_crypto::field::derive_key("k"), 0.0).unwrap();
        let (loaded_tx, loaded_rx) = std::sync::mpsc::sync_channel(0);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
        std::thread::scope(|scope| {
            let holder = &holder;
            let patch = scope.spawn(move || {
                holder
                    .patch_credential_at_publish(
                        "c",
                        || Ok(None),
                        || {
                            loaded_tx.send(()).unwrap();
                            release_rx.recv().unwrap();
                        },
                    )
                    .unwrap()
            });
            loaded_rx.recv().unwrap();
            assert!(holder.writers.try_lock().is_err());
            assert!(holder.publication.try_lock().is_err());
            db.connection().execute("INSERT INTO api_keys (id,label,prefix,hash,created_at,limits) VALUES ('k','k','k','admin',0,'{}')", []).unwrap();
            let rebuild = scope.spawn(|| {
                let db = SqliteStore::open(&path, 0).unwrap();
                holder.rebuild(&db).unwrap();
            });
            let health = scope.spawn(|| {
                holder.patch_health(CredentialHealth {
                    credential_id: "c".into(),
                    model: "m".into(),
                    breaker_state: omni_store::BreakerState::Closed,
                    consecutive_failures: 7,
                    opened_at: None,
                    rate_limited_until: None,
                })
            });
            release_tx.send(()).unwrap();
            patch.join().unwrap();
            health.join().unwrap();
            rebuild.join().unwrap();
        });
        assert!(holder.load().keys_by_hash.contains_key("admin"));
        // Rebuild may overwrite health, by policy; credential patches may not.
        holder.patch_health(CredentialHealth {
            credential_id: "c".into(),
            model: "m".into(),
            breaker_state: omni_store::BreakerState::Closed,
            consecutive_failures: 9,
            opened_at: None,
            rate_limited_until: None,
        });
        holder.patch_credential("c", || Ok(None)).unwrap();
        assert_eq!(
            holder.load().routing.health[&omni_router::health_key("c", "m")].consecutive_failures,
            9
        );
    }

    #[tokio::test]
    #[allow(clippy::unwrap_used)]
    async fn cancelled_waiter_publication_remains_in_shutdown_drain() {
        let dir = tempfile::tempdir().unwrap();
        let db = SqliteStore::open(dir.path().join("drain.db"), 0).unwrap();
        let holder =
            Arc::new(SnapshotHolder::build(&db, omni_crypto::field::derive_key("k"), 0.0).unwrap());
        let job = holder.publication_job();
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
        let task = tokio::task::spawn_blocking(move || {
            let _job = job;
            release_rx.recv().unwrap();
        });
        drop(task); // Same cancellation semantics as a dropped request waiter.
        let drain = holder.drain_publications();
        tokio::pin!(drain);
        std::future::poll_fn(|cx| {
            use std::future::Future;
            assert!(drain.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        release_tx.send(()).unwrap();
        drain.await;
        assert_eq!(holder.jobs.load(Ordering::Acquire), 0);
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn credential_publication_cannot_retry_behind_health() {
        let dir = tempfile::tempdir().unwrap();
        let db = SqliteStore::open(dir.path().join("bounded.db"), 0).unwrap();
        let holder = SnapshotHolder::build(&db, omni_crypto::field::derive_key("k"), 0.0).unwrap();
        let health = CredentialHealth {
            credential_id: "c".into(),
            model: "m".into(),
            breaker_state: omni_store::BreakerState::Closed,
            consecutive_failures: 7,
            opened_at: None,
            rate_limited_until: None,
        };
        let mut attempts = 0;
        holder
            .patch_credential_at_publish(
                "c",
                || Ok(None),
                || {
                    attempts += 1;
                    assert_eq!(
                        attempts, 1,
                        "health forced a second publication attempt while W remained held"
                    );
                    // Inject the reviewer's conflict whenever publication is unprotected.
                    // Under P this interleaving is impossible; health must queue instead.
                    if holder.publication.try_lock().is_ok() {
                        holder.patch_health(health.clone());
                    }
                },
            )
            .unwrap();
        holder.patch_health(health);
        holder.patch_credential("c", || Ok(None)).unwrap();
        assert_eq!(
            holder.load().routing.health[&omni_router::health_key("c", "m")].consecutive_failures,
            7
        );
        holder.rebuild(&db).unwrap();
        assert_eq!(holder.generation(), 1);
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn authoritative_sections_serialize_read_and_publish_in_both_orders() {
        for patch_first in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("ordering.db");
            let db = SqliteStore::open(&path, 0).unwrap();
            db.connection().execute("INSERT INTO credentials (id,provider,label,auth_type,enabled,tier,weight,provider_data,created_at,updated_at) VALUES ('c','anthropic','old','oauth',0,1,1,'{}',0,0)", []).unwrap();
            let key = omni_crypto::field::derive_key("k");
            let holder = SnapshotHolder::build(&db, key.clone(), 0.0).unwrap();
            let (read_tx, read_rx) = std::sync::mpsc::sync_channel(0);
            let (release_tx, release_rx) = std::sync::mpsc::sync_channel(0);
            std::thread::scope(|s| {
                let holder = &holder;
                let key = &key;
                let path = &path;
                s.spawn(move || {
                    let db = SqliteStore::open(path, 0).unwrap();
                    if patch_first {
                        holder
                            .patch_credential("c", || {
                                let row = omni_store::credentials::get(db.connection(), key, "c")?;
                                read_tx.send(()).unwrap();
                                release_rx.recv().unwrap();
                                Ok(row)
                            })
                            .unwrap();
                    } else {
                        holder
                            .rebuild_read(|| {
                                let next = read_snapshot(&db, key, 0.0)?;
                                read_tx.send(()).unwrap();
                                release_rx.recv().unwrap();
                                Ok(next)
                            })
                            .unwrap();
                    }
                });
                read_rx.recv().unwrap();
                // The first section has captured disabled/old; the second
                // must read the administrative edit only after it publishes.
                db.connection()
                    .execute(
                        "UPDATE credentials SET enabled=1,label='admin',weight=19,token_version=2",
                        [],
                    )
                    .unwrap();
                assert!(holder.writers.try_lock().is_err());
                let second = s.spawn(move || {
                    let db = SqliteStore::open(path, 0).unwrap();
                    if patch_first {
                        holder.rebuild(&db).unwrap();
                    } else {
                        holder
                            .patch_credential("c", || {
                                omni_store::credentials::get(db.connection(), key, "c")
                            })
                            .unwrap();
                    }
                });
                release_tx.send(()).unwrap();
                second.join().unwrap();
            });
            let current = holder.load();
            let row = &current.routing.credentials[0];
            assert!(row.enabled);
            assert_eq!(row.label, "admin");
            assert_eq!(row.weight, 19.0);
            assert_eq!(row.token_version, 2);
        }
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn health_traffic_does_not_repeat_or_block_authoritative_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("health.db");
        let store = SqliteStore::open(&path, 0).unwrap();
        let key = omni_crypto::field::derive_key("k");
        let holder = SnapshotHolder::build(&store, key.clone(), 0.0).unwrap();
        store.connection().execute("INSERT INTO api_keys (id,label,prefix,hash,created_at,limits) VALUES ('k','k','k','h',0,'{}')", []).unwrap();
        let (read_tx, read_rx) = std::sync::mpsc::sync_channel(0);
        let (done_tx, done_rx) = std::sync::mpsc::sync_channel(0);
        std::thread::scope(|s| {
            let holder = &holder;
            s.spawn(move || {
                read_rx.recv().unwrap();
                for n in 0..32 {
                    holder.patch_health(CredentialHealth {
                        credential_id: "c".into(),
                        model: "m".into(),
                        breaker_state: omni_store::BreakerState::Closed,
                        consecutive_failures: n,
                        opened_at: None,
                        rate_limited_until: None,
                    });
                }
                done_tx.send(()).unwrap();
            });
            let mut reads = 0;
            holder
                .rebuild_read(|| {
                    reads += 1;
                    let next = read_snapshot(&store, &key, 0.0)?;
                    read_tx.send(()).unwrap();
                    done_rx.recv().unwrap();
                    Ok(next)
                })
                .unwrap();
            assert_eq!(reads, 1);
        });
        assert!(holder.load().keys_by_hash.contains_key("h"));
    }

    #[test]
    #[allow(clippy::unwrap_used)] // Isolated database fixture setup.
    fn delayed_positive_read_cannot_replace_revoke_delete_or_restriction() {
        for mutation in [
            "UPDATE api_keys SET revoked_at=1",
            "DELETE FROM api_keys",
            "UPDATE api_keys SET limits='{\"requests\":{\"1m\":1}}'",
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("test.db");
            let store = SqliteStore::open(&path, 0).unwrap();
            let holder =
                SnapshotHolder::build(&store, omni_crypto::field::derive_key("k"), 0.0).unwrap();
            let db = rusqlite::Connection::open(&path).unwrap();
            db.execute("INSERT INTO api_keys (id,label,prefix,hash,created_at,limits) VALUES ('k','k','k','h',0,'{}')", []).unwrap();
            let result = holder
                .lookup_miss_after_read(&store, "h", || {
                    db.execute(mutation, []).unwrap();
                    holder.rebuild(&store).unwrap();
                })
                .unwrap();
            let expected = store.find_api_key_entry("h").unwrap();
            let entry = |e: Option<&KeyEntry>| {
                e.map(|e| e.clone().map(|k| (*k).clone()).map_err(|e| (*e).clone()))
            };
            // No subsequent database write or refresh may be needed to heal.
            assert_eq!(entry(result.as_ref()), expected);
            assert_eq!(entry(holder.load().keys_by_hash.get("h")), expected);
        }
    }
}
