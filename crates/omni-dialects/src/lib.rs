//! The three client dialects the gateway speaks.
//!
//! - [`ingress`]: parse and validate a client body into the IR
//!   ([`omni_ir::request::ChatRequest`]), refusing with the exact
//!   `BAD_REQUEST` messages the TS gateway sends.
//! - [`egress`]: render IR results back to each dialect, streaming (an
//!   incremental SSE encoder writing into a caller-owned buffer) and
//!   non-streaming, plus each dialect's error body and rate-limit headers.
//!
//! Everything here is a pure function of its inputs: ids, clocks and the
//! tool-use id minter are passed in.

pub mod egress;
pub mod ingress;
