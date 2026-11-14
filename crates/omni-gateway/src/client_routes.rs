//! The key holder's HTTP surface (frozen `routes/client.ts`).

use hyper::body::Incoming;
use hyper::{Request, Response};
use omni_ir::error::ErrorCode;

use crate::api::{self, ApiError};
use crate::server::{App, Body};

pub async fn login(app: &App, req: Request<Incoming>) -> Result<Response<Body>, ApiError> {
    let headers = req.headers().clone();
    let fields = api::read_json_fields(req, app.idle_timeout, &["key"]).await?;
    let token = match fields.string("key") {
        Some(key) => app.admin.login_client(key).await?,
        None => None,
    };
    let Some(token) = token else {
        tracing::info!(reason = "invalid credentials", "client login failed");
        return Err(ApiError::new(ErrorCode::Auth, "invalid api key"));
    };
    tracing::info!("client login succeeded");
    let cookie = api::session_cookie(
        &headers,
        app.base_url_https,
        &token,
        app.admin.max_age_secs(),
    );
    Ok(api::json(200, "{\"ok\":true}".to_owned(), Some(cookie)))
}
