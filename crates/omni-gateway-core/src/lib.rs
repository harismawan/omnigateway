//! The gateway's stateful core, which Task 5's binary depends on: boot
//! configuration and `.env` loading, the routing snapshot with its
//! background refresher, and the in-memory rate limiter.

pub mod config;
pub mod dotenv;
pub mod miss;
pub mod ratelimit;
mod ratelimit_judge;
pub mod ratelimit_seed;
pub mod snapshot;
