//! Kimi (Moonshot), served by its codec: tools only, always streaming
//! upstream, with a synthetic device identity bound to the credential.
pub mod codec;
pub mod decode;
pub mod device;
pub mod oauth;
pub mod profile;
pub mod wire;
