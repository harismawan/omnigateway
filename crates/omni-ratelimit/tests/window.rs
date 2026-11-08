//! Port of `packages/ratelimit/test/window.test.ts`.

use omni_ratelimit::window::SlidingWindow;

const MINUTE: f64 = 60_000.0;

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
