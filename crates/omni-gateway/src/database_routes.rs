//! Database panel's non-swap operations. Reuses E1 maintenance operations.
use crate::{
    api::{ApiError, json_ok, read_json, require_admin},
    server::{App, Body},
};
use hyper::{Method, Request, Response, body::Incoming};
use omni_control::{api::Failure, database as db};
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    Overview,
    Vacuum,
    Bodies,
    Snapshots,
    Create,
    Retention,
    Download(String),
    Delete(String),
}

pub fn route(method: &Method, path: &str) -> Option<Route> {
    match (method, path) {
        (&Method::GET | &Method::HEAD, "/api/database") => Some(Route::Overview),
        (&Method::POST, "/api/database/vacuum") => Some(Route::Vacuum),
        (&Method::DELETE, "/api/database/bodies") => Some(Route::Bodies),
        (&Method::GET | &Method::HEAD, "/api/database/snapshots") => Some(Route::Snapshots),
        (&Method::POST, "/api/database/snapshots") => Some(Route::Create),
        (&Method::PUT, "/api/database/retention") => Some(Route::Retention),
        _ => {
            let rest = path.strip_prefix("/api/database/snapshots/")?;
            if matches!(*method, Method::GET | Method::HEAD) {
                Some(Route::Download(rest.strip_suffix("/download")?.into()))
            } else if *method == Method::DELETE && !rest.contains('/') {
                Some(Route::Delete(rest.into()))
            } else {
                None
            }
        }
    }
}

fn failure(error: String) -> Failure {
    if let Some((code, message)) = error.split_once(": ")
        && let Some(code) = omni_ir::error::ErrorCode::parse(code)
    {
        return Failure {
            code: Some(code.as_str()),
            message: message.into(),
        };
    }
    Failure {
        code: None,
        message: error,
    }
}

fn snapshots(path: &std::path::Path) -> Vec<Value> {
    let mut snapshots: Vec<Value> = omni_control::database_fs::readdir(&path.parent().unwrap_or_else(|| std::path::Path::new(".")).join("snapshots"))
        .into_iter().filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let (stamp, reason) = name.strip_prefix("db_")?.strip_suffix(".sqlite")?.split_once('_')?;
            if stamp.len() != 24 || reason.is_empty() || !reason.bytes().all(|b| b.is_ascii_alphabetic()) { return None; }
            let mut stamp = stamp.to_owned();
            if !stamp.is_ascii() { return None; }
            for (index, replacement) in [(13, ":"), (16, ":"), (19, ".")] { stamp.replace_range(index..index+1, replacement); }
            let at = chrono::DateTime::parse_from_rfc3339(&stamp).ok()?.timestamp_millis();
            Some(json!({"id":name,"filename":name,"createdAt":at,"reason":reason,"sizeBytes":size(&entry.path())}))
        }).collect();
    snapshots.sort_by_key(|v| std::cmp::Reverse(v["createdAt"].as_i64()));
    snapshots
}

fn snapshot_path(live: &std::path::Path, id: &str) -> Result<std::path::PathBuf, String> {
    let valid = id
        .strip_prefix("db_")
        .and_then(|s| s.strip_suffix(".sqlite"))
        .and_then(|s| s.split_once('_'))
        .is_some_and(|(stamp, reason)| {
            stamp.len() == 24
                && !reason.is_empty()
                && reason.bytes().all(|b| b.is_ascii_alphabetic())
                && stamp.bytes().enumerate().all(|(i, b)| match i {
                    4 | 7 | 13 | 16 | 19 => b == b'-',
                    10 => b == b'T',
                    23 => b == b'Z',
                    _ => b.is_ascii_digit(),
                })
        });
    if !valid {
        return Err("BAD_REQUEST: invalid snapshot id".into());
    }
    let dir = live
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("snapshots");
    if id.contains('/') || !snapshots(live).iter().any(|v| v["id"] == id) {
        return Err("BAD_REQUEST: no such snapshot".into());
    }
    let path = dir.join(id);
    if let Ok(real) = path.canonicalize()
        && real.parent() != Some(dir.canonicalize().unwrap_or(dir).as_path())
    {
        return Err("BAD_REQUEST: invalid snapshot id".into());
    }
    Ok(path)
}

fn size(path: &std::path::Path) -> u64 {
    omni_control::database_fs::stat(path).map_or(0, |m| m.len())
}
fn dir_bytes(path: &std::path::Path) -> u64 {
    omni_control::database_fs::readdir(path)
        .iter()
        .map(|e| match e.file_type() {
            Ok(kind) if kind.is_dir() => dir_bytes(&e.path()),
            Ok(kind) if kind.is_file() => size(&e.path()),
            _ => 0,
        })
        .sum()
}

fn parse_retention(body: &omni_ir::jsjson::JsValue) -> Result<Value, String> {
    use omni_control::body_schema::{Z, parse_or_throw};
    let positive = |max| Z::Num {
        int: true,
        positive: true,
        max: Some(max),
    };
    let schema = Z::Obj {
        shape: vec![
            ("keepLatest", positive(100.0)),
            ("maxAgeDays", positive(3650.0)),
        ],
        strict: true,
        refine: None,
    };
    Ok(omni_control::api::lossy(&parse_or_throw(&schema, body)?))
}

fn retention_patch(policy: &Value) -> Value {
    json!({"snapshotKeepLatest":policy["keepLatest"],"snapshotMaxAgeDays":policy["maxAgeDays"]})
}

fn retention_policy(settings: &omni_ir::jsjson::JsValue) -> Value {
    let setting = |key| {
        omni_control::settings_value::get(settings, key)
            .map(omni_control::settings_value::shallow)
            .unwrap_or(Value::Null)
    };
    json!({"keepLatest":setting("snapshotKeepLatest"),"maxAgeDays":setting("snapshotMaxAgeDays")})
}

async fn postgres(
    pg: &omni_store::pg::PgStore,
    route: Route,
    retention: Option<Value>,
) -> Result<Value, Failure> {
    match route {
        Route::Overview => {
            let stats = async { pg.database_stats().await.map_err(Failure::from) };
            let tables = async { pg.database_tables().await.map_err(Failure::from) };
            let (stats, tables, settings) =
                tokio::try_join!(stats, tables, omni_control::api::settings_postgres(pg))?;
            let page_size = i64::from(stats.page_size);
            let pages = stats.bytes.div_euclid(page_size)
                + i64::from(stats.bytes.rem_euclid(page_size) != 0);
            let bodies = tables
                .iter()
                .find(|t| t.name == "request_bodies")
                .map_or(0, |t| t.bytes);
            let tables: Vec<_> = tables
                .into_iter()
                .map(
                    |t| json!({"name":t.name,"bytes":t.bytes,"rows":t.rows,"deadRows":t.dead_rows}),
                )
                .collect();
            Ok(
                json!({"engine":"postgres","location":pg.database_path(),"stats":{"pageSize":page_size,"pageCount":pages,"freelistCount":0,"schemaVersion":stats.schema_version},"logicalBytes":page_size*pages,"freePageBytes":0,"tables":tables,"retention":retention_policy(&settings),"fileBytes":0,"walBytes":0,"bodiesBytes":bodies,"freeDiskBytes":null,"snapshots":{"count":0,"totalBytes":0,"latestAt":null}}),
            )
        }
        Route::Bodies => {
            #[allow(clippy::cast_precision_loss)]
            let cutoff = crate::clock::now_ms() as f64;
            let removed = pg.prune_bodies(cutoff).await?;
            // PG stores the artifacts inline; there are no orphan files.
            Ok(json!({"ok":true,"removed":removed,"orphans":0}))
        }
        Route::Retention => {
            let value = retention.ok_or_else(|| failure("missing retention".into()))?;
            let patch = retention_patch(&value);
            omni_control::api::merge_settings_postgres(
                pg,
                &patch,
                &omni_ir::jsjson::JsValue::from(&patch),
            )
            .await?;
            Ok(value)
        }
        Route::Snapshots => Ok(json!({"snapshots":[]})),
        Route::Download(_) | Route::Delete(_) => {
            Err(failure("BAD_REQUEST: no such snapshot".into()))
        }
        Route::Vacuum | Route::Create => Err(failure(
            "BAD_REQUEST: not available on a Postgres store; use pg_dump".into(),
        )),
    }
}

pub async fn serve(
    app: &Arc<App>,
    route: Route,
    req: Request<Incoming>,
) -> Result<Response<Body>, ApiError> {
    require_admin(req.headers(), &app.admin).await?;
    let retention = if route == Route::Retention {
        let body = read_json(req, app.idle_timeout).await?;
        Some(parse_retention(&body).map_err(|e| crate::admin_routes::failure(failure(e)))?)
    } else {
        None
    };
    if let Some(pg) = app.control.postgres() {
        let result = postgres(pg, route, retention)
            .await
            .map_err(crate::admin_routes::failure)?;
        return Ok(json_ok(result.to_string()));
    }
    let result = app
        .control
        .run(move |store| {
            let path = store.path();
            let conn = store.connection();
            let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
            let operation = || -> Result<Value, String> {
                match route {
                    Route::Vacuum => {
                        let mut result = db::vacuum(conn, path, &crate::clock::now_ms)?;
                        result["ok"] = json!(true);
                        Ok(result)
                    }
                    Route::Bodies => {
                        let mut result = db::clear_bodies(
                            conn,
                            &dir.join("request_bodies"),
                            crate::clock::now_ms(),
                        )?;
                        result["ok"] = json!(true);
                        Ok(result)
                    }
                    Route::Snapshots => Ok(json!({"snapshots":snapshots(path)})),
                    Route::Create => {
                        db::create_snapshot(conn, path, &crate::clock::now_ms, &|| {
                            let settings = omni_control::settings_value::read(store)?;
                            Ok((
                                db::retention_number(omni_control::settings_value::get(
                                    &settings,
                                    "snapshotKeepLatest",
                                ))?,
                                db::retention_number(omni_control::settings_value::get(
                                    &settings,
                                    "snapshotMaxAgeDays",
                                ))?,
                            ))
                        })
                    }
                    Route::Delete(ref id) => {
                        let path = snapshot_path(path, id)?;
                        std::fs::remove_file(path).map_err(|e| e.to_string())?;
                        Ok(json!({"ok":true}))
                    }
                    Route::Download(ref id) => {
                        Ok(json!({"path":snapshot_path(path,id)?,"filename":id}))
                    }
                    Route::Retention => {
                        let body = retention.as_ref().ok_or("missing retention")?;
                        let settings = omni_control::settings_value::read(store)?;
                        omni_control::settings_value::write(
                            store,
                            &retention_patch(body),
                            &settings,
                        )?;
                        Ok(body.clone())
                    }
                    Route::Overview => overview(store),
                }
            };
            operation().map_err(failure)
        })
        .await?;
    if let Some(path) = result["path"].as_str() {
        let path = path.to_owned();
        let filename = result["filename"].as_str().unwrap_or_default().to_owned();
        let file = tokio::task::spawn_blocking(move || std::fs::File::open(path))
            .await
            .map_err(|_| ApiError::internal())?
            .map_err(|_| ApiError::internal())?;
        let length = file.metadata().map_err(|_| ApiError::internal())?.len();
        use http_body_util::BodyExt;
        let stream = async_stream::stream! {
            let mut file = file;
            loop {
                let read = tokio::task::spawn_blocking(move || {
                    use std::io::Read;
                    let mut bytes = vec![0; 64 * 1024];
                    let result = file.read(&mut bytes).map(|n| { bytes.truncate(n); bytes });
                    (file,result)
                }).await;
                match read {
                    Ok((next, Ok(bytes))) => { file = next; if bytes.is_empty() { break; } yield Ok(hyper::body::Frame::data(bytes::Bytes::from(bytes))); }
                    Ok((_, Err(error))) => { yield Err(error); break; }
                    Err(error) => { yield Err(std::io::Error::other(error)); break; }
                }
            }
        };
        let mut response = Response::new(http_body_util::StreamBody::new(stream).boxed_unsync());
        for (key, value) in [
            ("content-type", "application/octet-stream".into()),
            ("content-length", length.to_string()),
            (
                "content-disposition",
                format!("attachment; filename=\"{filename}\""),
            ),
            ("cache-control", "no-store".into()),
        ] {
            response.headers_mut().insert(
                hyper::header::HeaderName::from_static(key),
                value.parse().map_err(|_| ApiError::internal())?,
            );
        }
        return Ok(response);
    }
    Ok(json_ok(result.to_string()))
}

fn overview(store: &omni_store::SqliteStore) -> Result<Value, String> {
    let conn = store.connection();
    let path = store.path();
    let dir = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let scalar = |sql: &str| {
        conn.query_row(sql, [], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())
    };
    let pages = scalar("PRAGMA page_count")?;
    let page_size = scalar("PRAGMA page_size")?;
    let free = scalar("PRAGMA freelist_count")?;
    let version = scalar("SELECT COALESCE(MAX(id),0) FROM migrations")?;
    let mut statement = conn.prepare("SELECT m.tbl_name AS name,SUM(s.pgsize) AS bytes,SUM(CASE WHEN s.pagetype = 'leaf' AND s.name = m.tbl_name THEN s.ncell ELSE 0 END) AS rows FROM dbstat s JOIN sqlite_master m ON m.name = s.name WHERE m.tbl_name NOT LIKE 'sqlite_%' GROUP BY m.tbl_name ORDER BY bytes DESC,name").map_err(|e|e.to_string())?;
    let tables = statement.query_map([], |r| Ok(json!({"name":r.get::<_,String>(0)?,"bytes":r.get::<_,i64>(1)?,"rows":r.get::<_,i64>(2)?,"deadRows":null}))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let settings = omni_control::settings_value::read(store)?;
    let snaps = snapshots(path);
    let free_disk = db::RestoreFiles::free_bytes(&mut db::LocalRestoreFiles, dir);
    Ok(
        json!({"engine":"sqlite","location":path,"stats":{"pageSize":page_size,"pageCount":pages,"freelistCount":free,"schemaVersion":version},"logicalBytes":page_size*pages,"freePageBytes":page_size*free,"tables":tables,"retention":retention_policy(&settings),"fileBytes":size(path),"walBytes":size(&std::path::PathBuf::from(format!("{}-wal",path.display()))),"bodiesBytes":dir_bytes(&dir.join("request_bodies")),"freeDiskBytes":free_disk,"snapshots":{"count":snaps.len(),"totalBytes":snaps.iter().filter_map(|s|s["sizeBytes"].as_u64()).sum::<u64>(),"latestAt":snaps.first().map(|s|s["createdAt"].clone())}}),
    )
}
