//! `packages/coord/test/memory.test.ts`, ported: the memory-only properties.

mod common;

use common::{ManualClock, T0};
use omni_coord::{Coord, MemoryCoord};

/// The idle-ring sweep is time-gated, and the gate must not turn into
/// "never" — including after a backward clock step.
#[tokio::test]
async fn drops_a_drained_ring_once_per_interval_and_survives_a_clock_step() {
    let coord = MemoryCoord::new(ManualClock::at(T0).clock());
    coord.window_claim("a", 60_000.0, T0).await;
    coord.window_claim("b", 60_000.0, T0 + 500.0).await;
    assert_eq!(coord.live_windows(), 2);
    // `a` aged out, `b` has not; this claim sweeps.
    coord.window_claim("c", 60_000.0, T0 + 60_001.0).await;
    assert_eq!(coord.live_windows(), 2);
    // `b` droppable now, but inside the interval that just swept.
    coord.window_claim("c", 60_000.0, T0 + 60_501.0).await;
    assert_eq!(coord.live_windows(), 2);
    // Exactly the interval on, and `b` goes.
    coord.window_claim("c", 60_000.0, T0 + 61_001.0).await;
    assert_eq!(coord.live_windows(), 1);
    // Clock steps back an hour: the latch must not hold the sweep off.
    let back = T0 - 3_600_000.0;
    coord.window_claim("x", 60_000.0, back).await;
    coord.window_claim("y", 60_000.0, back + 60_001.0).await;
    assert_eq!(coord.live_windows(), 2);
}

/// Expiry applies in memory too: an unnamed slot lapses at its TTL while its
/// holder is still running, at exactly the expiry.
#[tokio::test]
async fn a_gauge_slot_expires_while_its_holder_is_still_live() {
    let clock = ManualClock::at(T0);
    let coord = MemoryCoord::new(clock.clock());
    let ttl = 300_000;
    assert_eq!(coord.gauge_acquire("lim:k", ttl, None).await, Ok(0));
    assert_eq!(coord.gauge_read("lim:k").await, 1);
    clock.set(T0 + 300_001.0);
    assert_eq!(coord.gauge_read("lim:k").await, 0);
    assert_eq!(coord.gauge_acquire("lim:k", ttl, None).await, Ok(0));

    clock.set(T0);
    let fresh = MemoryCoord::new(clock.clock());
    fresh
        .gauge_acquire("lim:j", ttl, None)
        .await
        .expect("acquire");
    clock.set(T0 + 299_999.0);
    assert_eq!(fresh.gauge_read("lim:j").await, 1);
    clock.set(T0 + 300_000.0);
    assert_eq!(fresh.gauge_read("lim:j").await, 0);
}

/// A named slot renewed inside its TTL holds its ceiling indefinitely.
#[tokio::test]
async fn a_renewed_slot_holds_its_ceiling_past_any_number_of_ttls() {
    let clock = ManualClock::at(T0);
    let coord = MemoryCoord::new(clock.clock());
    let ttl = 300_000;
    assert_eq!(
        coord.gauge_acquire("lim:k", ttl, Some("req-1")).await,
        Ok(0)
    );
    for _ in 0..60 {
        clock.advance(100_000.0);
        coord
            .gauge_renew("lim:k", "req-1", ttl)
            .await
            .expect("renew");
        assert_eq!(coord.gauge_read("lim:k").await, 1);
    }
    assert_eq!(
        coord.gauge_acquire("lim:k", ttl, Some("req-2")).await,
        Ok(1)
    );
    coord
        .gauge_release("lim:k", Some("req-1"))
        .await
        .expect("release");
    assert_eq!(coord.gauge_read("lim:k").await, 1);
    coord
        .gauge_release("lim:k", Some("req-2"))
        .await
        .expect("release");
    assert_eq!(coord.gauge_read("lim:k").await, 0);
}

/// Re-acquiring moves rather than stacks and excludes itself; renewing a
/// released or lapsed slot never resurrects it.
#[tokio::test]
async fn a_named_slot_is_idempotent_self_excluding_and_never_resurrected() {
    let clock = ManualClock::at(T0);
    let coord = MemoryCoord::new(clock.clock());
    let ttl = 1_000;
    assert_eq!(coord.gauge_acquire("g", ttl, Some("a")).await, Ok(0));
    assert_eq!(coord.gauge_acquire("g", ttl, Some("a")).await, Ok(0));
    assert_eq!(coord.gauge_read("g").await, 1);
    assert_eq!(coord.gauge_acquire("g", ttl, Some("b")).await, Ok(1));
    assert_eq!(coord.gauge_acquire("g", ttl, Some("a")).await, Ok(1));
    assert_eq!(coord.gauge_read("g").await, 2);
    coord.gauge_release("g", Some("a")).await.expect("release");
    assert_eq!(coord.gauge_read("g").await, 1);
    coord.gauge_renew("g", "a", ttl).await.expect("renew");
    assert_eq!(coord.gauge_read("g").await, 1);
    clock.set(T0 + 1_001.0);
    assert_eq!(coord.gauge_read("g").await, 0);
    coord.gauge_renew("g", "b", ttl).await.expect("renew");
    assert_eq!(coord.gauge_read("g").await, 0);
}

/// The visibility property, memory's way: every call's effect is in place
/// when its future first resolves, without a yield in between.
#[tokio::test]
async fn every_memory_call_completes_on_its_first_poll() {
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};
    let coord = MemoryCoord::new(ManualClock::at(T0).clock());
    let mut cx = Context::from_waker(Waker::noop());
    let claim = pin!(coord.window_claim("k", 60_000.0, T0));
    assert!(matches!(claim.poll(&mut cx), Poll::Ready(_)));
    let gauge = pin!(coord.gauge_acquire("g", 1_000, None));
    assert!(matches!(gauge.poll(&mut cx), Poll::Ready(Ok(0))));
}

/// I4: the frozen TS `memoryCoord` window, observed (Bun, `packages/coord`):
/// claims at 1000, 999 (backdated), rollback 999, 1001, 998, rollback 1000,
/// 1002, 61000, 61002 report `used` 0,1,1,2,3,3,1 and `resetAt`
/// 1000,61000,61000,61000,61000,61001,121000. A backdated claim is a finite
/// count, rollback removes that claim, and TS's arrival-order scan makes the
/// last rollback (behind a later, smaller stamp) a no-op.
#[tokio::test]
async fn window_semantics_match_ts_for_backdated_claims_and_rollback() {
    let coord = MemoryCoord::new(ManualClock::at(0.0).clock());
    let w = 60_000.0;
    let mut got = Vec::new();
    let claim = async |at: f64| {
        let c = coord.window_claim("k", w, at).await;
        assert_eq!(c.stamp, at);
        (c.before.used, c.before.reset_at)
    };
    got.push(claim(1_000.0).await);
    got.push(claim(999.0).await);
    coord.window_rollback("k", 999.0).await;
    got.push(claim(1_001.0).await);
    got.push(claim(998.0).await);
    coord.window_rollback("k", 1_000.0).await;
    got.push(claim(1_002.0).await);
    got.push(claim(61_000.0).await);
    got.push(claim(61_002.0).await);
    assert_eq!(
        got,
        vec![
            (0.0, 1_000.0),
            (1.0, 61_000.0),
            (1.0, 61_000.0),
            (2.0, 61_000.0),
            (3.0, 61_000.0),
            (3.0, 61_001.0),
            (1.0, 121_000.0),
        ]
    );
}

/// I4: rollback stays exact however many distinct stamps a window holds
/// below the per-key cap (the reused ring compacted past 65 536 and then
/// ignored every rollback).
#[tokio::test]
async fn rollback_stays_exact_with_many_distinct_live_stamps() {
    let coord = MemoryCoord::new(ManualClock::at(0.0).clock());
    let w = 3_600_000.0;
    for i in 0..70_000 {
        coord.window_claim("k", w, f64::from(i)).await;
    }
    coord.window_rollback("k", 69_999.0).await;
    let next = coord.window_claim("k", w, 70_000.0).await;
    assert_eq!(next.before.used, 69_999.0);
}

/// M2: non-finite inputs behave as the frozen TS does. Recorded from Bun
/// (`/tmp/opencode/d2-fix2/ts-window-nan.out`): claims at 1000, NaN, 30000,
/// 2000, rollback NaN, 65000, 70000, 200000 give (used, resetAt)
/// (0,1000) (0,NaN) (0,30000) (1,90000) (2,90000) (3,90000) (0,200000).
#[tokio::test]
async fn non_finite_stamps_behave_as_ts() {
    let coord = MemoryCoord::new(ManualClock::at(0.0).clock());
    let w = 60_000.0;
    let mut got = Vec::new();
    for at in [1_000.0, f64::NAN, 30_000.0, 2_000.0] {
        let c = coord.window_claim("k", w, at).await;
        got.push((c.before.used, c.before.reset_at));
    }
    coord.window_rollback("k", f64::NAN).await;
    for at in [65_000.0, 70_000.0, 200_000.0] {
        let c = coord.window_claim("k", w, at).await;
        got.push((c.before.used, c.before.reset_at));
    }
    let want = [
        (0.0, 1_000.0),
        (0.0, f64::NAN),
        (0.0, 30_000.0),
        (1.0, 90_000.0),
        (2.0, 90_000.0),
        (3.0, 90_000.0),
        (0.0, 200_000.0),
    ];
    assert_eq!(got.len(), want.len());
    for (i, ((u, r), (wu, wr))) in got.iter().zip(want.iter()).enumerate() {
        assert_eq!(u, wu, "claim {i}");
        assert!(
            r == wr || (r.is_nan() && wr.is_nan()),
            "claim {i}: {r} vs {wr}"
        );
    }
}

/// M2: the cap boundary. Exactly `WINDOW_KEY_CAP` claims are stored; the
/// next is answered with the true count but not stored (fail-open); once
/// stamps age out, claims are stored again.
#[tokio::test]
async fn the_window_cap_fails_open_and_recovers() {
    use omni_coord::memory::WINDOW_KEY_CAP;
    let coord = MemoryCoord::new(ManualClock::at(0.0).clock());
    let w = 1_000_000.0;
    let cap = WINDOW_KEY_CAP as f64;
    for i in 0..WINDOW_KEY_CAP {
        coord.window_claim("k", w, i as f64).await;
    }
    // At the cap: answered with the full count, not stored.
    let over = coord.window_claim("k", w, cap).await;
    assert_eq!(over.before.used, cap);
    let next = coord.window_claim("k", w, cap + 1.0).await;
    assert_eq!(next.before.used, cap, "the over-cap claim was not stored");
    // Rolling back the unstored claim finds nothing to remove...
    coord.window_rollback("k", cap).await;
    assert_eq!(coord.window_claim("k", w, cap + 2.0).await.before.used, cap);
    // ...except when a stored claim shares its stamp: then that one goes.
    coord.window_rollback("k", cap - 1.0).await;
    assert_eq!(
        coord.window_claim("k", w, cap + 3.0).await.before.used,
        cap - 1.0
    );
    // That freed slot was taken by the claim just made (stored).
    assert_eq!(coord.window_claim("k", w, cap + 4.0).await.before.used, cap);
    // Expiry: stamps 0..=half age out (`stamp <= now - w`), and claims are
    // stored again: each new claim adds one, in a window where nothing else
    // ages between the two.
    let half = (WINDOW_KEY_CAP / 2) as f64;
    let later = w + half;
    let after = coord.window_claim("k", w, later).await;
    assert!(
        after.before.used < cap && after.before.used > 0.0,
        "{}",
        after.before.used
    );
    // Same instant: nothing more ages out, so the count is exactly one more.
    let again = coord.window_claim("k", w, later).await;
    assert_eq!(
        again.before.used,
        after.before.used + 1.0,
        "stored again below the cap"
    );
}

/// M2: duplicate stamps below the cap: rollback removes exactly one.
#[tokio::test]
async fn rollback_of_a_duplicated_stamp_removes_exactly_one() {
    let coord = MemoryCoord::new(ManualClock::at(0.0).clock());
    for _ in 0..3 {
        coord.window_claim("k", 60_000.0, 5.0).await;
    }
    coord.window_rollback("k", 5.0).await;
    assert_eq!(
        coord.window_claim("k", 60_000.0, 6.0).await.before.used,
        2.0
    );
}

/// M2 (r2 review precision): a claim made *over* the cap with the same
/// stamp as a stored one is not stored; rolling it back removes the stored
/// duplicate — the count drops by one more than the claims stored, the
/// documented fail-open approximation.
#[tokio::test]
async fn rollback_of_a_skipped_over_cap_duplicate_removes_the_stored_one() {
    use omni_coord::memory::WINDOW_KEY_CAP;
    let coord = MemoryCoord::new(ManualClock::at(0.0).clock());
    let w = 1_000_000.0;
    let cap = WINDOW_KEY_CAP as f64;
    for i in 0..WINDOW_KEY_CAP {
        coord.window_claim("k", w, i as f64).await;
    }
    let dup = cap - 1.0;
    // Over the cap, stamped like the last stored claim: answered, not stored.
    assert_eq!(coord.window_claim("k", w, dup).await.before.used, cap);
    coord.window_rollback("k", dup).await;
    // The stored claim at `dup` went in its place.
    assert_eq!(coord.window_claim("k", w, cap).await.before.used, cap - 1.0);
}
