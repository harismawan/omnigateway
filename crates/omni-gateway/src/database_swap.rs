//! A control swap closes every registered runtime connection under its owner lock.
use omni_control::database::{self as db, RestoreStore};
use std::path::Path;

struct Staged(std::path::PathBuf);
impl Drop for Staged {
    fn drop(&mut self) {
        drop(std::fs::remove_file(&self.0));
    }
}

struct RuntimeStore<'a, 'b> {
    inner: db::SqliteRestoreStore,
    owners: &'a mut [&'b mut omni_store::SqliteStore],
}
impl RestoreStore for RuntimeStore<'_, '_> {
    fn inspect(&mut self, p: &Path) -> Result<serde_json::Value, String> {
        self.inner.inspect(p)
    }
    fn snapshot_to(&mut self, p: &Path) -> Result<(), String> {
        self.inner.snapshot_to(p)
    }
    fn admin_hash(&mut self) -> Result<db::HashCell, String> {
        self.inner.admin_hash()
    }
    fn viewer_hash(&mut self) -> Result<db::HashCell, String> {
        self.inner.viewer_hash()
    }
    fn rebuild_rollup(&mut self) -> Result<(), String> {
        self.inner.rebuild_rollup()
    }
    fn close(&mut self) -> Result<(), String> {
        for owner in self.owners.iter_mut() {
            owner.suspend().map_err(|e| e.to_string())?;
        }
        self.inner.close()
    }
    fn reopen(&mut self) -> Result<(), String> {
        self.inner.reopen()?;
        for owner in self.owners.iter_mut() {
            owner.resume().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

pub async fn serve(
    app: &std::sync::Arc<crate::server::App>,
    req: hyper::Request<hyper::body::Incoming>,
    id: Option<String>,
) -> Result<hyper::Response<crate::server::Body>, crate::api::ApiError> {
    use crate::api::{ApiError, require_admin};
    require_admin(req.headers(), &app.admin).await?;
    if app.cluster {
        return Err(ApiError::gateway(
            omni_ir::error::ErrorCode::BadRequest,
            "not available on a Postgres store; use pg_dump",
        ));
    }
    let path = app.control.run(|s| Ok(s.path().to_path_buf())).await?;
    let label = if id.is_some() {
        "a restore"
    } else {
        "an import"
    };
    let _single = app.database_swap.try_lock().map_err(|_| {
        ApiError::gateway(
            omni_ir::error::ErrorCode::Conflict,
            format!("{label} is already running on this database"),
        )
    })?;
    let upload = if id.is_none() {
        use http_body_util::BodyExt;
        use tokio::io::AsyncWriteExt;
        let staged = path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(format!(
                "omni-import-{}.sqlite.part",
                crate::clock::uuid_v4()
            ));
        let cleanup = Staged(staged.clone());
        let reserve = (std::fs::metadata(&path).map_or(0, |m| m.len()) as f64 * 1.1).ceil() as u64;
        let budget = db::RestoreFiles::free_bytes(
            &mut db::LocalRestoreFiles,
            path.parent().unwrap_or_else(|| Path::new(".")),
        )
        .map(|free| free.saturating_sub(reserve))
        .unwrap_or(2 * 1024 * 1024 * 1024);
        let limit = budget.min(2 * 1024 * 1024 * 1024);
        let mut file = tokio::fs::File::create(&staged)
            .await
            .map_err(|_| ApiError::internal())?;
        let mut body = req.into_body();
        let mut size = 0;
        while let Some(frame) = tokio::time::timeout(app.idle_timeout, body.frame())
            .await
            .map_err(|_| ApiError::internal())?
        {
            let frame = frame.map_err(|_| ApiError::internal())?;
            if let Ok(bytes) = frame.into_data() {
                size += bytes.len();
                if size as u64 > limit {
                    drop(file);
                    drop(tokio::fs::remove_file(&staged).await);
                    return Err(if budget < 2 * 1024 * 1024 * 1024 {
                        ApiError::gateway(
                            omni_ir::error::ErrorCode::Conflict,
                            "not enough free disk space to stage a database import",
                        )
                    } else {
                        ApiError::gateway(
                            omni_ir::error::ErrorCode::BadRequest,
                            "a database import may not exceed 2147483648 bytes",
                        )
                    });
                }
                file.write_all(&bytes)
                    .await
                    .map_err(|_| ApiError::internal())?;
            }
        }
        file.flush().await.map_err(|_| ApiError::internal())?;
        Some(cleanup)
    } else {
        None
    };
    let owned = !app.quiesce.is_closed();
    app.quiesce.close(std::time::Duration::from_secs(10)).await;
    let offset = app.day_offset_minutes;
    let result = tokio::task::spawn_blocking(move || {
        omni_store::lifecycle::exclusive(&path, |owners| {
            let store = omni_store::SqliteStore::open(&path, offset)
                .map_err(|e| db::RestoreError::Ordinary(e.to_string()))?;
            let mut runtime = RuntimeStore {
                inner: db::SqliteRestoreStore::new(store, path.clone()),
                owners,
            };
            if let Some(id) = id {
                db::restore_snapshot(
                    &mut runtime,
                    &mut db::LocalRestoreFiles,
                    &path,
                    &id,
                    &crate::clock::now_ms,
                )
            } else {
                db::import_snapshot(
                    &mut runtime,
                    &mut db::LocalRestoreFiles,
                    &path,
                    &upload.as_ref().expect("staged upload").0,
                    &crate::clock::now_ms,
                )
            }
        })
    })
    .await
    .map_err(|_| ApiError::internal())?;
    match result {
        Ok(result) => {
            if result["adminPasswordChanged"] == true {
                app.admin.invalidate_sessions().await?;
            } else if result["viewerPasswordChanged"] == true {
                app.admin
                    .invalidate_kind(crate::admin_auth::Kind::Viewer)
                    .await?;
            }
            let holder = app.deps.holder.clone();
            app.control
                .run(move |s| {
                    holder.rebuild(s).map_err(|e| omni_control::api::Failure {
                        code: None,
                        message: e.to_string(),
                    })
                })
                .await?;
            app.quiesce.open();
            app.stream.invalidate_all();
            Ok(crate::api::json_ok(result.to_string()))
        }
        Err(db::RestoreError::Swap(error)) => Err(ApiError::gateway(
            omni_ir::error::ErrorCode::Internal,
            error.to_string(),
        )),
        Err(db::RestoreError::Ordinary(error)) => {
            if owned {
                app.quiesce.open();
            }
            if let Some((code, message)) = error.split_once(": ")
                && let Some(code) = omni_ir::error::ErrorCode::parse(code)
            {
                return Err(ApiError::gateway(code, message));
            }
            Err(ApiError::internal())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_registered_handles_reopen_after_swap_and_recovery() {
        let root = tempfile::tempdir().expect("fixture");
        let path = root.path().join("db");
        let store = omni_store::SqliteStore::open(&path, 0).expect("store");
        store
            .connection()
            .execute_batch("CREATE TABLE sentinel(value); INSERT INTO sentinel VALUES(1)")
            .expect("seed");
        let snapshot =
            db::create_snapshot(store.connection(), &path, &|| 1_700_000_000_000, &|| {
                Ok((3.0, 30.0))
            })
            .expect("snapshot");
        let id = snapshot["id"].as_str().expect("id");
        store
            .connection()
            .execute_batch("UPDATE sentinel SET value=2")
            .expect("changed");
        let owner = omni_store::lifecycle::shared(store);
        let second =
            omni_store::lifecycle::shared(omni_store::SqliteStore::open(&path, 0).expect("reader"));
        for (now, fail) in [(1_700_000_000_010, true), (1_700_000_000_020, false)] {
            let result = omni_store::lifecycle::exclusive(&path, |owners| {
                let mut runtime = RuntimeStore {
                    inner: db::SqliteRestoreStore::new(
                        omni_store::SqliteStore::open(&path, 0).expect("swap"),
                        path.clone(),
                    ),
                    owners,
                };
                let mut files = FailRename { fail };
                db::restore_snapshot(&mut runtime, &mut files, &path, id, &|| now)
            });
            if fail {
                assert!(matches!(
                    result,
                    Err(db::RestoreError::Swap(db::SwapFailedError {
                        reopened: true,
                        ..
                    }))
                ));
            } else {
                assert!(result.expect("recovery")["ok"] == true);
            }
            for handle in [&owner, &second] {
                assert_eq!(
                    handle
                        .lock()
                        .expect("owner")
                        .connection()
                        .query_row("SELECT value FROM sentinel", [], |r| r.get::<_, i64>(0))
                        .expect("reopened"),
                    if fail { 2 } else { 1 }
                );
            }
        }
    }
    struct FailRename {
        fail: bool,
    }
    impl db::RestoreFiles for FailRename {
        fn stat(&mut self, p: &Path) -> Option<u64> {
            db::LocalRestoreFiles.stat(p)
        }
        fn mkdir(&mut self, p: &Path) -> Result<(), String> {
            db::LocalRestoreFiles.mkdir(p)
        }
        fn free_bytes(&mut self, p: &Path) -> Option<u64> {
            db::LocalRestoreFiles.free_bytes(p)
        }
        fn unlink(&mut self, p: &Path) -> Result<(), String> {
            db::LocalRestoreFiles.unlink(p)
        }
        fn copy_file(&mut self, a: &Path, b: &Path) -> Result<(), String> {
            db::LocalRestoreFiles.copy_file(a, b)
        }
        fn rename(&mut self, a: &Path, b: &Path) -> Result<(), String> {
            if self.fail {
                Err("deterministic rename refusal".into())
            } else {
                db::LocalRestoreFiles.rename(a, b)
            }
        }
    }
}
