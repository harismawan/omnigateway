//! Provider codecs, the SSE parser and the order-preserving outbound HTTP client.
//!
//! - [`http`]: the keep-alive HTTP/1.1 client writing headers exactly as
//!   `node:http` does.
//! - [`sse`]: the incremental SSE parser.
//! - [`codec`] and [`adapter`]: the provider codec contract and its host
//!   (`codecAdapter.ts`), with [`http_error`] classifying failed responses.
//! - [`custom`]: the custom OpenAI-compatible provider.

pub mod adapter;
pub mod anthropic;
pub mod codec;
pub mod custom;
pub mod http;
pub mod http_error;
pub mod oauth;
pub mod response_format;
pub mod sse;
pub mod system;
pub mod tool_result_files;

pub use adapter::{AdapterRequest, AdapterResult, EventStream, SendError, send};
pub use codec::Credentials;
