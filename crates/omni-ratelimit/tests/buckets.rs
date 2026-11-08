//! The time buckets the long windows are summed from: `memoryCoord().buckets`
//! in `packages/coord/src/index.ts`.

use omni_ratelimit::buckets::{Buckets, Counts};

const MINUTE: f64 = 60_000.0;
const FIVE_HOURS: f64 = 5.0 * 60.0 * MINUTE;

fn counts(requests: f64, tokens: f64, cost_usd: f64) -> Counts {
    Counts {
        requests,
        tokens,
        cost_usd,
    }
}

#[test]
fn an_unseeded_picture_sums_to_none_and_ignores_adds() {
    let mut b = Buckets::new(MINUTE, FIVE_HOURS);
    assert_eq!(b.sum(1_000.0), None);
    b.add(1_000.0, counts(1.0, 10.0, 0.5));
    assert_eq!(b.sum(1_000.0), None);
    assert!(!b.is_seeded());
}

#[test]
fn a_seeded_picture_sums_its_rows_plus_what_was_added() {
    let mut b = Buckets::new(MINUTE, FIVE_HOURS);
    b.seed(
        10_020_000.0,
        &[
            (10_000_000.0 - MINUTE, counts(2.0, 40.0, 1.0)),
            (10_000_000.0, counts(1.0, 5.0, 0.25)),
        ],
    );
    assert_eq!(b.sum(10_020_000.0), Some(counts(3.0, 45.0, 1.25)));
    b.add(10_020_000.0, counts(1.0, 60.0, 0.0));
    assert_eq!(b.sum(10_020_000.0), Some(counts(4.0, 105.0, 1.25)));
}

#[test]
fn a_bucket_ages_out_only_once_its_whole_grain_is_behind_the_window() {
    let t0 = 10_020_000.0;
    let mut b = Buckets::new(MINUTE, FIVE_HOURS);
    b.seed(t0, &[(t0 - FIVE_HOURS, counts(1.0, 100.0, 0.0))]);
    assert_eq!(b.sum(t0).map(|c| c.tokens), Some(100.0));
    assert_eq!(b.sum(t0 + 59_999.0).map(|c| c.tokens), Some(100.0));
    assert_eq!(b.sum(t0 + 60_000.0).map(|c| c.tokens), Some(0.0));
    // Seeded status survives an empty picture.
    assert!(b.is_seeded());
}

#[test]
fn a_row_is_filed_under_the_start_of_its_grain() {
    let mut b = Buckets::new(MINUTE, FIVE_HOURS);
    b.seed(0.0, &[]);
    b.add(59_999.0, counts(1.0, 0.0, 0.0));
    b.add(60_000.0, counts(1.0, 0.0, 0.0));
    // Both land in their own minute: 59_999 in bucket 0, 60_000 in bucket 1.
    // Bucket 0 lives until its whole grain is behind `now - 5h`.
    assert_eq!(b.sum(FIVE_HOURS + 59_999.0).map(|c| c.requests), Some(2.0));
    assert_eq!(b.sum(FIVE_HOURS + 60_000.0).map(|c| c.requests), Some(1.0));
}
