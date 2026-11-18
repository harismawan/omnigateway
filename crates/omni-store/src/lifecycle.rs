//! Registry of runtime SQLite owners. A swap leases every owner mutex.
use crate::SqliteStore;
use std::sync::{Arc, Mutex, Weak};

static OWNERS: Mutex<Vec<Weak<Mutex<SqliteStore>>>> = Mutex::new(Vec::new());
static ACCESS: std::sync::RwLock<()> = std::sync::RwLock::new(());
pub fn access() -> std::sync::RwLockReadGuard<'static, ()> {
    ACCESS
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub fn shared(store: SqliteStore) -> Arc<Mutex<SqliteStore>> {
    let store = Arc::new(Mutex::new(store));
    OWNERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(Arc::downgrade(&store));
    store
}

/// Registration is excluded until all old owners have been reopened.
pub fn exclusive<T>(
    path: &std::path::Path,
    operation: impl FnOnce(&mut [&mut SqliteStore]) -> T,
) -> T {
    let _access = ACCESS
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut registry = OWNERS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    registry.retain(|owner| owner.strong_count() > 0);
    let owners: Vec<_> = registry.iter().filter_map(Weak::upgrade).collect();
    let owners: Vec<_> = owners
        .into_iter()
        .filter(|owner| {
            owner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .path()
                == path
        })
        .collect();
    let mut guards: Vec<_> = owners
        .iter()
        .map(|owner| {
            owner
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
        })
        .collect();
    let mut stores: Vec<_> = guards
        .iter_mut()
        .filter(|s| s.path() == path)
        .map(|s| &mut **s)
        .collect();
    operation(&mut stores)
}
