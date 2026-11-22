//! Contract tests for the rate-limit seed reads: bucket sums and capped
//! newest stamps (`usage::sum_buckets`, `usage::done_stamps`), on one file.

mod common;

use omni_store::SqliteStore;
use omni_store::usage::{done_stamps, seed_rows};
use rusqlite::params;
const T0: i64 = 1_794_000_000_000;
const HOUR: i64 = 3_600_000;

/// The seed payload is bounded in SQL: the newest capped stamps are selected,
/// then returned ascending, matching debit eviction. Nothing per-request
/// beyond the instant is selected; truncation may delay the reported reset.
#[test]
fn seed_stamps_are_capped_in_the_query_and_keep_the_newest() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = SqliteStore::open(dir.path().join("omni.db"), 0).expect("open");
    let c = store.connection();
    for i in 0..50_i64 {
        c.execute(
            "INSERT INTO request_logs (id, at, api_key_id, requested_model, status, duration_ms)
             VALUES (?,?,'k1','fast',200,1)",
            params![format!("r{i}"), T0 - 1000 + (49 - i) * 10],
        )
        .expect("row");
    }
    let stamps = done_stamps(c, "k1", T0 - 5 * HOUR, None, 7).expect("stamps");
    assert_eq!(stamps.len(), 7);
    assert_eq!(stamps[0], T0 - 1000 + 430);
    assert_eq!(stamps[6], T0 - 1000 + 490);
    // Eight rows remain: the omitted head still matters even after most rows
    // expire. At 425 only seven remain and the retained head is exact again.
    assert_eq!(
        done_stamps(c, "k1", T0 - 580, None, 100)
            .expect("live")
            .len(),
        8
    );
    assert_eq!(
        done_stamps(c, "k1", T0 - 575, None, 100).expect("recovery"),
        stamps
    );
    assert_eq!(
        done_stamps(c, "k1", T0 - 5 * HOUR, Some("fast"), 7).expect("model"),
        stamps
    );
    // Once older omitted rows expire, the retained head is exact again.
    for offset in [430, 480, 490, 500] {
        let since = T0 - 1000 + offset;
        let fresh = done_stamps(c, "k1", since, None, 7).expect("expiry");
        let retained: Vec<_> = stamps.iter().copied().filter(|s| *s >= since).collect();
        assert_eq!(fresh, retained);
    }
    let (buckets, capped) = seed_rows(c, "k1", T0 - 5 * HOUR, 60_000, None, 7).expect("seed");
    assert_eq!(capped, stamps);
    // The aggregate still counts every row, whatever the stamp cap.
    let total: f64 = buckets.iter().map(|(_, c)| c.requests).sum();
    assert_eq!(total, 50.0);
}
