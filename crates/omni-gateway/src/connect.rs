//! Browser OAuth and process-local coordinator pending state.
use std::sync::Arc;
use omni_coord::{Coord, MemoryCoord};
use omni_ir::{error::{ErrorCode, GatewayError}, jsjson::{JsValue, parse_js, stringify}};
use omni_control::settings_value::{get, trim_units};
use omni_providers::oauth::{PendingFlow, AuthorizeStart};
use crate::{api::{ApiError, read_json, require_admin, json_ok}, server::{App, Body}};
use hyper::{Request, Response, body::Incoming};

type Result<T> = std::result::Result<T, GatewayError>;
const PROVIDERS: &[(&str, &str)] = &[("anthropic", ""), ("openai", "http://localhost:1455/auth/callback")];
fn bad(s: &str) -> GatewayError { GatewayError::new(ErrorCode::BadRequest, s) }
fn internal() -> GatewayError { GatewayError::new(ErrorCode::Internal, "internal error") }
fn text(v: Option<&JsValue>) -> Option<String> { match v { Some(JsValue::String(s)) => Some(String::from_utf16_lossy(s)), _ => None } }
fn string(s: &str) -> JsValue { JsValue::String(s.encode_utf16().collect()) }
fn object(fields: Vec<(&str, JsValue)>) -> JsValue { JsValue::Object(fields.into_iter().map(|(k,v)| (k.encode_utf16().collect(),v)).collect()) }

pub struct ConnectFlows { coord: Arc<dyn Coord> }
impl Default for ConnectFlows {
    fn default() -> Self { Self { coord: Arc::new(MemoryCoord::new(omni_coord::system_clock())) } }
}
impl ConnectFlows {
    async fn pending(&self, id: &str, take: bool) -> Result<JsValue> {
        let key = format!("oauth:pending:{id}");
        let raw = self.coord.kv_get(&key).await.map_err(|_| internal())?.ok_or_else(|| bad("unknown or expired authorization"))?;
        if take { self.coord.kv_del(&key).await.map_err(|_| internal())?; }
        parse_js(&raw).map_err(|_| internal())
    }
    async fn start(&self, app: &App, body: &JsValue) -> Result<String> {
        let provider = text(get(body,"provider"));
        let (provider, redirect) = PROVIDERS.iter().find(|(p,_)| Some(*p)==provider.as_deref()).ok_or_else(|| bad(&format!("provider must be one of {}", PROVIDERS.iter().map(|(p,_)| *p).collect::<Vec<_>>().join(", "))))?;
        let credential = if let Some(v) = get(body,"credentialId") {
            let id = text(Some(v)).ok_or_else(|| bad("invalid credential for reconnect"))?;
            let id = omni_ir::js::trim(&id).to_owned();
            if id.is_empty() { return Err(bad("invalid credential for reconnect")); }
            let row = app.deps.refresher.store.credential(&app.credential_key, &id).await.map_err(|_| internal())?;
            if !row.is_some_and(|r| r.provider==*provider && r.auth_type==omni_store::AuthType::OAuth) { return Err(bad("invalid credential for reconnect")); }
            Some(id)
        } else { None };
        let label = match get(body,"label") { Some(JsValue::String(s)) if !trim_units(s).is_empty() => JsValue::String(trim_units(s).to_vec()), _ => string(provider) };
        let (verifier, challenge) = omni_providers::oauth::pkce();
        let state = omni_providers::oauth::random_state();
        let AuthorizeStart {authorize_url, pending} = if *provider=="openai" { omni_providers::openai::oauth::start(redirect,&verifier,&challenge,&state) } else { omni_providers::anthropic::oauth::start(&verifier,&challenge,&state) };
        let mut fields = vec![("provider",string(provider)),("label",label),("pending",object(vec![("verifier",string(&pending.verifier)),("challenge",string(&pending.challenge)),("state",string(&pending.state)),("redirectUri",string(&pending.redirect_uri))]))];
        if let Some(id)=credential { fields.push(("credentialId",string(&id))); }
        let id = omni_providers::oauth::random_state();
        self.coord.kv_set(&format!("oauth:pending:{id}"), &stringify(&object(fields)).ok_or_else(internal)?,600_000).await.map_err(|_| internal())?;
        Ok(stringify(&object(vec![("flowId",string(&id)),("authorizeUrl",string(&authorize_url)),("userCode",JsValue::Null),("kind",string("pkce")),("supportsManualPaste",JsValue::Bool(true)),("pollIntervalMs",JsValue::Number(5000.0))])).ok_or_else(internal)?)
    }
}
pub async fn serve(app: &App, req: Request<Incoming>, route: &str) -> std::result::Result<Response<Body>,ApiError> {
    require_admin(req.headers(), &app.admin).await?;
    let body = read_json(req, app.idle_timeout).await?;
    let result = match route {
        "start" => app.connect.start(app,&body).await,
        "finish" if text(get(&body,"flowId")).is_none() || text(get(&body,"code")).is_none() => Err(bad("flowId and code are required")),
        "poll" if text(get(&body,"flowId")).is_none() => Err(bad("flowId is required")),
        _ => Err(bad("unknown or expired authorization")),
    };
    result.map(json_ok).map_err(ApiError::Gateway)
}
