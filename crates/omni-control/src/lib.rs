#![forbid(unsafe_code)]
//! Shared operator configuration and storage operations, without gateway runtime.
pub mod admin_password;
pub mod api;
pub mod bodies;
pub mod body_schema;
pub mod catalog;
pub mod cli_cell;
pub mod cli_error;
pub mod client_quota;
pub mod config;
pub mod credentials;
pub mod database;
pub mod database_fs;
pub mod date;
pub mod diagnostics;
pub mod dry_run;
pub mod fs_error;
#[cfg(test)]
mod http_oracle_tests;
pub mod keys;
pub mod logs;
mod model_schema;
pub mod models;
pub mod operator_json;
pub mod plugins;
pub mod quota_ops;
pub mod quota_runtime;
pub mod reports;
pub mod settings;
pub mod settings_value;
pub mod setup;
