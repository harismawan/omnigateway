//! A custom OpenAI-compatible endpoint.
//!
//! Forked per provider: no other provider's codec is imported.

pub(crate) mod codec;
pub mod decode;
pub mod wire;

pub use codec::{CustomCodec, Protocol, endpoint_url};

/// The provider id.
pub const ID: &str = "custom";
