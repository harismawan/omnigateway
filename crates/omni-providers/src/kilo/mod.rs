//! Kilo (kilo.ai), served by its codec: OpenAI chat completions plus
//! OpenRouter's reasoning extension, images and PDF file parts carried,
//! always streaming upstream. One host, two paths chosen by credential type.
pub mod codec;
pub mod decode;
pub mod oauth;
pub mod profile;
pub mod wire;
