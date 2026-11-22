//! The gateway's stateful core, which Task 5's binary depends on: boot
//! configuration, the routing snapshot with its background refresher, and
//! the in-memory rate limiter.
//!
//! The gateway reads **no implicit `.env`** (spec ruling): the shipped TS
//! binary is compiled with `autoloadDotenv: false`, and `omni start` /
//! `omni service` hand the root's `.env` over explicitly. Configuration is
//! the process environment only.

pub mod buckets;
pub mod config;
pub mod miss;
pub mod ratelimit;
mod ratelimit_judge;
pub mod ratelimit_seed;
pub mod snapshot;
