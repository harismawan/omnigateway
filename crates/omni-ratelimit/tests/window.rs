//! Port of `packages/ratelimit/test/window.test.ts`.

use omni_ratelimit::window::SlidingWindow;

const MINUTE: f64 = 60_000.0;

#[test]
fn arbitrary_limit_increases_do_not_lose_history() {
    for size in [3_u32, 65_536, 65_537] {
        let mut w = SlidingWindow::with_limit(MINUTE, None);
        for i in 0..size {
            w.record(f64::from(i) * 0.25);
        }
        for limit in [1, 2, u64::from(size) + 100, 0] {
            w.set_limit(Some(limit));
            assert_eq!(w.count(20_000.0), size as usize);
            assert!(w.retained() <= SlidingWindow::MAX_ENTRIES);
        }
        w.set_limit(None);
        assert_eq!(w.count(20_000.0), size as usize);
        assert_eq!(w.count(80_000.0), 0);
        w.record(80_000.0);
        assert_eq!(w.count(139_999.0), 1);
        assert_eq!(w.reset_at(139_999.0), 140_000.0);
        assert_eq!(w.count(140_000.0), 0);
    }
}

#[test]
fn a_window_counts_only_what_has_not_aged_out() {
    let mut w = SlidingWindow::new(MINUTE);
    w.record(1_000.0);
    w.record(2_000.0);
    assert_eq!(w.count(2_000.0), 2);
    assert_eq!(w.count(61_000.0), 1);
    assert_eq!(w.count(62_000.0), 0);
}

#[test]
fn an_event_exactly_one_window_old_is_out_and_one_tick_younger_is_in() {
    let mut w = SlidingWindow::new(MINUTE);
    w.record(0.0);
    assert_eq!(w.count(59_999.0), 1);
    assert_eq!(w.count(60_000.0), 0);
}

#[test]
fn a_burst_on_either_side_of_a_minute_boundary_is_one_window_not_two() {
    let mut w = SlidingWindow::new(MINUTE);
    for _ in 0..60 {
        w.record(59_000.0);
    }
    assert_eq!(w.count(61_000.0), 60);
    assert_eq!(w.count(119_000.0), 0);
}

#[test]
fn reset_is_when_the_oldest_held_event_ages_out() {
    let mut w = SlidingWindow::new(MINUTE);
    w.record(59_000.0);
    w.record(59_500.0);
    w.count(59_600.0);
    assert_eq!(w.reset_at(59_600.0), 119_000.0);
}

#[test]
fn an_empty_window_resets_now() {
    let mut w = SlidingWindow::new(MINUTE);
    assert_eq!(w.reset_at(5_000.0), 5_000.0);
    w.record(1_000.0);
    w.count(70_000.0);
    assert_eq!(w.reset_at(70_000.0), 70_000.0);
}

#[test]
fn forget_drops_the_event_recorded_at_that_instant_not_the_newest_one() {
    let mut w = SlidingWindow::new(MINUTE);
    w.record(1_000.0);
    w.record(5_000.0);
    w.forget(1_000.0);
    assert_eq!(w.count(5_000.0), 1);
    assert_eq!(w.reset_at(5_000.0), 65_000.0);
}

#[test]
fn forget_takes_one_slot_per_call() {
    let mut w = SlidingWindow::new(MINUTE);
    for _ in 0..3 {
        w.record(1_000.0);
    }
    w.forget(1_000.0);
    assert_eq!(w.count(1_000.0), 2);
}

#[test]
fn forgetting_an_event_that_aged_out_is_silent() {
    let mut w = SlidingWindow::new(MINUTE);
    w.record(1_000.0);
    w.record(70_000.0);
    assert_eq!(w.count(70_000.0), 1);
    w.forget(1_000.0);
    assert_eq!(w.count(70_000.0), 1);
}

#[test]
fn a_drained_window_reports_empty() {
    let mut w = SlidingWindow::new(MINUTE);
    assert!(w.is_empty());
    w.record(1_000.0);
    assert_eq!(w.count(1_000.0), 1);
    assert!(!w.is_empty());
    assert_eq!(w.count(61_000.0), 0);
    assert!(w.is_empty());
}

// ---- memory scales with the limit, not the request rate (Task 6 round 2)

/// The gateway's request rate on the bench rig: ~51 admitted requests per
/// millisecond, every stamp a whole millisecond (`Date.now()`).
fn flood(w: &mut SlidingWindow, from_ms: f64, ms: u32, per_ms: u32) {
    for t in 0..ms {
        for _ in 0..per_ms {
            w.record(from_ms + f64::from(t));
        }
    }
}

/// A huge limit (the bench key's `requests:1m=100000000`) at 51 k req/s for a
/// minute: 3 M admitted requests, held in at most one entry per millisecond
/// (60 000), with the count and the reset still exact.
#[test]
fn a_huge_limit_at_a_high_rate_holds_one_entry_per_millisecond_and_stays_exact() {
    let mut w = SlidingWindow::with_limit(MINUTE, Some(100_000_000));
    flood(&mut w, 1_000.0, 60_000, 51);
    assert_eq!(w.count(60_999.0), 60_000 * 51);
    assert!(w.retained() <= 60_000, "{} entries", w.retained());
    // One ms later the first millisecond's 51 have aged out, exactly.
    assert_eq!(w.count(61_000.0), 59_999 * 51);
    assert_eq!(w.reset_at(61_000.0), 1_001.0 + MINUTE);
}

/// History cannot be truncated to today's limit: tomorrow's may be larger.
#[test]
fn history_is_independent_of_the_current_limit() {
    let mut w = SlidingWindow::with_limit(MINUTE, Some(3));
    for t in 0..10 {
        w.record(1_000.0 + f64::from(t) * 10.0);
    }
    assert_eq!(w.count(1_100.0), 10);
    assert_eq!(w.retained(), 10);
    assert_eq!(w.reset_at(1_100.0), 1_000.0 + MINUTE);
}

/// With the gateway's admission discipline (record only when `count < limit`)
/// the bounded window answers every count and reset exactly as the unbounded
/// TS one, across a long random script with aging.
#[test]
fn bounded_and_unbounded_agree_under_admission() {
    let mut seed: u64 = 0x2545_F491_4F6C_DD1D;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for limit in [1_u64, 2, 3, 7, 60, 1_000] {
        let mut exact = SlidingWindow::new(MINUTE);
        let mut bounded = SlidingWindow::with_limit(MINUTE, Some(limit));
        let mut now = 0.0;
        for _ in 0..20_000 {
            now += f64::from(u32::try_from(next() % 50).expect("small"));
            let (a, b) = (exact.count(now), bounded.count(now));
            assert_eq!(a, b, "count at {now}, limit {limit}");
            assert_eq!(
                exact.reset_at(now),
                bounded.reset_at(now),
                "reset at {now}, limit {limit}"
            );
            #[allow(clippy::cast_possible_truncation)]
            if (a as u64) < limit {
                exact.record(now);
                bounded.record(now);
            }
        }
    }
}

/// Concurrency/long-window-only subjects need history if a minute limit is enabled.
#[test]
fn no_minute_limit_still_retains_history() {
    let mut w = SlidingWindow::with_limit(MINUTE, None);
    flood(&mut w, 0.0, 100, 51);
    assert_eq!(w.retained(), 100);
    assert_eq!(w.count(100.0), 5100);
}

/// Stamps that are not whole milliseconds (never produced by the gateway)
/// cannot grow it past its fixed cap either: past `MAX_ENTRIES` the oldest
/// two entries merge into the later stamp, which can only make a count higher
/// and a reset later (the side a limiter may err on).
#[test]
fn sub_millisecond_stamps_are_capped_too() {
    let mut w = SlidingWindow::with_limit(MINUTE, Some(100_000_000));
    for i in 0..200_000_u32 {
        w.record(f64::from(i) * 0.25);
    }
    assert!(w.retained() <= SlidingWindow::MAX_ENTRIES);
    assert_eq!(w.count(50_000.0), 200_000);
}
