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
