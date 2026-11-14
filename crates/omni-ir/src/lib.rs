//! Provider-neutral domain model and the JS-compatible JSON writer.
//!
//! Uses serde JSON, stack-safe deep-value helpers and ECMAScript number formatting.
//!
//! # Deep values
//! Untrusted deeply nested JSON must enter through ingest or provider codecs;
//! plain serde `Deserialize` straight into IR types is unsupported at such
//! depths. Derived `Debug` and `PartialEq` also require a suitable deep scope.
//! Owned IR fields have iterative release, but replacing a public raw
//! `Value`/`Map` directly bypasses that protection: use `deep::insert`,
//! `deep::replace` and the iterative drop helpers instead.

pub mod deep;
pub mod error;
pub mod js;
pub mod jsc_json;
pub mod jsjson;
pub mod request;
pub mod stream;
pub mod text;
pub mod tokens;
