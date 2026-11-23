//! Muse (Meta Model API): a Responses-shaped front door whose inference
//! credential is a Model API key minted from an RFC 8628 device grant.
pub mod codec;
pub mod decode;
pub mod endpoint;
pub mod oauth;
pub mod profile;
pub mod wire;
