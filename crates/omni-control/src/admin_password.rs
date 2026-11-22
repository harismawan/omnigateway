//! The console passwords' storage half: the length rule, hashing, and the
//! `settings` rows `adminPasswordHash` and `viewerPasswordHash`.
//!
//! Synchronous and runtime-free, so the gateway (off its async workers) and
//! the CLI (`omni admin set-password`) share one copy. Sessions are not here:
//! they live in the gateway's session store, and ending them is its job.

use omni_store::{SqliteStore, StoreError};
use rusqlite::OptionalExtension as _;

/// `MIN_PASSWORD_LENGTH`, in UTF-16 units (`password.length`).
pub const MIN_PASSWORD_LENGTH: usize = 12;

/// `ADMIN_HASH_KEY`.
pub const ADMIN_HASH_KEY: &str = "adminPasswordHash";
/// `VIEWER_HASH_KEY`.
pub const VIEWER_HASH_KEY: &str = "viewerPasswordHash";

/// Which console password a check or write is about; it names the error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Which {
    Admin,
    Viewer,
}

/// A refusal whose message a route reports as
/// `BAD_REQUEST` (`describeError(error, "invalid password")`).
#[derive(Debug, thiserror::Error)]
pub enum PasswordError {
    #[error("{} password must be at least {MIN_PASSWORD_LENGTH} characters", match .0 { Which::Admin => "admin", Which::Viewer => "viewer" })]
    TooShort(Which),
    #[error(transparent)]
    Hash(#[from] omni_crypto::password::PasswordError),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// The length rule, checked before any hashing.
pub fn check_length(which: Which, password: &str) -> Result<(), PasswordError> {
    if omni_ir::js::utf16_len(password) < MIN_PASSWORD_LENGTH {
        return Err(PasswordError::TooShort(which));
    }
    Ok(())
}

/// The length rule, then a fresh hash ([`omni_crypto::password::hash`]).
pub fn hash_new(which: Which, password: &str) -> Result<String, PasswordError> {
    check_length(which, password)?;
    Ok(omni_crypto::password::hash(password)?)
}

/// `readRaw(key)`: the stored text, or `None` for no row. A non-text value
/// (only a hand edit writes one) reads as `None`.
fn read_raw(store: &SqliteStore, key: &str) -> Result<Option<String>, StoreError> {
    Ok(store
        .connection()
        .prepare_cached("SELECT value FROM settings WHERE key = ?")?
        .query_row([key], |r| {
            Ok(match r.get_ref(0)? {
                rusqlite::types::ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
                _ => None,
            })
        })
        .optional()?
        .flatten())
}

fn write_raw(store: &SqliteStore, key: &str, value: &str) -> Result<(), StoreError> {
    store.connection().execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

/// `getAdminPasswordHash`.
pub fn admin_hash(store: &SqliteStore) -> Result<Option<String>, StoreError> {
    read_raw(store, ADMIN_HASH_KEY)
}

/// `getViewerPasswordHash`.
pub fn viewer_hash(store: &SqliteStore) -> Result<Option<String>, StoreError> {
    read_raw(store, VIEWER_HASH_KEY)
}

/// `setAdminPasswordHashIfAbsent`: whether this write created the row.
pub fn set_admin_hash_if_absent(store: &SqliteStore, hash: &str) -> Result<bool, StoreError> {
    let changed = store.connection().execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
        [ADMIN_HASH_KEY, hash],
    )?;
    Ok(changed == 1)
}

/// `setAdminPasswordHash`.
pub fn set_admin_hash(store: &SqliteStore, hash: &str) -> Result<(), StoreError> {
    write_raw(store, ADMIN_HASH_KEY, hash)
}

/// `setViewerPasswordHash`: `None` deletes the row, which is what "off" is.
pub fn set_viewer_hash(store: &SqliteStore, hash: Option<&str>) -> Result<(), StoreError> {
    match hash {
        None => {
            store
                .connection()
                .execute("DELETE FROM settings WHERE key = ?", [VIEWER_HASH_KEY])?;
            Ok(())
        }
        Some(hash) => write_raw(store, VIEWER_HASH_KEY, hash),
    }
}

/// Whether the stored API key is usable at `now`. An unparseable
/// `model_allowlist` throws (the verify then fails the request); a missing
/// row is "no".
pub fn client_key_usable(store: &SqliteStore, id: &str, now: i64) -> Result<bool, StoreError> {
    use rusqlite::types::ValueRef;
    let row = store
        .connection()
        .prepare_cached(
            "SELECT revoked_at, expires_at, model_allowlist, limits FROM api_keys WHERE id = ?",
        )?
        .query_row([id], |r| {
            let num = |v: ValueRef<'_>| -> Option<f64> {
                match v {
                    ValueRef::Null => None,
                    #[allow(clippy::cast_precision_loss)]
                    ValueRef::Integer(i) => Some(i as f64),
                    ValueRef::Real(f) => Some(f),
                    // Only a hand edit stores anything else; it compares false.
                    _ => Some(f64::NAN),
                }
            };
            let allowlist = match r.get_ref(2)? {
                ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
                _ => None,
            };
            let limits = match r.get_ref(3)? {
                ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
                _ => None,
            };
            Ok((num(r.get_ref(0)?), num(r.get_ref(1)?), allowlist, limits))
        })
        .optional()?;
    let Some((revoked_at, expires_at, allowlist, limits)) = row else {
        return Ok(false);
    };
    if let Some(raw) = allowlist
        && let Some(error) = omni_ir::jsc_json::parse_error(&raw)
    {
        return Err(StoreError::StoredJson {
            table: "api_keys",
            column: "model_allowlist",
            row_id: id.to_owned(),
            detail: error.into(),
        });
    }
    if limits.as_deref().is_none_or(|raw| {
        matches!(
            crate::api::stored_limits(raw),
            omni_ir::jsjson::JsValue::Null
        )
    }) {
        tracing::error!(apiKeyId = %id, "api key limits unreadable");
    }
    #[allow(clippy::cast_precision_loss)]
    let now = now as f64;
    Ok(revoked_at.is_none() && expires_at.is_none_or(|at| at > now))
}

/// `admin.setPassword`'s storage half (`applyPassword` without ending
/// sessions): the length rule, a fresh hash, the row. What `omni admin
/// set-password` does; a gateway caller must also end every session.
pub fn set_admin_password(store: &SqliteStore, password: &str) -> Result<(), PasswordError> {
    let hash = hash_new(Which::Admin, password)?;
    set_admin_hash(store, &hash)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (SqliteStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = SqliteStore::open(dir.path().join("omni.db"), 0).expect("open");
        (store, dir)
    }

    #[test]
    fn length_is_counted_in_utf16_units_with_ts_wording() {
        assert_eq!(
            check_length(Which::Admin, "short").map_err(|e| e.to_string()),
            Err("admin password must be at least 12 characters".to_owned())
        );
        assert_eq!(
            check_length(Which::Viewer, "").map_err(|e| e.to_string()),
            Err("viewer password must be at least 12 characters".to_owned())
        );
        // Six astral characters are twelve UTF-16 units: long enough.
        assert!(check_length(Which::Admin, "😀😀😀😀😀😀").is_ok());
        // Eleven two-byte characters are eleven units, though 22 bytes.
        assert!(check_length(Which::Admin, "ééééééééééé").is_err());
    }

    #[test]
    fn rows_round_trip_as_ts_writes_them() {
        let (s, _d) = store();
        assert_eq!(admin_hash(&s).expect("read"), None);
        assert!(set_admin_hash_if_absent(&s, "h1").expect("write"));
        assert!(!set_admin_hash_if_absent(&s, "h2").expect("write"));
        assert_eq!(admin_hash(&s).expect("read").as_deref(), Some("h1"));
        set_admin_hash(&s, "h3").expect("write");
        assert_eq!(admin_hash(&s).expect("read").as_deref(), Some("h3"));
        set_viewer_hash(&s, Some("v")).expect("write");
        assert_eq!(viewer_hash(&s).expect("read").as_deref(), Some("v"));
        set_viewer_hash(&s, None).expect("delete");
        assert_eq!(viewer_hash(&s).expect("read"), None);
    }

    #[test]
    fn set_admin_password_hashes_and_refuses_short() {
        let (s, _d) = store();
        assert!(matches!(
            set_admin_password(&s, "short"),
            Err(PasswordError::TooShort(Which::Admin))
        ));
        assert_eq!(admin_hash(&s).expect("read"), None);
        set_admin_password(&s, "correct-horse-battery").expect("set");
        let stored = admin_hash(&s).expect("read");
        assert!(omni_crypto::password::verify(
            stored.as_deref(),
            "correct-horse-battery"
        ));
    }
}
