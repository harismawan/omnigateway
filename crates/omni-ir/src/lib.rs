//! Provider-neutral domain model and the JS-compatible JSON writer.
//!
//! Uses serde JSON, stack-safe deep-value helpers and ECMAScript number formatting.

pub mod deep;
pub mod error;
pub mod js;
pub mod jsjson;
pub mod request;
pub mod stream;
pub mod tokens;
