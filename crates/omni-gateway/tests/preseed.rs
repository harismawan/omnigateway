//! A limited key created after boot is pre-seeded when the refresher brings it in.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use omni_gateway_core::ratelimit::RateLimiter;
use omni_gateway_core::snapshot::SnapshotHolder;
use omni_store::SqliteStore;

#[tokio::test(flavor = "multi_thread")]
async fn a_limited_key_added_by_a_refresh_is_preseeded() {
    let f = fixture(&["c0"]);
    let store = SqliteStore::open(&f.path, 0).expect("store");
    let holder = Arc::new(SnapshotHolder::build(&store, key(), 0.0).expect("build"));
    let limiter = RateLimiter::new();
    let _refresher = holder
        .clone()
        .spawn_refresher(store, Duration::from_millis(20));
    let _preseeder =
        omni_gateway::spawn_preseeder(holder.clone(), limiter.clone(), Duration::from_millis(20));
    assert_eq!(limiter.seeds_pending(), 0);
    rusqlite::Connection::open(&f.path)
        .expect("open")
        .execute(
            "INSERT INTO api_keys (id, label, prefix, hash, created_at, limits)
             VALUES ('kn','kn','sk-omni-new','h',0,'{\"tokens\":{\"5h\":100}}')",
            [],
        )
        .expect("key");
    let mut waited = 0;
    while limiter.seeds_pending() == 0 && waited < 50 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        waited += 1;
    }
    // The key-wide subject's long windows (5h and 1w) were asked for.
    assert_eq!(limiter.seeds_pending(), 2);
    // An unlimited key brings in nothing.
    rusqlite::Connection::open(&f.path)
        .expect("open")
        .execute(
            "INSERT INTO api_keys (id, label, prefix, hash, created_at) VALUES ('ku','ku','sk-omni-unl','h2',0)",
            [],
        )
        .expect("key");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(limiter.seeds_pending(), 2);
}
