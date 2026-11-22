//! The gateway's session authority over a session KV.
//!
//! Sessions for three principals — the operator (`admin`), the read-only
//! administrator (`viewer`) and the holder of one API key (`client`) — live
//! behind [`SessionKv`]: `sess:<kind>:<sha256hex(token)>`
//! holding `{"expiresAt":<ms>,"principal":{…}}` with the session TTL. Single
//! node uses [`MemoryKv`], a map a restart empties; cluster mode uses
//! [`CoordKv`], the coordinator's `kv` (`omni:kv:sess:…` in Redis), over the
//! same key schema and JSON.
//!
//! Password checks and hashing are Argon2id (`omni_crypto::password`), run on
//! the blocking pool and bounded to one per CPU. Store reads and writes go
//! through the gateway's own connection, also off the async workers.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use omni_control::admin_password::{self, Which};
use omni_store::{SqliteStore, StoreError};

/// `ADMIN_COOKIE`.
pub const ADMIN_COOKIE: &str = "omni_admin";
/// The session TTL: 12 hours.
pub const SESSION_TTL_MS: i64 = 12 * 60 * 60 * 1000;

/// The session principal. A fourth kind, `machine`, belongs to a plugin
/// capability that is unsupported here; a stored session naming
/// it reads as no session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Principal {
    Admin,
    Viewer,
    Client { api_key_id: String },
}

/// The principal's `kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Admin,
    Viewer,
    Client,
}

impl Kind {
    /// `lookup`'s order.
    pub const ALL: [Kind; 3] = [Kind::Admin, Kind::Viewer, Kind::Client];

    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Admin => "admin",
            Kind::Viewer => "viewer",
            Kind::Client => "client",
        }
    }
}

impl Principal {
    pub fn kind(&self) -> Kind {
        match self {
            Principal::Admin => Kind::Admin,
            Principal::Viewer => Kind::Viewer,
            Principal::Client { .. } => Kind::Client,
        }
    }

    /// The stored principal JSON; the key order is part of the format.
    pub fn to_json(&self) -> String {
        match self {
            Principal::Admin => r#"{"kind":"admin"}"#.to_owned(),
            Principal::Viewer => r#"{"kind":"viewer"}"#.to_owned(),
            Principal::Client { api_key_id } => {
                let mut out = String::from(r#"{"kind":"client","apiKeyId":"#);
                omni_ir::jsjson::write_str(api_key_id, &mut out);
                out.push('}');
                out
            }
        }
    }

    fn from_json(value: &serde_json::Value) -> Option<Self> {
        match value.get("kind")?.as_str()? {
            "admin" => Some(Principal::Admin),
            "viewer" => Some(Principal::Viewer),
            "client" => Some(Principal::Client {
                api_key_id: value.get("apiKeyId")?.as_str()?.to_owned(),
            }),
            _ => None,
        }
    }
}

/// A session record as stored: `{"expiresAt":<ms>,"principal":{…}}`.
fn session_json(expires_at: i64, principal: &Principal) -> String {
    format!(
        r#"{{"expiresAt":{expires_at},"principal":{}}}"#,
        principal.to_json()
    )
}

fn parse_session(raw: &str) -> Option<(f64, Principal)> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    Some((
        v.get("expiresAt")?.as_f64()?,
        Principal::from_json(v.get("principal")?)?,
    ))
}

// ------------------------------------------------------------ session KV

/// A KV failure (a coordinator outage, for a networked one).
#[derive(Debug, thiserror::Error)]
#[error("session store: {0}")]
pub struct KvError(pub String);

pub type KvFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, KvError>> + Send + 'a>>;

/// `Coord["kv"]`: string values with a TTL, deletion by key and by prefix.
/// A value read at or past its expiry is absent (and gone).
pub trait SessionKv: Send + Sync {
    fn set<'a>(&'a self, key: &'a str, value: &'a str, ttl_ms: i64) -> KvFuture<'a, ()>;
    fn get<'a>(&'a self, key: &'a str) -> KvFuture<'a, Option<String>>;
    fn del<'a>(&'a self, key: &'a str) -> KvFuture<'a, ()>;
    /// Every key under `prefix`.
    fn del_prefix<'a>(&'a self, prefix: &'a str) -> KvFuture<'a, ()>;
}

/// Same hashed session names, JSON values and TTLs through the selected Coord.
pub struct CoordKv {
    coord: Arc<dyn omni_coord::Coord>,
}

impl CoordKv {
    pub fn new(coord: Arc<dyn omni_coord::Coord>) -> Self {
        Self { coord }
    }
}

impl SessionKv for CoordKv {
    fn set<'a>(&'a self, key: &'a str, value: &'a str, ttl_ms: i64) -> KvFuture<'a, ()> {
        Box::pin(async move {
            let ttl = u64::try_from(ttl_ms).map_err(|_| KvError("invalid session TTL".into()))?;
            self.coord
                .kv_set(key, value, ttl)
                .await
                .map_err(|e| KvError(e.to_string()))
        })
    }
    fn get<'a>(&'a self, key: &'a str) -> KvFuture<'a, Option<String>> {
        Box::pin(async move {
            self.coord
                .kv_get(key)
                .await
                .map_err(|e| KvError(e.to_string()))
        })
    }
    fn del<'a>(&'a self, key: &'a str) -> KvFuture<'a, ()> {
        Box::pin(async move {
            self.coord
                .kv_del(key)
                .await
                .map_err(|e| KvError(e.to_string()))
        })
    }
    fn del_prefix<'a>(&'a self, prefix: &'a str) -> KvFuture<'a, ()> {
        Box::pin(async move {
            self.coord
                .kv_del_prefix(prefix)
                .await
                .map_err(|e| KvError(e.to_string()))
        })
    }
}

pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The in-process session KV, expiring against the injected clock.
///
/// An expired entry is forgotten when read; this also sweeps
/// expired entries when the map has doubled since its last sweep, so
/// sessions nobody returns to cannot accumulate. Not observable otherwise.
pub struct MemoryKv {
    now: Clock,
    inner: Mutex<MemoryInner>,
}

#[derive(Default)]
struct MemoryInner {
    values: HashMap<String, (String, i64)>,
    swept_len: usize,
}

impl MemoryKv {
    pub fn new(now: Clock) -> Self {
        Self {
            now,
            inner: Mutex::new(MemoryInner::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, MemoryInner> {
        // Every critical section leaves the map consistent.
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Live entries, for tests.
    pub fn len(&self) -> usize {
        self.lock().values.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl std::fmt::Debug for MemoryKv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemoryKv").finish_non_exhaustive()
    }
}

impl SessionKv for MemoryKv {
    fn set<'a>(&'a self, key: &'a str, value: &'a str, ttl_ms: i64) -> KvFuture<'a, ()> {
        let now = (self.now)();
        let mut inner = self.lock();
        inner.values.insert(
            key.to_owned(),
            (value.to_owned(), now.saturating_add(ttl_ms)),
        );
        if inner.values.len() >= 64 && inner.values.len() >= inner.swept_len.saturating_mul(2) {
            inner.values.retain(|_, (_, at)| *at > now);
            inner.swept_len = inner.values.len();
        }
        drop(inner);
        Box::pin(std::future::ready(Ok(())))
    }

    fn get<'a>(&'a self, key: &'a str) -> KvFuture<'a, Option<String>> {
        let now = (self.now)();
        let mut inner = self.lock();
        let out = match inner.values.get(key) {
            None => None,
            Some((_, at)) if *at <= now => {
                inner.values.remove(key);
                None
            }
            Some((value, _)) => Some(value.clone()),
        };
        drop(inner);
        Box::pin(std::future::ready(Ok(out)))
    }

    fn del<'a>(&'a self, key: &'a str) -> KvFuture<'a, ()> {
        self.lock().values.remove(key);
        Box::pin(std::future::ready(Ok(())))
    }

    fn del_prefix<'a>(&'a self, prefix: &'a str) -> KvFuture<'a, ()> {
        self.lock().values.retain(|k, _| !k.starts_with(prefix));
        Box::pin(std::future::ready(Ok(())))
    }
}

// ------------------------------------------------------------ the authority

/// Why an auth operation failed.
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    /// A refused password (the length rule): the routes report the
    /// message as `BAD_REQUEST`.
    #[error("{0}")]
    Password(String),
    /// Anything else: most routes report `INTERNAL "internal error"`;
    /// `/api/setup` reports the message as `BAD_REQUEST`.
    #[error("{0}")]
    Internal(String),
}

impl From<StoreError> for AuthError {
    fn from(e: StoreError) -> Self {
        AuthError::Internal(describe_store_error(&e))
    }
}

/// The store failure's description: SQLite's own message (`sqlite3_errmsg`),
/// or the name `SQLiteError` when that message is empty. Never the SQL, a
/// bound parameter or the database path: SQLite's messages carry none of them.
fn describe_store_error(e: &StoreError) -> String {
    match e {
        StoreError::Sqlite(rusqlite::Error::SqliteFailure(_, Some(m))) if m.is_empty() => {
            "SQLiteError".to_owned()
        }
        StoreError::Sqlite(rusqlite::Error::SqliteFailure(code, None)) => {
            rusqlite::ffi::code_to_str(code.extended_code).to_owned()
        }
        other => other.to_string(),
    }
}

impl From<KvError> for AuthError {
    fn from(e: KvError) -> Self {
        AuthError::Internal(e.to_string())
    }
}

impl From<admin_password::PasswordError> for AuthError {
    fn from(e: admin_password::PasswordError) -> Self {
        match e {
            admin_password::PasswordError::TooShort(_) => AuthError::Password(e.to_string()),
            other => AuthError::Internal(other.to_string()),
        }
    }
}

/// `AdminAuth`.
pub struct AdminAuth {
    store: AuthStore,
    kv: Arc<dyn SessionKv>,
    now: Clock,
    ttl_ms: i64,
    /// Running Argon2 jobs (19 MiB each), one per CPU; see [`Self::hashing`].
    hashing: Arc<tokio::sync::Semaphore>,
}

#[derive(Clone)]
enum AuthStore {
    Sqlite(Arc<Mutex<SqliteStore>>),
    Backend(Arc<omni_store::Store>),
}

impl std::fmt::Debug for AdminAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AdminAuth")
            .field("ttl_ms", &self.ttl_ms)
            .finish_non_exhaustive()
    }
}

impl AdminAuth {
    pub fn new(store: SqliteStore, kv: Arc<dyn SessionKv>, now: Clock, ttl_ms: i64) -> Self {
        Self::with_backend(
            AuthStore::Sqlite(omni_store::lifecycle::shared(store)),
            kv,
            now,
            ttl_ms,
        )
    }

    pub fn from_backend(
        store: Arc<omni_store::Store>,
        kv: Arc<dyn SessionKv>,
        now: Clock,
        ttl_ms: i64,
    ) -> Self {
        Self::with_backend(AuthStore::Backend(store), kv, now, ttl_ms)
    }

    fn with_backend(store: AuthStore, kv: Arc<dyn SessionKv>, now: Clock, ttl_ms: i64) -> Self {
        let cpus = std::thread::available_parallelism().map_or(1, std::num::NonZero::get);
        Self {
            store,
            kv,
            now,
            ttl_ms,
            hashing: Arc::new(tokio::sync::Semaphore::new(cpus)),
        }
    }

    /// Replaces the hashing bound (tests).
    #[cfg(test)]
    pub(crate) fn set_hashing_permits(&mut self, permits: usize) {
        self.hashing = Arc::new(tokio::sync::Semaphore::new(permits));
    }

    /// Hashing permits not held by a running job (tests).
    #[cfg(test)]
    pub(crate) fn idle_hashing_permits(&self) -> usize {
        self.hashing.available_permits()
    }

    /// The session TTL in whole seconds: the cookie's `Max-Age`.
    pub fn max_age_secs(&self) -> i64 {
        self.ttl_ms.div_euclid(1000)
    }

    /// One store operation on the blocking pool.
    async fn with_store<T: Send + 'static>(
        &self,
        f: impl FnOnce(&SqliteStore) -> Result<T, AuthError> + Send + 'static,
    ) -> Result<T, AuthError> {
        let store = self.store.clone();
        let AuthStore::Sqlite(store) = store else {
            return Err(AuthError::Internal(
                "SQLite-only auth operation on PG".into(),
            ));
        };
        tokio::task::spawn_blocking(move || {
            let _runtime_access = omni_store::lifecycle::access();
            let guard = store
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            f(&guard)
        })
        .await
        .map_err(|e| AuthError::Internal(e.to_string()))?
    }

    async fn password_hash(&self, which: Which) -> Result<Option<String>, AuthError> {
        match &self.store {
            AuthStore::Backend(store) => Ok(store
                .password_hash(match which {
                    Which::Admin => admin_password::ADMIN_HASH_KEY,
                    Which::Viewer => admin_password::VIEWER_HASH_KEY,
                })
                .await?),
            AuthStore::Sqlite(_) => {
                self.with_store(move |s| {
                    Ok(match which {
                        Which::Admin => admin_password::admin_hash(s)?,
                        Which::Viewer => admin_password::viewer_hash(s)?,
                    })
                })
                .await
            }
        }
    }

    /// CPU-heavy work (Argon2) on the blocking pool, at most one job per
    /// permit *running*. The permit is owned by the blocking closure and
    /// released when it exits: a caller that stops waiting (a client hanging
    /// up mid-login) cannot free a slot while its job still runs, since
    /// `spawn_blocking` work is not cancelled with the future awaiting it.
    async fn hashing<T: Send + 'static>(
        &self,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, AuthError> {
        let permit = self
            .hashing
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| AuthError::Internal(e.to_string()))?;
        tokio::task::spawn_blocking(move || {
            let _runtime_access = omni_store::lifecycle::access();
            let _permit = permit;
            f()
        })
        .await
        .map_err(|e| AuthError::Internal(e.to_string()))
    }

    /// Verifies a password against the stored hash.
    async fn matches(&self, stored: Option<String>, password: &str) -> Result<bool, AuthError> {
        if stored.is_none() {
            return Ok(false);
        }
        let password = password.to_owned();
        self.hashing(move || omni_crypto::password::verify(stored.as_deref(), &password))
            .await
    }

    async fn hash_new(&self, which: Which, password: &str) -> Result<String, AuthError> {
        admin_password::check_length(which, password)?;
        let password = password.to_owned();
        Ok(self
            .hashing(move || admin_password::hash_new(which, &password))
            .await??)
    }

    /// `issue(principal)`: a fresh token, stored under its digest.
    async fn issue(&self, principal: &Principal) -> Result<String, AuthError> {
        let token = omni_crypto::session::token();
        let expires_at = (self.now)().saturating_add(self.ttl_ms);
        self.kv
            .set(
                &omni_crypto::session::key(principal.kind().as_str(), &token),
                &session_json(expires_at, principal),
                self.ttl_ms,
            )
            .await?;
        Ok(token)
    }

    /// `lookup(token)`: the session under each kind in turn.
    async fn lookup(&self, token: &str) -> Result<Option<(String, String)>, AuthError> {
        for kind in Kind::ALL {
            let key = omni_crypto::session::key(kind.as_str(), token);
            if let Some(raw) = self.kv.get(&key).await? {
                return Ok(Some((key, raw)));
            }
        }
        Ok(None)
    }

    /// Whether an admin password is set.
    pub async fn is_configured(&self) -> Result<bool, AuthError> {
        Ok(self.password_hash(Which::Admin).await?.is_some())
    }

    /// Whether a viewer password is set.
    pub async fn is_viewer_configured(&self) -> Result<bool, AuthError> {
        Ok(self.password_hash(Which::Viewer).await?.is_some())
    }

    /// Whether this call created the admin password.
    pub async fn set_initial_password(&self, password: &str) -> Result<bool, AuthError> {
        let hash = self.hash_new(Which::Admin, password).await?;
        if let AuthStore::Backend(store) = &self.store {
            return Ok(store
                .password_hash_set_if_absent(admin_password::ADMIN_HASH_KEY, &hash)
                .await?);
        }
        self.with_store(move |s| Ok(admin_password::set_admin_hash_if_absent(s, &hash)?))
            .await
    }

    /// A new admin password, and every
    /// session of every kind ended.
    pub async fn set_password(&self, password: &str) -> Result<(), AuthError> {
        let hash = self.hash_new(Which::Admin, password).await?;
        if let AuthStore::Backend(store) = &self.store {
            store
                .password_hash_set(admin_password::ADMIN_HASH_KEY, Some(&hash))
                .await?;
        } else {
            self.with_store(move |s| Ok(admin_password::set_admin_hash(s, &hash)?))
                .await?;
        }
        self.kv.del_prefix(omni_crypto::session::PREFIX).await?;
        Ok(())
    }

    /// The length rule first (so a short new password
    /// answers the same whether `current` was right), then `current`.
    pub async fn change_password(&self, current: &str, next: &str) -> Result<bool, AuthError> {
        admin_password::check_length(Which::Admin, next)?;
        let stored = self.password_hash(Which::Admin).await?;
        if !self.matches(stored, current).await? {
            return Ok(false);
        }
        self.set_password(next).await?;
        Ok(true)
    }

    /// `login`: an admin session, or `None` for a wrong or unset password.
    pub async fn login(&self, password: &str) -> Result<Option<String>, AuthError> {
        let stored = self.password_hash(Which::Admin).await?;
        if !self.matches(stored, password).await? {
            return Ok(None);
        }
        Ok(Some(self.issue(&Principal::Admin).await?))
    }

    /// Sets or (with `None`) clears the read-only
    /// password, ending viewer sessions only.
    pub async fn set_viewer_password(&self, password: Option<&str>) -> Result<(), AuthError> {
        let hash = match password {
            None => None,
            Some(p) => Some(self.hash_new(Which::Viewer, p).await?),
        };
        if let AuthStore::Backend(store) = &self.store {
            store
                .password_hash_set(admin_password::VIEWER_HASH_KEY, hash.as_deref())
                .await?;
        } else {
            self.with_store(move |s| Ok(admin_password::set_viewer_hash(s, hash.as_deref())?))
                .await?;
        }
        self.invalidate_kind(Kind::Viewer).await
    }

    /// A viewer session, or `None` for a wrong or unset password.
    pub async fn login_viewer(&self, password: &str) -> Result<Option<String>, AuthError> {
        let stored = self.password_hash(Which::Viewer).await?;
        if !self.matches(stored, password).await? {
            return Ok(None);
        }
        Ok(Some(self.issue(&Principal::Viewer).await?))
    }

    /// A session for the holder of a usable raw API key.
    pub async fn login_client(&self, raw_key: &str) -> Result<Option<String>, AuthError> {
        let hash = omni_crypto::apikey::hash(raw_key);
        let now = (self.now)();
        if let AuthStore::Backend(store) = &self.store {
            return match store
                .find_api_key_by_hash(&hash)
                .await?
                .filter(|k| k.usable(now))
            {
                None => Ok(None),
                Some(key) => Ok(Some(
                    self.issue(&Principal::Client { api_key_id: key.id })
                        .await?,
                )),
            };
        }
        let id = self
            .with_store(move |s| {
                Ok(omni_store::keys::find_by_hash(s.connection(), &hash)?
                    .inspect(|k| {
                        if k.limits.is_none() {
                            tracing::error!(apiKeyId = %k.id, "api key limits unreadable");
                        }
                    })
                    .filter(|k| k.usable(now))
                    .map(|k| k.id))
            })
            .await?;
        match id {
            None => Ok(None),
            Some(api_key_id) => Ok(Some(self.issue(&Principal::Client { api_key_id }).await?)),
        }
    }

    /// `verify`: the principal behind a token, or `None`. An expired
    /// session, and a client session whose key is no longer usable, is
    /// deleted on the way.
    pub async fn verify(&self, token: &str) -> Result<Option<Principal>, AuthError> {
        let Some((key, raw)) = self.lookup(token).await? else {
            return Ok(None);
        };
        let Some((expires_at, principal)) = parse_session(&raw) else {
            return Ok(None);
        };
        #[allow(clippy::cast_precision_loss)]
        let now = (self.now)() as f64;
        if expires_at <= now {
            self.kv.del(&key).await?;
            return Ok(None);
        }
        if let Principal::Client { api_key_id } = &principal {
            let id = api_key_id.clone();
            #[allow(clippy::cast_possible_truncation)]
            let now = now as i64;
            let usable = if let AuthStore::Backend(store) = &self.store {
                store
                    .get_operator_key(&id)
                    .await?
                    .is_some_and(|key| key.usable(now))
            } else {
                self.with_store(move |s| Ok(admin_password::client_key_usable(s, &id, now)?))
                    .await?
            };
            if !usable {
                self.kv.del(&key).await?;
                return Ok(None);
            }
        }
        Ok(Some(principal))
    }

    /// `logout`.
    pub async fn logout(&self, token: &str) -> Result<(), AuthError> {
        if let Some((key, _)) = self.lookup(token).await? {
            self.kv.del(&key).await?;
        }
        Ok(())
    }

    /// Ends every session of every kind.
    pub async fn invalidate_sessions(&self) -> Result<(), AuthError> {
        Ok(self.kv.del_prefix(omni_crypto::session::PREFIX).await?)
    }

    /// Ends every session of one kind.
    pub async fn invalidate_kind(&self, kind: Kind) -> Result<(), AuthError> {
        Ok(self
            .kv
            .del_prefix(&omni_crypto::session::kind_prefix(kind.as_str()))
            .await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::time::Duration;

    struct Fixture {
        auth: AdminAuth,
        kv: Arc<MemoryKv>,
        clock: Arc<AtomicI64>,
        path: std::path::PathBuf,
        _dir: tempfile::TempDir,
    }

    fn fixture(ttl_ms: i64) -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("omni.db");
        let store = SqliteStore::open(&path, 0).expect("open");
        let clock = Arc::new(AtomicI64::new(1_000_000));
        let now: Clock = {
            let c = clock.clone();
            Arc::new(move || c.load(Ordering::SeqCst))
        };
        let kv = Arc::new(MemoryKv::new(now.clone()));
        Fixture {
            auth: AdminAuth::new(store, kv.clone(), now, ttl_ms),
            kv,
            clock,
            path,
            _dir: dir,
        }
    }

    const PW: &str = "correct-horse-battery";

    #[tokio::test]
    async fn configured_after_initial_password_and_initial_wins_once() {
        let f = fixture(60_000);
        assert!(!f.auth.is_configured().await.expect("read"));
        assert!(f.auth.set_initial_password(PW).await.expect("set"));
        assert!(f.auth.is_configured().await.expect("read"));
        assert!(
            !f.auth
                .set_initial_password("another-password")
                .await
                .expect("set")
        );
        assert!(
            f.auth
                .login("another-password")
                .await
                .expect("login")
                .is_none()
        );
        assert!(f.auth.login(PW).await.expect("login").is_some());
    }

    #[tokio::test]
    async fn short_password_is_the_ts_message() {
        let f = fixture(60_000);
        match f.auth.set_initial_password("short").await {
            Err(AuthError::Password(m)) => {
                assert_eq!(m, "admin password must be at least 12 characters");
            }
            other => panic!("{other:?}"),
        }
        assert!(!f.auth.is_configured().await.expect("read"));
    }

    #[tokio::test]
    async fn sessions_expire_at_their_ttl_and_are_deleted() {
        let f = fixture(60_000);
        f.auth.set_initial_password(PW).await.expect("set");
        let token = f.auth.login(PW).await.expect("login").expect("token");
        assert_eq!(token.len(), 43);
        assert_eq!(
            f.auth.verify(&token).await.expect("verify"),
            Some(Principal::Admin)
        );
        f.clock.fetch_add(59_999, Ordering::SeqCst);
        assert_eq!(
            f.auth.verify(&token).await.expect("verify"),
            Some(Principal::Admin)
        );
        f.clock.fetch_add(1, Ordering::SeqCst);
        assert_eq!(f.auth.verify(&token).await.expect("verify"), None);
        assert!(f.kv.is_empty());
    }

    #[tokio::test]
    async fn the_stored_record_is_the_ts_schema() {
        let f = fixture(60_000);
        f.auth.set_initial_password(PW).await.expect("set");
        let token = f.auth.login(PW).await.expect("login").expect("token");
        let key = omni_crypto::session::key("admin", &token);
        let raw = f.kv.get(&key).await.expect("get").expect("stored");
        assert_eq!(raw, r#"{"expiresAt":1060000,"principal":{"kind":"admin"}}"#);
    }

    #[tokio::test]
    async fn logout_ends_one_session_and_spares_concurrent_ones() {
        let f = fixture(60_000);
        f.auth.set_initial_password(PW).await.expect("set");
        let a = f.auth.login(PW).await.expect("login").expect("token");
        let b = f.auth.login(PW).await.expect("login").expect("token");
        assert_ne!(a, b);
        f.auth.logout(&a).await.expect("logout");
        assert_eq!(f.auth.verify(&a).await.expect("verify"), None);
        assert_eq!(
            f.auth.verify(&b).await.expect("verify"),
            Some(Principal::Admin)
        );
        f.auth.logout("unknown").await.expect("logout");
    }

    #[tokio::test]
    async fn viewer_password_is_independent_and_clearing_ends_viewers_only() {
        let f = fixture(60_000);
        f.auth.set_initial_password(PW).await.expect("set");
        assert!(!f.auth.is_viewer_configured().await.expect("read"));
        assert!(f.auth.login_viewer(PW).await.expect("login").is_none());
        f.auth
            .set_viewer_password(Some("viewer-password-1"))
            .await
            .expect("set");
        assert!(f.auth.is_viewer_configured().await.expect("read"));
        assert!(
            f.auth
                .login("viewer-password-1")
                .await
                .expect("login")
                .is_none()
        );
        let v = f
            .auth
            .login_viewer("viewer-password-1")
            .await
            .expect("login")
            .expect("token");
        let a = f.auth.login(PW).await.expect("login").expect("token");
        assert_eq!(
            f.auth.verify(&v).await.expect("verify"),
            Some(Principal::Viewer)
        );
        f.auth.set_viewer_password(None).await.expect("clear");
        assert!(!f.auth.is_viewer_configured().await.expect("read"));
        assert_eq!(f.auth.verify(&v).await.expect("verify"), None);
        assert_eq!(
            f.auth.verify(&a).await.expect("verify"),
            Some(Principal::Admin)
        );
        match f.auth.set_viewer_password(Some("short")).await {
            Err(AuthError::Password(m)) => {
                assert_eq!(m, "viewer password must be at least 12 characters");
            }
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn changing_the_admin_password_ends_every_session() {
        let f = fixture(60_000);
        f.auth.set_initial_password(PW).await.expect("set");
        f.auth
            .set_viewer_password(Some("viewer-password-1"))
            .await
            .expect("set");
        let a = f.auth.login(PW).await.expect("login").expect("token");
        let v = f
            .auth
            .login_viewer("viewer-password-1")
            .await
            .expect("login")
            .expect("token");
        seed_key(&f.path, "k1", "sk-omni-change-test");
        let c = f
            .auth
            .login_client("sk-omni-change-test")
            .await
            .expect("login")
            .expect("token");
        assert!(matches!(
            f.auth.change_password("wrong-password!", "short").await,
            Err(AuthError::Password(_))
        ));
        assert!(
            !f.auth
                .change_password("wrong-password!", "new-password-123")
                .await
                .expect("change")
        );
        assert_eq!(
            f.auth.verify(&a).await.expect("verify"),
            Some(Principal::Admin)
        );
        assert!(
            f.auth
                .change_password(PW, "new-password-123")
                .await
                .expect("change")
        );
        assert_eq!(f.auth.verify(&a).await.expect("verify"), None);
        assert_eq!(f.auth.verify(&v).await.expect("verify"), None);
        // The client's key is still usable: only the password change ended it.
        assert_eq!(f.auth.verify(&c).await.expect("verify"), None);
        assert!(f.kv.is_empty());
        assert!(
            f.auth
                .login("new-password-123")
                .await
                .expect("login")
                .is_some()
        );
    }

    fn seed_key(path: &std::path::Path, id: &str, raw: &str) {
        let c = rusqlite::Connection::open(path).expect("open");
        c.execute(
            "INSERT INTO api_keys (id, label, prefix, hash, limits, created_at) VALUES (?,'l',?,?,'{}',1)",
            rusqlite::params![id, omni_crypto::apikey::prefix(raw), omni_crypto::apikey::hash(raw)],
        )
        .expect("seed");
    }

    /// Setting or clearing the viewer password ends viewer sessions and
    /// leaves admin and client sessions alone.
    #[tokio::test]
    async fn viewer_password_changes_spare_admin_and_client_sessions() {
        let f = fixture(60_000);
        f.auth.set_initial_password(PW).await.expect("set");
        f.auth
            .set_viewer_password(Some("viewer-password-1"))
            .await
            .expect("set");
        seed_key(&f.path, "k1", "sk-omni-viewer-test");
        let a = f.auth.login(PW).await.expect("login").expect("token");
        let v = f
            .auth
            .login_viewer("viewer-password-1")
            .await
            .expect("login")
            .expect("token");
        let c = f
            .auth
            .login_client("sk-omni-viewer-test")
            .await
            .expect("login")
            .expect("token");
        f.auth
            .set_viewer_password(Some("viewer-password-2"))
            .await
            .expect("set");
        assert_eq!(f.auth.verify(&v).await.expect("verify"), None);
        assert_eq!(
            f.auth.verify(&a).await.expect("verify"),
            Some(Principal::Admin)
        );
        assert_eq!(
            f.auth.verify(&c).await.expect("verify"),
            Some(Principal::Client {
                api_key_id: "k1".into()
            })
        );
    }

    /// Concurrent first setups: exactly one wins, no loser overwrites its
    /// row, and the stored hash is the winner's.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_first_setups_have_one_persistent_winner() {
        let f = fixture(60_000);
        let auth = Arc::new(f.auth);
        let passwords: Vec<String> = (0..8).map(|i| format!("race-password-{i}-xyz")).collect();
        let tasks: Vec<_> = passwords
            .iter()
            .map(|p| {
                let (auth, p) = (auth.clone(), p.clone());
                tokio::spawn(async move { auth.set_initial_password(&p).await })
            })
            .collect();
        let mut won = Vec::new();
        for (i, t) in tasks.into_iter().enumerate() {
            if t.await.expect("join").expect("setup") {
                won.push(i);
            }
        }
        assert_eq!(won.len(), 1, "{won:?}");
        // Persistent: a fresh connection to the same file reads the
        // winner's hash, and only the winner's password logs in.
        let fresh = SqliteStore::open(&f.path, 0).expect("open");
        let stored = admin_password::admin_hash(&fresh).expect("read");
        for (i, p) in passwords.iter().enumerate() {
            assert_eq!(
                omni_crypto::password::verify(stored.as_deref(), p),
                i == won[0],
                "password {i}"
            );
            assert_eq!(auth.login(p).await.expect("login").is_some(), i == won[0]);
        }
    }

    /// A store refusal surfaces SQLite's own message, `SQLiteError` when it
    /// is empty; never the password.
    #[tokio::test]
    async fn store_failures_carry_sqlite_s_message_only() {
        for (raise, want) in [
            (
                "SELECT RAISE(ABORT, 'review write denied')",
                "review write denied",
            ),
            ("SELECT RAISE(FAIL, '')", "SQLiteError"),
        ] {
            let f = fixture(60_000);
            rusqlite::Connection::open(&f.path)
                .expect("open")
                .execute_batch(&format!(
                    "CREATE TRIGGER r BEFORE INSERT ON settings WHEN NEW.key = 'adminPasswordHash' BEGIN {raise}; END"
                ))
                .expect("trigger");
            match f.auth.set_initial_password(PW).await {
                Err(AuthError::Internal(m)) => {
                    assert_eq!(m, want);
                    assert!(!m.contains(PW));
                }
                other => panic!("{other:?}"),
            }
            assert!(!f.auth.is_configured().await.expect("read"));
        }
    }

    #[tokio::test]
    async fn client_sessions_end_when_the_key_stops_being_usable() {
        let f = fixture(60_000);
        let raw = "sk-omni-test-key";
        {
            let c = rusqlite::Connection::open(&f.path).expect("open");
            c.execute(
                "INSERT INTO api_keys (id, label, prefix, hash, limits, created_at) VALUES ('k1','l','sk-omni-test',?,'{}',1)",
                [omni_crypto::apikey::hash(raw)],
            )
            .expect("seed");
        }
        assert!(
            f.auth
                .login_client("sk-omni-nope")
                .await
                .expect("login")
                .is_none()
        );
        let t = f
            .auth
            .login_client(raw)
            .await
            .expect("login")
            .expect("token");
        assert_eq!(
            f.auth.verify(&t).await.expect("verify"),
            Some(Principal::Client {
                api_key_id: "k1".into()
            })
        );
        {
            let c = rusqlite::Connection::open(&f.path).expect("open");
            c.execute("UPDATE api_keys SET revoked_at = 5 WHERE id = 'k1'", [])
                .expect("revoke");
        }
        assert_eq!(f.auth.verify(&t).await.expect("verify"), None);
        assert!(f.kv.is_empty());
    }

    #[tokio::test]
    async fn invalidation_by_kind_and_all() {
        let f = fixture(60_000);
        f.auth.set_initial_password(PW).await.expect("set");
        f.auth
            .set_viewer_password(Some("viewer-password-1"))
            .await
            .expect("set");
        let a = f.auth.login(PW).await.expect("login").expect("token");
        let v = f
            .auth
            .login_viewer("viewer-password-1")
            .await
            .expect("login")
            .expect("token");
        f.auth.invalidate_kind(Kind::Admin).await.expect("drop");
        assert_eq!(f.auth.verify(&a).await.expect("verify"), None);
        assert_eq!(
            f.auth.verify(&v).await.expect("verify"),
            Some(Principal::Viewer)
        );
        f.auth.invalidate_sessions().await.expect("drop");
        assert_eq!(f.auth.verify(&v).await.expect("verify"), None);
        // The password itself is untouched.
        assert!(f.auth.login(PW).await.expect("login").is_some());
    }

    /// Review A4-I1: the bound is on *running* blocking jobs. Each job
    /// counts itself in and waits on a gate; the awaiting tasks are aborted
    /// as soon as their job runs, and a fresh task is started in its place.
    /// With the permit owned by the awaiting future, every abort released a
    /// slot while its job still ran.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn hashing_bound_survives_cancelled_waiters() {
        use std::sync::atomic::AtomicUsize;
        const PERMITS: usize = 2;
        const WAVES: usize = 4;
        let mut f = fixture(60_000);
        f.auth.set_hashing_permits(PERMITS);
        let auth = Arc::new(f.auth);
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let started = Arc::new(AtomicUsize::new(0));
        let (gate_tx, gate_rx) = std::sync::mpsc::channel::<()>();
        let gate = Arc::new(Mutex::new(gate_rx));
        let job = |auth: Arc<AdminAuth>| {
            let (active, peak, started, gate) =
                (active.clone(), peak.clone(), started.clone(), gate.clone());
            tokio::spawn(async move {
                auth.hashing(move || {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    started.fetch_add(1, Ordering::SeqCst);
                    // Held until the test opens the gate.
                    // A closed gate (the test ending) also releases.
                    if let Ok(g) = gate.lock() {
                        g.recv().ok();
                    }
                    active.fetch_sub(1, Ordering::SeqCst);
                })
                .await
            })
        };
        let mut waiting = Vec::new();
        for wave in 0..WAVES {
            let target = PERMITS * (wave + 1);
            let handles: Vec<_> = (0..PERMITS).map(|_| job(auth.clone())).collect();
            // Let this wave's jobs start, if the bound allows it.
            let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
            while started.load(Ordering::SeqCst) < target.min(PERMITS * WAVES)
                && tokio::time::Instant::now() < deadline
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            // A client hanging up mid-verify: the awaiting future goes away.
            for h in handles {
                h.abort();
                waiting.push(h);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let running_peak = peak.load(Ordering::SeqCst);
        // Release everything still parked, so blocking threads can exit.
        for _ in 0..PERMITS * WAVES {
            gate_tx.send(()).ok();
        }
        drop(gate_tx);
        for h in waiting {
            // Aborted: a `JoinError::Cancelled` is the expected outcome.
            h.await.err();
        }
        assert!(
            running_peak <= PERMITS,
            "{running_peak} blocking jobs ran at once with {PERMITS} permits"
        );
        // Every admitted job ran to completion: cancellation never strands a
        // permit either (the semaphore is whole again once they exit).
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while auth.idle_hashing_permits() < PERMITS && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(auth.idle_hashing_permits(), PERMITS);
    }

    #[test]
    fn memory_kv_sweeps_expired_entries_as_it_grows() {
        let clock = Arc::new(AtomicI64::new(0));
        let c = clock.clone();
        let kv = MemoryKv::new(Arc::new(move || c.load(Ordering::SeqCst)));
        for i in 0..100 {
            drop(kv.set(&format!("k{i}"), "v", 10));
        }
        clock.store(20, Ordering::SeqCst);
        for i in 0..200 {
            drop(kv.set(&format!("n{i}"), "v", 10));
        }
        assert!(kv.len() <= 200, "{}", kv.len());
    }

    #[test]
    fn principals_serialize_as_ts_does() {
        assert_eq!(Principal::Admin.to_json(), r#"{"kind":"admin"}"#);
        assert_eq!(
            Principal::Client {
                api_key_id: "a\"b".into()
            }
            .to_json(),
            r#"{"kind":"client","apiKeyId":"a\"b"}"#
        );
        assert_eq!(
            parse_session(
                r#"{"expiresAt":5,"principal":{"kind":"machine","tokenId":"t","pluginId":"p"}}"#
            ),
            None
        );
    }
}
