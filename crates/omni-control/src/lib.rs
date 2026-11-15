#![forbid(unsafe_code)]
//! Shared operator configuration and storage operations, without gateway runtime.
pub mod admin_password;
pub mod api;
pub mod body_schema;
pub mod catalog;
pub mod client_quota;
pub mod config;
pub mod credentials;
#[cfg(test)]
mod http_oracle_tests;
pub mod keys;
pub mod logs;
mod model_schema;
pub mod models;
pub mod operator_json;
pub mod plugins;
pub mod reports;
pub mod settings;
pub mod settings_value;
