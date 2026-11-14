#![forbid(unsafe_code)]
//! Shared operator configuration and storage operations, without gateway runtime.
pub mod admin_password;
pub mod api;
pub mod body_schema;
pub mod catalog;
pub mod config;
pub mod credentials;
pub mod database;
pub mod date;
pub mod fs_error;
#[cfg(test)]
mod http_oracle_tests;
pub mod keys;
mod model_schema;
pub mod models;
pub mod operator_json;
pub mod plugins;
pub mod settings;
pub mod settings_value;
