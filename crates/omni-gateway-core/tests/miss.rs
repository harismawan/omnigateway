//! The snapshot-miss fallback read: a brand-new key is found, and invalid
//! keys cannot drive store reads (negative cache, coalescing, read budget).

use omni_gateway_core::snapshot::{
    AuthOutcome, MissConfig, MissResolver, MissResult, SnapshotHolder,
};
use omni_store::SqliteStore;
use rusqlite::{Connection, params};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const ENC: &str = "miss-test-encryption-key-01";

fn key_row(c: &Connection, id: &str, raw: &str) {
    c.execute(
        "INSERT INTO api_keys (id, label, prefix, hash, created_at, limits) VALUES (?,?,?,?,0,'{}')",
        params![id, id, omni_crypto::apikey::prefix(raw), omni_crypto::apikey::hash(raw)],
    )
    .expect("key");
}

struct H {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
    holder: Arc<SnapshotHolder>,
    store: Arc<Mutex<SqliteStore>>,
    resolver: Arc<MissResolver>,
}

fn harness(config: MissConfig) -> H {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("omni.db");
    let boot = SqliteStore::open(&path, 0).expect("store");
    let holder = Arc::new(
        SnapshotHolder::build(&boot, omni_crypto::field::derive_key(ENC), 0.0).expect("build"),
    );
    let store = Arc::new(Mutex::new(SqliteStore::open(&path, 0).expect("miss store")));
    let resolver = Arc::new(MissResolver::new(holder.clone(), store.clone(), config));
    H {
        _dir: dir,
        path,
        holder,
        store,
        resolver,
    }
}

fn hash(raw: &str) -> String {
    omni_crypto::apikey::hash(raw)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_brand_new_key_is_found_by_one_read_and_then_served_from_the_snapshot() {
    let h = harness(MissConfig::default());
    key_row(
        &Connection::open(&h.path).expect("c"),
        "k-new",
        "sk-omni-new",
    );
    assert!(matches!(
        h.holder.load().authenticate(Some("sk-omni-new"), 0),
        AuthOutcome::Miss
    ));
    match h.resolver.resolve(&hash("sk-omni-new")).await {
        MissResult::Found(k) => assert_eq!(k.id, "k-new"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        h.holder.load().authenticate(Some("sk-omni-new"), 0),
        AuthOutcome::Ok(_)
    ));
    assert_eq!(h.resolver.reads(), 1);
}

// The store's std mutex is held across awaits on purpose: it is what the
// blocking reads wait on, so holding it keeps them in flight.
#[allow(clippy::await_holding_lock)]
#[tokio::test(flavor = "multi_thread")]
async fn a_repeated_invalid_key_is_read_once() {
    let h = harness(MissConfig::default());
    let garbage = hash("sk-omni-garbage");
    // Sequential repeats hit the negative cache.
    for _ in 0..500 {
        assert!(matches!(
            h.resolver.resolve(&garbage).await,
            MissResult::Absent
        ));
    }
    assert_eq!(h.resolver.reads(), 1);

    // Concurrent repeats of a new garbage key coalesce to one read.
    let other = hash("sk-omni-garbage-2");
    let guard = h.store.lock().expect("lock");
    let tasks: Vec<_> = (0..200)
        .map(|_| {
            let r = h.resolver.clone();
            let k = other.clone();
            tokio::spawn(async move { r.resolve(&k).await })
        })
        .collect();
    tokio::time::sleep(Duration::from_millis(100)).await;
    drop(guard);
    for t in tasks {
        assert!(matches!(t.await.expect("join"), MissResult::Absent));
    }
    assert_eq!(h.resolver.reads(), 2);
}

#[allow(clippy::await_holding_lock)]
#[tokio::test(flavor = "multi_thread")]
async fn a_distinct_invalid_key_flood_never_exceeds_the_read_budget() {
    let h = harness(MissConfig {
        max_reads_in_flight: 3,
        ..MissConfig::default()
    });
    // Hold the store so every admitted read stays in flight.
    let guard = h.store.lock().expect("lock");
    let tasks: Vec<_> = (0..300)
        .map(|i| {
            let r = h.resolver.clone();
            let k = hash(&format!("sk-omni-flood-{i}"));
            tokio::spawn(async move { r.resolve(&k).await })
        })
        .collect();
    let mut shed = 0;
    let mut pending = Vec::new();
    for t in tasks {
        if t.is_finished() {
            if matches!(t.await.expect("join"), MissResult::Shed) {
                shed += 1;
            }
        } else {
            pending.push(t);
        }
    }
    // Everything beyond the budget is refused without waiting for a read.
    for _ in 0..100 {
        if pending.iter().filter(|t| !t.is_finished()).count() <= 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(h.resolver.in_flight() <= 3, "{}", h.resolver.in_flight());
    assert_eq!(h.resolver.in_flight(), 3);
    drop(guard);
    for t in pending {
        if matches!(t.await.expect("join"), MissResult::Shed) {
            shed += 1;
        }
    }
    assert_eq!(h.resolver.reads(), 3);
    assert_eq!(shed, 297);
    assert_eq!(h.resolver.peak_in_flight(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_negative_cache_is_bounded() {
    let h = harness(MissConfig {
        negative_capacity: 50,
        ..MissConfig::default()
    });
    for i in 0..200 {
        assert!(matches!(
            h.resolver.resolve(&hash(&format!("sk-omni-x{i}"))).await,
            MissResult::Absent
        ));
    }
    assert!(
        h.resolver.negative_len() <= 50,
        "{}",
        h.resolver.negative_len()
    );
}

#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn a_negative_entry_expires_after_its_ttl() {
    let h = harness(MissConfig {
        negative_ttl: Duration::from_secs(30),
        ..MissConfig::default()
    });
    let k = hash("sk-omni-ttl");
    let _ = h.resolver.resolve(&k).await;
    tokio::time::advance(Duration::from_secs(29)).await;
    let _ = h.resolver.resolve(&k).await;
    assert_eq!(h.resolver.reads(), 1);
    tokio::time::advance(Duration::from_secs(2)).await;
    let _ = h.resolver.resolve(&k).await;
    assert_eq!(h.resolver.reads(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rebuild_clears_negative_entries_so_a_new_key_is_found() {
    let h = harness(MissConfig::default());
    let k = hash("sk-omni-later");
    assert!(matches!(h.resolver.resolve(&k).await, MissResult::Absent));
    key_row(
        &Connection::open(&h.path).expect("c"),
        "k-later",
        "sk-omni-later",
    );
    // Still negative until a rebuild.
    assert!(matches!(h.resolver.resolve(&k).await, MissResult::Absent));
    assert_eq!(h.resolver.reads(), 1);
    h.holder
        .rebuild(&h.store.lock().expect("lock"))
        .expect("rebuild");
    // The rebuild put the key in the snapshot and cleared the negative.
    assert_eq!(h.resolver.negative_len(), 0);
    assert!(matches!(
        h.holder.load().authenticate(Some("sk-omni-later"), 0),
        AuthOutcome::Ok(_)
    ));
    // And a resolve after the clear would find it too.
    assert!(matches!(h.resolver.resolve(&k).await, MissResult::Found(_)));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_key_created_by_the_cli_authenticates_within_one_refresh_even_after_a_negative() {
    const INTERVAL: Duration = Duration::from_millis(100);
    let h = harness(MissConfig::default());
    let refresher = h
        .holder
        .clone()
        .spawn_refresher(SqliteStore::open(&h.path, 0).expect("s"), INTERVAL);
    let k = hash("sk-omni-cli");
    assert!(matches!(h.resolver.resolve(&k).await, MissResult::Absent));
    assert_eq!(h.resolver.reads(), 1);
    let before = h.holder.generation();
    key_row(
        &Connection::open(&h.path).expect("c"),
        "k-cli",
        "sk-omni-cli",
    );
    let committed = std::time::Instant::now();
    // The next poll sees the commit and swaps: at most one interval, plus
    // the rebuild itself. Bounded at two intervals.
    while h.holder.generation() == before {
        assert!(
            committed.elapsed() < 2 * INTERVAL,
            "no rebuild within two refresh intervals"
        );
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    // Served from the rebuilt snapshot, and the negative no longer applies.
    assert!(matches!(
        h.holder.load().authenticate(Some("sk-omni-cli"), 0),
        AuthOutcome::Ok(_)
    ));
    assert!(matches!(h.resolver.resolve(&k).await, MissResult::Found(_)));
    assert_eq!(h.resolver.reads(), 1, "found in the snapshot, no read");
    refresher.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rebuild_makes_every_earlier_negative_read_again() {
    let h = harness(MissConfig::default());
    let k = hash("sk-omni-still-absent");
    let _ = h.resolver.resolve(&k).await;
    let _ = h.resolver.resolve(&k).await;
    assert_eq!(h.resolver.reads(), 1);
    h.holder
        .rebuild(&h.store.lock().expect("lock"))
        .expect("rebuild");
    let _ = h.resolver.resolve(&k).await;
    assert_eq!(h.resolver.reads(), 2);
}
