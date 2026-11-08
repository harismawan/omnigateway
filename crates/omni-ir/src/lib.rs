//! Provider-neutral domain model and the JS-compatible JSON writer.
//!
//! Depends on nothing but `serde_json`, mirroring `@omni/ir`.

pub mod error;
pub mod js;
pub mod jsjson;
pub mod request;
pub mod stream;
pub mod tokens;
