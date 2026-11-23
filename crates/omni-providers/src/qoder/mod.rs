//! Qoder: a Cosy-signed, body-encoded chat wire whose inference credential is
//! a bundle minted by a local-begin device flow (PKCE + a synthetic machine
//! identity), finished through userinfo, endpoint election and a signed model
//! listing. The catalog is dynamic: it rides on `providerData.modelCatalog`.
pub mod codec;
pub mod credential;
pub mod crypto;
pub mod decode;
pub mod endpoint;
pub mod model_catalog;
pub mod oauth;
pub mod profile;
pub mod wire;
