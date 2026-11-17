//! `routes/admin.ts`'s keys, models, catalog, settings and password
//! handlers (roadmap A5), on the router [`crate::api`] owns.
//!
//! Each handler does what TS's does in the same order: the guard
//! (`requireReader` for reads, `requireAdmin` for writes), the body
//! (`readJson` / `readJsonRecord`), one `@omni/control` operation, and the
//! JSON answer. The operations are `omni_control::api`'s, shared with
//! nothing request-path: they run on the blocking pool against the control
//! connection ([`ControlStore`]), never the `/v1` one.
//!
//! A config write commits to SQLite, which moves `PRAGMA data_version` on
//! the snapshot refresher's connection: the routing snapshot (and so `/v1`
//! key admission and model resolution) picks it up on its next poll.
//! Unlike TS there is no in-process `emit`: the poll is the one path, for a
//! write from this process and from any other alike.
use std::sync::{Arc, Mutex};

use hyper::body::Incoming;
use hyper::{Request, Response};
use omni_control::api::{self as ops, Failure, KeyEdit};
use omni_ir::error::ErrorCode;
use omni_ir::jsjson::JsValue;
use omni_store::SqliteStore;

use crate::api::{ApiError, json_ok, read_json, read_json_fields, require_admin, require_reader};
use crate::server::{App, Body};

/// The connection the admin routes' config reads and writes use: its own,
/// opened at boot, behind a mutex (admin traffic is light), and only ever
/// touched on the blocking pool.
#[derive(Clone)]
pub struct ControlStore(
    Arc<Mutex<SqliteStore>>,
    Arc<tokio::sync::Semaphore>,
    std::path::PathBuf,
    i64,
    Arc<tokio::sync::Semaphore>,
    Option<Arc<tokio::sync::OwnedSemaphorePermit>>,
    Arc<Mutex<Vec<SqliteStore>>>,
);

/// Returns the connection even on task cancellation/panic. A started blocking
/// page owns this lease and its permit until encoding finishes.
struct ExportLease {
    store: Option<SqliteStore>,
    pool: Arc<Mutex<Vec<SqliteStore>>>,
    _permit: tokio::sync::OwnedSemaphorePermit,
}

impl Drop for ExportLease {
    fn drop(&mut self) {
        if let Some(store) = self.store.take() {
            self.pool
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(store);
        }
    }
}

impl std::fmt::Debug for ControlStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ControlStore").finish_non_exhaustive()
    }
}

impl ControlStore {
    pub fn new(store: SqliteStore) -> Self {
        let path = store.path().to_owned();
        let offset = store.day_offset_minutes();
        Self(
            Arc::new(Mutex::new(store)),
            Arc::new(tokio::sync::Semaphore::new(4)),
            path,
            offset,
            Arc::new(tokio::sync::Semaphore::new(4)),
            None,
            Arc::new(Mutex::new(Vec::new())),
        )
    }

    /// Pool at most four read-only connections across all exports. No lease
    /// crosses a socket await: the blocking task returns it before its result.
    async fn export_page(
        &self,
        query: omni_store::logs::Query,
        jsonl: bool,
    ) -> Result<(String, Option<omni_store::logs::Query>), ApiError> {
        let permit = self
            .1
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ApiError::internal())?;
        let pool = self.6.clone();
        let path = self.2.clone();
        let offset = self.3;
        tokio::task::spawn_blocking(move || {
            let cached = pool
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .pop();
            let store = match cached {
                Some(store) => store,
                None => SqliteStore::open_reader(path, offset).map_err(|_| ApiError::internal())?,
            };
            let lease = ExportLease {
                store: Some(store),
                pool,
                _permit: permit,
            };
            let result = omni_control::logs::export_page(
                lease.store.as_ref().ok_or_else(ApiError::internal)?,
                &query,
                jsonl,
            )
            .map_err(failure);
            drop(lease);
            result
        })
        .await
        .map_err(|_| ApiError::internal())?
    }

    pub(crate) async fn reader(&self) -> Result<Self, ApiError> {
        let permit = self
            .4
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| ApiError::internal())?;
        let path = self.2.clone();
        let offset = self.3;
        let (store, permit) = tokio::task::spawn_blocking(move || {
            SqliteStore::open_reader(path, offset).map(|store| (store, permit))
        })
        .await
        .map_err(|_| ApiError::internal())?
        .map_err(|_| ApiError::internal())?;
        let mut reader = Self::new(store);
        reader.5 = Some(Arc::new(permit));
        Ok(reader)
    }

    /// One operation on the blocking pool. A failure that is not a
    /// `GatewayError` is `500 INTERNAL "internal error"` and logged here (TS
    /// logs nothing; the reason is useful and carries no request data).
    pub(crate) async fn run<T: Send + 'static>(
        &self,
        f: impl FnOnce(&SqliteStore) -> Result<T, Failure> + Send + 'static,
    ) -> Result<T, ApiError> {
        let store = self.0.clone();
        let permit = self.5.clone();
        let joined = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let guard = store
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            f(&guard)
        })
        .await;
        match joined {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(failure(e)),
            Err(e) => {
                tracing::error!(reason = %e, "admin route task failed");
                Err(ApiError::internal())
            }
        }
    }
}

fn failure(e: Failure) -> ApiError {
    match e.code.and_then(ErrorCode::parse) {
        Some(code) => ApiError::gateway(code, e.message),
        None => {
            tracing::error!(reason = %e.message, "admin route failed");
            ApiError::internal()
        }
    }
}

/// The routes this module serves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admin {
    ConnectStart,
    ConnectFinish,
    ConnectPoll,
    Usage,
    Logs,
    ExportLogs,
    RequestBody(Option<String>),
    Nodes,
    ListCredentials,
    CreateCredential,
    PatchCredential(Option<String>),
    RemoveCredential(Option<String>),
    CredentialHealth,
    ListModels,
    PutModel(Option<String>),
    RemoveModel(Option<String>),
    Catalog,
    ListKeys,
    CreateKey,
    EditKey(Option<String>, KeyEdit),
    RevokeKey(Option<String>),
    GetSettings,
    PutSettings,
    Password,
    ViewerPassword,
}

impl Admin {
    fn resource_topic(&self) -> Option<&'static str> {
        match self {
            Self::CreateCredential | Self::PatchCredential(_) | Self::RemoveCredential(_) => {
                Some("res:credentials")
            }
            Self::PutModel(_) | Self::RemoveModel(_) => Some("res:models"),
            Self::CreateKey | Self::EditKey(_, _) | Self::RevokeKey(_) => Some("res:keys"),
            Self::PutSettings | Self::ViewerPassword => Some("res:settings"),
            _ => None,
        }
    }
}

/// `fast-decode-uri-component`, which Elysia's router runs on every path
/// parameter: `None` where it returns `null` (a bad escape or ill-formed
/// UTF-8). The router matched on the raw (normalized) path, so `%2F` in a
/// parameter is a `/` in the id and never a segment break.
pub fn decode_param(raw: &str) -> Option<String> {
    if !raw.contains('%') {
        return Some(raw.to_owned());
    }
    crate::static_files::decode_uri_component(raw)
}

/// The admin route for a method and normalized path, if it is one.
/// `HEAD` reaches every `GET` route, as Elysia's does.
pub fn route(method: &hyper::Method, path: &str) -> Option<Admin> {
    use hyper::Method as M;
    let get = matches!(*method, M::GET | M::HEAD);
    let param = |rest: &str| (!rest.is_empty() && !rest.contains('/')).then(|| decode_param(rest));
    match path {
        "/api/connect/start" if *method == M::POST => return Some(Admin::ConnectStart),
        "/api/connect/finish" if *method == M::POST => return Some(Admin::ConnectFinish),
        "/api/connect/poll" if *method == M::POST => return Some(Admin::ConnectPoll),
        "/api/usage" if get => return Some(Admin::Usage),
        "/api/logs" if get => return Some(Admin::Logs),
        "/api/logs/export" if get => return Some(Admin::ExportLogs),
        "/api/nodes" if get => return Some(Admin::Nodes),
        "/api/credentials" if get => return Some(Admin::ListCredentials),
        "/api/credentials" if *method == M::POST => return Some(Admin::CreateCredential),
        "/api/credentials/health" if get => return Some(Admin::CredentialHealth),
        "/api/models" if get => return Some(Admin::ListModels),
        "/api/catalog" if get => return Some(Admin::Catalog),
        "/api/keys" if get => return Some(Admin::ListKeys),
        "/api/keys" if *method == M::POST => return Some(Admin::CreateKey),
        "/api/settings" if get => return Some(Admin::GetSettings),
        "/api/settings" if *method == M::PUT => return Some(Admin::PutSettings),
        "/api/settings/password" if *method == M::PUT => return Some(Admin::Password),
        "/api/settings/viewer-password" if *method == M::PUT => {
            return Some(Admin::ViewerPassword);
        }
        _ => {}
    }
    if get
        && let Some(rest) = path.strip_prefix("/api/requests/")
        && let Some(id) = rest.strip_suffix("/body")
    {
        return param(id).map(Admin::RequestBody);
    }
    if let Some(rest) = path.strip_prefix("/api/models/") {
        let id = param(rest)?;
        return match *method {
            M::PUT => Some(Admin::PutModel(id)),
            M::DELETE => Some(Admin::RemoveModel(id)),
            _ => None,
        };
    }
    if let Some(rest) = path.strip_prefix("/api/credentials/") {
        let id = param(rest)?;
        return match *method {
            M::PATCH => Some(Admin::PatchCredential(id)),
            M::DELETE => Some(Admin::RemoveCredential(id)),
            _ => None,
        };
    }
    let rest = path.strip_prefix("/api/keys/")?;
    if *method == M::DELETE {
        return param(rest).map(Admin::RevokeKey);
    }
    if *method != M::PUT {
        return None;
    }
    let (id, edit) = rest.split_once('/')?;
    if id.is_empty() {
        return None;
    }
    let edit = match edit {
        "limits" => KeyEdit::Limits,
        "models" => KeyEdit::Models,
        "expiry" => KeyEdit::Expiry,
        "guardrail" => KeyEdit::Guardrail,
        "smart-routing" => KeyEdit::SmartRouting,
        _ => return None,
    };
    Some(Admin::EditKey(decode_param(id), edit))
}

/// Serves a matched admin route.
pub async fn serve(
    app: &App,
    route: Admin,
    req: Request<Incoming>,
) -> Result<Response<Body>, ApiError> {
    let topic = route.resource_topic();
    let response = serve_inner(app, route, req).await?;
    if let Some(topic) = topic {
        app.stream.invalidate(topic, None);
    }
    Ok(response)
}

async fn serve_inner(
    app: &App,
    route: Admin,
    req: Request<Incoming>,
) -> Result<Response<Body>, ApiError> {
    let control = app.control.clone();
    let now = crate::clock::now_ms();
    match route {
        Admin::RequestBody(id) => {
            require_admin(req.headers(), &app.admin).await?;
            // Frozen GET does not apply the writer's safe-id predicate. An
            // invalid percent escape decodes to null and is an absent lookup.
            let Some(id) = id else {
                return Ok(json_ok(String::from(
                    "{\"requestId\":null,\"detailState\":\"none\",\"truncated\":false,\"sizeBytes\":0,\"at\":null,\"artifact\":null}",
                )));
            };
            let key = app.credential_key.clone();
            Ok(json_ok(
                control
                    .run(move |s| omni_control::bodies::read_request_body(s, &key, &id))
                    .await?,
            ))
        }
        Admin::ConnectStart => Box::pin(crate::connect::serve(app, req, "start")).await,
        Admin::ConnectFinish => Box::pin(crate::connect::serve(app, req, "finish")).await,
        Admin::ConnectPoll => Box::pin(crate::connect::serve(app, req, "poll")).await,
        Admin::ExportLogs => {
            require_reader(req.headers(), &app.admin).await?;
            let (query, jsonl) = omni_control::logs::export_query(req.uri().query().unwrap_or(""))
                .map_err(failure)?;
            let first_query = query.clone();
            let first_query = omni_control::logs::parse_query(&first_query).map_err(failure)?;
            let (first, next) = control.export_page(first_query, jsonl).await?;
            let empty = jsonl && first.is_empty() && next.is_none();
            let stream = async_stream::try_stream! {
                if !jsonl {yield hyper::body::Frame::data(bytes::Bytes::from_static(omni_control::logs::CSV_HEADER.as_bytes()));}
                yield hyper::body::Frame::data(bytes::Bytes::from(first));
                let mut next=next;
                while let Some(cursor)=next {
                    let q=cursor;
                    let (chunk,cursor)=control.export_page(q,jsonl).await.map_err(|_|std::io::Error::other("log export read failed"))?;
                    next=cursor;
                    yield hyper::body::Frame::data(bytes::Bytes::from(chunk));
                }
            };
            use http_body_util::BodyExt;
            let body = if empty {
                http_body_util::Full::new(bytes::Bytes::new())
                    .map_err(|never| match never {})
                    .boxed_unsync()
            } else {
                http_body_util::StreamBody::new(stream).boxed_unsync()
            };
            let stamp = chrono::Utc::now()
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                .replace([':', '.'], "-");
            let format = if jsonl { "jsonl" } else { "csv" };
            Ok(Response::builder()
                .header(
                    "content-type",
                    if jsonl {
                        "application/x-ndjson"
                    } else {
                        "text/csv; charset=utf-8"
                    },
                )
                .header(
                    "content-disposition",
                    format!("attachment; filename=\"omnigateway-logs-{stamp}.{format}\""),
                )
                .header("cache-control", "no-store")
                .body(body)
                .map_err(|_| ApiError::internal())?)
        }
        Admin::Nodes => {
            require_reader(req.headers(), &app.admin).await?;
            let control = control.reader().await?;
            let node_id = app.node_id.clone();
            Ok(json_ok(
                control
                    .run(move |s| omni_control::reports::nodes(s, now, &node_id))
                    .await?,
            ))
        }
        Admin::Logs => {
            require_reader(req.headers(), &app.admin).await?;
            let control = control.reader().await?;
            let query = req.uri().query().unwrap_or("").to_owned();
            Ok(json_ok(
                control
                    .run(move |s| omni_control::logs::page(s, &query))
                    .await?,
            ))
        }
        Admin::Usage => {
            require_reader(req.headers(), &app.admin).await?;
            let control = control.reader().await?;
            let query = req.uri().query().unwrap_or("").to_owned();
            #[allow(clippy::cast_precision_loss)]
            let now = now as f64;
            Ok(json_ok(
                control
                    .run(move |s| omni_control::reports::usage(s, &query, now))
                    .await?,
            ))
        }
        Admin::ListCredentials => {
            require_reader(req.headers(), &app.admin).await?;
            Ok(json_ok(control.run(omni_control::credentials::list).await?))
        }
        Admin::CredentialHealth => {
            require_reader(req.headers(), &app.admin).await?;
            Ok(json_ok(
                control
                    .run(move |s| omni_control::credentials::health(s, now))
                    .await?,
            ))
        }
        Admin::CreateCredential => {
            require_admin(req.headers(), &app.admin).await?;
            let body = read_json(req, app.idle_timeout).await?;
            let key = app.credential_key.clone();
            Ok(json_ok(
                control
                    .run(move |s| {
                        omni_control::credentials::create(s, &key, &body, crate::clock::now_ms())
                    })
                    .await?,
            ))
        }
        Admin::PatchCredential(id) => {
            require_admin(req.headers(), &app.admin).await?;
            let body = read_json(req, app.idle_timeout).await?;
            control
                .run(move |s| {
                    omni_control::credentials::patch(
                        s,
                        id.as_deref(),
                        &body,
                        crate::clock::now_ms(),
                    )
                })
                .await?;
            Ok(json_ok(crate::api::OK.into()))
        }
        Admin::RemoveCredential(id) => {
            require_admin(req.headers(), &app.admin).await?;
            control
                .run(move |s| omni_control::credentials::remove(s, id.as_deref()))
                .await?;
            Ok(json_ok(crate::api::OK.into()))
        }
        Admin::ListModels => {
            require_reader(req.headers(), &app.admin).await?;
            Ok(json_ok(control.run(ops::list_models).await?))
        }
        Admin::Catalog => {
            require_reader(req.headers(), &app.admin).await?;
            let (body, problems) = control
                .run(|s| {
                    let accounts = ops::accounts(s)?;
                    let mut problems = Vec::new();
                    let body = ops::catalog(&accounts, &mut |p| problems.push(p))?;
                    Ok((body, problems))
                })
                .await?;
            app.report_catalog_problems(problems);
            Ok(json_ok(body))
        }
        Admin::PutModel(id) => {
            require_admin(req.headers(), &app.admin).await?;
            let body = read_json(req, app.idle_timeout).await?;
            control
                .run(move |s| ops::put_model(s, id.as_deref(), &body))
                .await?;
            Ok(json_ok(crate::api::OK.to_owned()))
        }
        Admin::RemoveModel(id) => {
            require_admin(req.headers(), &app.admin).await?;
            control
                .run(move |s| ops::remove_model(s, id.as_deref()))
                .await?;
            Ok(json_ok(crate::api::OK.to_owned()))
        }
        Admin::ListKeys => {
            require_reader(req.headers(), &app.admin).await?;
            Ok(json_ok(control.run(move |s| ops::list_keys(s, now)).await?))
        }
        Admin::CreateKey => {
            require_admin(req.headers(), &app.admin).await?;
            let body = read_json(req, app.idle_timeout).await?;
            let now = crate::clock::now_ms();
            Ok(json_ok(
                control.run(move |s| ops::create_key(s, &body, now)).await?,
            ))
        }
        Admin::EditKey(id, edit) => {
            require_admin(req.headers(), &app.admin).await?;
            let body = read_json(req, app.idle_timeout).await?;
            let now = crate::clock::now_ms();
            Ok(json_ok(
                control
                    .run(move |s| ops::edit_key(s, id.as_deref(), edit, &body, now))
                    .await?,
            ))
        }
        Admin::RevokeKey(id) => {
            require_admin(req.headers(), &app.admin).await?;
            let now = crate::clock::now_ms();
            control
                .run(move |s| ops::revoke_key(s, id.as_deref(), now))
                .await?;
            Ok(json_ok(crate::api::OK.to_owned()))
        }
        Admin::GetSettings => {
            require_reader(req.headers(), &app.admin).await?;
            let settings = control.run(ops::settings).await?;
            let viewer = app.admin.is_viewer_configured().await?;
            let models = {
                let settings = settings.clone();
                control
                    .run(move |s| ops::smart_router_models(s, &settings))
                    .await?
            };
            Ok(json_ok(ops::settings_body(
                settings,
                app.body_logging_allowed,
                app.day_offset_minutes,
                viewer,
                models,
            )))
        }
        Admin::PutSettings => {
            require_admin(req.headers(), &app.admin).await?;
            let body = read_json(req, app.idle_timeout).await?;
            control.run(move |s| ops::put_settings(s, &body)).await?;
            Ok(json_ok(crate::api::OK.to_owned()))
        }
        Admin::Password => change_password(app, req).await,
        Admin::ViewerPassword => viewer_password(app, req).await,
    }
}

/// `PUT /api/settings/password`: the current password, then a new one;
/// success ends every session, this caller's included.
async fn change_password(app: &App, req: Request<Incoming>) -> Result<Response<Body>, ApiError> {
    require_admin(req.headers(), &app.admin).await?;
    let fields = read_json_fields(req, app.idle_timeout, &["current", "password"]).await?;
    let (Some(current), Some(password)) = (fields.string("current"), fields.string("password"))
    else {
        return Err(ApiError::gateway(
            ErrorCode::BadRequest,
            "current and password are required",
        ));
    };
    // `catch (error) { throw BAD_REQUEST(describeError(error)) }`: the
    // length rule's message, or a store failure's.
    let changed = match app.admin.change_password(current, password).await {
        Ok(changed) => changed,
        Err(
            crate::admin_auth::AuthError::Password(message)
            | crate::admin_auth::AuthError::Internal(message),
        ) => {
            return Err(ApiError::gateway(ErrorCode::BadRequest, message));
        }
    };
    if !changed {
        tracing::info!(
            reason = "invalid credentials",
            "admin password change refused"
        );
        return Err(ApiError::gateway(
            ErrorCode::Auth,
            "current password is incorrect",
        ));
    }
    tracing::info!("admin password changed");
    Ok(json_ok(crate::api::OK.to_owned()))
}

/// `PUT /api/settings/viewer-password`: a string sets it, `null` clears it;
/// either ends viewer sessions only.
async fn viewer_password(app: &App, req: Request<Incoming>) -> Result<Response<Body>, ApiError> {
    require_admin(req.headers(), &app.admin).await?;
    let body = read_json(req, app.idle_timeout).await?;
    // `readJsonRecord`: any object (arrays included); `"password" in body`.
    let field = match &body {
        JsValue::Object(fields) => fields
            .iter()
            .rev()
            .find(|(k, _)| k.iter().copied().eq("password".encode_utf16()))
            .map(|(_, v)| v),
        JsValue::Array(_) => None,
        _ => {
            return Err(ApiError::gateway(
                ErrorCode::BadRequest,
                "password is required, and may be null",
            ));
        }
    };
    let password = match field {
        None => {
            return Err(ApiError::gateway(
                ErrorCode::BadRequest,
                "password is required, and may be null",
            ));
        }
        Some(JsValue::Null) => None,
        // Hashed as its UTF-8 encoding: a lone surrogate is U+FFFD, as
        // Argon2 sees it in TS too. The length rule counts UTF-16 units.
        Some(JsValue::String(units)) => Some(units.clone()),
        Some(_) => {
            return Err(ApiError::gateway(
                ErrorCode::BadRequest,
                "password must be a string or null",
            ));
        }
    };
    let cleared = password.is_none();
    let text = password.as_deref().map(String::from_utf16_lossy);
    match app.admin.set_viewer_password(text.as_deref()).await {
        Ok(()) => {}
        Err(
            crate::admin_auth::AuthError::Password(message)
            | crate::admin_auth::AuthError::Internal(message),
        ) => return Err(ApiError::gateway(ErrorCode::BadRequest, message)),
    }
    tracing::info!(
        "{}",
        if cleared {
            "viewer access removed"
        } else {
            "viewer password set"
        }
    );
    Ok(json_ok(crate::api::OK.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::Method;

    #[test]
    fn frozen_resource_publisher_routes() {
        for (method, path, topic) in [
            (Method::POST, "/api/credentials", "res:credentials"),
            (Method::PATCH, "/api/credentials/c", "res:credentials"),
            (Method::DELETE, "/api/credentials/c", "res:credentials"),
            (Method::PUT, "/api/models/m", "res:models"),
            (Method::DELETE, "/api/models/m", "res:models"),
            (Method::POST, "/api/keys", "res:keys"),
            (Method::PUT, "/api/keys/k/limits", "res:keys"),
            (Method::PUT, "/api/keys/k/models", "res:keys"),
            (Method::PUT, "/api/keys/k/expiry", "res:keys"),
            (Method::PUT, "/api/keys/k/guardrail", "res:keys"),
            (Method::PUT, "/api/keys/k/smart-routing", "res:keys"),
            (Method::DELETE, "/api/keys/k", "res:keys"),
            (Method::PUT, "/api/settings/viewer-password", "res:settings"),
            (Method::PUT, "/api/settings", "res:settings"),
        ] {
            assert_eq!(
                route(&method, path)
                    .expect("publisher route")
                    .resource_topic(),
                Some(topic),
                "{method} {path}"
            );
        }
        for (method, path) in [
            (Method::PUT, "/api/settings/password"),
            (Method::GET, "/api/settings"),
            (Method::POST, "/api/connect/start"),
            (Method::POST, "/api/connect/finish"),
            (Method::POST, "/api/connect/poll"),
        ] {
            assert_eq!(
                route(&method, path)
                    .expect("non-publisher route")
                    .resource_topic(),
                None,
                "{method} {path}"
            );
        }
    }

    #[test]
    fn cancelled_queued_open_keeps_its_permit() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let dir = tempfile::tempdir().expect("dir");
            let control =
                ControlStore::new(SqliteStore::open(dir.path().join("db"), 0).expect("store"));
            let (tx, rx) = std::sync::mpsc::channel();
            let (entered, ready) = tokio::sync::oneshot::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                entered.send(()).expect("observer");
                rx.recv().expect("release");
            });
            ready.await.expect("entered");
            let c = control.clone();
            let open = tokio::spawn(async move { c.reader().await });
            while control.4.available_permits() == 4 {
                tokio::task::yield_now().await;
            }
            open.abort();
            assert!(open.await.is_err());
            let available = control.4.available_permits();
            tx.send(()).expect("release");
            blocker.await.expect("blocker");
            // Drain the queued opener before asserting (also on RED).
            tokio::task::spawn_blocking(|| {}).await.expect("drain");
            assert_eq!(available, 3, "queued opener must retain its permit");
            assert_eq!(control.4.available_permits(), 4);
        });
    }

    #[test]
    fn routes_match_elysia_s_table() {
        let r = |m: Method, p: &str| route(&m, p);
        assert_eq!(r(Method::GET, "/api/models"), Some(Admin::ListModels));
        assert_eq!(r(Method::HEAD, "/api/models"), Some(Admin::ListModels));
        assert_eq!(r(Method::POST, "/api/models"), None);
        assert_eq!(
            r(Method::PUT, "/api/models/a%2Fb"),
            Some(Admin::PutModel(Some("a/b".into())))
        );
        assert_eq!(
            r(Method::PUT, "/api/models/%ZZ"),
            Some(Admin::PutModel(None))
        );
        assert_eq!(
            r(Method::PUT, "/api/models/%ED%A0%80"),
            Some(Admin::PutModel(None))
        );
        assert_eq!(r(Method::PUT, "/api/models/"), None);
        assert_eq!(r(Method::PUT, "/api/models/a/b"), None);
        assert_eq!(r(Method::GET, "/api/models/x"), None);
        assert_eq!(
            r(Method::DELETE, "/api/models/x"),
            Some(Admin::RemoveModel(Some("x".into())))
        );
        assert_eq!(
            r(Method::PUT, "/api/keys/k/limits"),
            Some(Admin::EditKey(Some("k".into()), KeyEdit::Limits))
        );
        assert_eq!(
            r(Method::PUT, "/api/keys/k/smart-routing"),
            Some(Admin::EditKey(Some("k".into()), KeyEdit::SmartRouting))
        );
        assert_eq!(r(Method::PUT, "/api/keys/k/other"), None);
        assert_eq!(r(Method::PUT, "/api/keys//limits"), None);
        assert_eq!(r(Method::PUT, "/api/keys/k/limits/x"), None);
        assert_eq!(r(Method::POST, "/api/keys/k/limits"), None);
        assert_eq!(
            r(Method::DELETE, "/api/keys/k"),
            Some(Admin::RevokeKey(Some("k".into())))
        );
        assert_eq!(r(Method::DELETE, "/api/keys/k/x"), None);
        assert_eq!(r(Method::GET, "/api/keys/k"), None);
        assert_eq!(r(Method::PUT, "/api/settings"), Some(Admin::PutSettings));
        assert_eq!(r(Method::POST, "/api/settings"), None);
        assert_eq!(
            r(Method::PUT, "/api/settings/password"),
            Some(Admin::Password)
        );
        assert_eq!(
            r(Method::PUT, "/api/settings/viewer-password"),
            Some(Admin::ViewerPassword)
        );
        assert_eq!(r(Method::GET, "/api/settings/password"), None);
    }
}
