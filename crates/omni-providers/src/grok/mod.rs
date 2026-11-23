//! Grok (xAI), served by its codec: a Responses-shaped surface on two hosts
//! (the cli-chat-proxy for OAuth, api.x.ai for API keys), with a synthetic
//! agent identity bound to the credential at connect time.
pub mod codec;
pub mod decode;
pub mod device;
pub mod oauth;
pub mod profile;
pub mod wire;
