#![forbid(unsafe_code)]
//! Shared operator configuration and storage operations, without gateway runtime.
pub mod admin_password;
pub mod catalog;
pub mod config;
pub mod keys;
mod model_schema;
pub mod models;
pub mod operator_json;
pub mod plugins;
pub mod settings;
pub mod settings_value;
