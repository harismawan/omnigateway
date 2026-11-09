//! Port of `packages/ratelimit/test/window.test.ts`.

use omni_ratelimit::window::SlidingWindow;

const MINUTE: f64 = 60_000.0;

#[test]
fn clamped_history_forget_never_undercounts_actual_ts_and_recovers() {
    // Execute the real TS reverse scan, including its early stop on a lower
    // backdated stamp. Repeated forgets must not spend ambiguous debt twice.
    let ops = serde_json::json!([
        ["record", 10000],
        ["record", 5000],
        ["forget", 10000],
        ["count", 10000],
        ["forget", 10000],
        ["count", 10000],
        ["forget", 5000],
        ["count", 10000],
        ["record", 11000],
        ["forget", 11000],
        ["forget", 10000],
        ["count", 11000],
        ["count", 69999],
        ["count", 70000],
        ["count", 71000],
        ["record", 72000],
        ["record", 72000],
        ["forget", 72000],
        ["count", 72000],
        ["forget", 72000],
        ["count", 72000]
    ]);
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/ratelimit/src/window.ts");
    let script = format!(
        "import {{SlidingWindow}} from {}; const w=new SlidingWindow(60000); \
         const out=[]; for(const [op,at] of {ops}) {{ \
         const v=w[op](at); if(op==='count') out.push(v); }} console.log(JSON.stringify(out));",
        serde_json::to_string(&source).expect("path")
    );
    let output = std::process::Command::new("bun")
        .args(["-e", &script])
        .output()
        .expect("Bun is required for real TS window parity");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<usize> = serde_json::from_slice(&output.stdout).expect("TS counts");
    assert_eq!(expected[0], 2, "TS early stop reproduces reviewer finding");
    let mut w = SlidingWindow::new(MINUTE);
    let mut index = 0;
    for op in ops.as_array().expect("ops") {
        let at = op[1].as_f64().expect("at");
        match op[0].as_str().expect("op") {
            "record" => w.record(at),
            "forget" => w.forget(at),
            "count" => {
                let count = w.count(at);
                assert!(
                    count >= expected[index],
                    "at {at}: Rust {count} < TS {}",
                    expected[index]
                );
                if at >= 71000.0 {
                    assert_eq!(count, expected[index], "recovered exact rollback");
                }
                index += 1;
            }
            _ => unreachable!(),
        }
    }
    assert_eq!(index, expected.len());
    assert!(w.is_empty());
}

#[test]
fn bucket_fallback_tracks_exact_reference_with_one_trailing_bucket_error() {
    for limit in [65_536, 65_537] {
        let mut w = SlidingWindow::with_limit(MINUTE, Some(limit));
        let mut exact = std::collections::VecDeque::new();
        for i in 0..480_000 {
            let now = f64::from(i) * 0.25;
            w.record(now);
            exact.push_back(now);
            if i % 4000 == 0 || i == 479_999 {
                let cutoff = now - MINUTE;
                while exact.front().is_some_and(|s| *s <= cutoff) {
                    exact.pop_front();
                }
                let count = w.count(now);
                // At most 4000 quarter-ms events in one second.
                assert!(
                    count >= exact.len() && count <= exact.len() + 4000,
                    "limit {limit}, now {now}: {count} vs {}",
                    exact.len()
                );
            }
        }
        w.set_limit(Some(1));
        w.set_limit(Some(1_000_000));
        assert_eq!(w.retained(), 61);
        assert!((239_999..=243_999).contains(&w.count(120_000.0)));
        assert!(w.retained() <= 61);
        assert_eq!(w.count(180_000.0), 0);
        w.record(180_000.25);
        assert_eq!(w.reset_at(180_001.0), 240_000.25);
        assert_eq!(w.count(240_000.25), 0);
    }
}

#[test]
fn bucket_end_expires_at_equality_and_backward_time_fails_closed() {
    let mut w = SlidingWindow::new(MINUTE);
    for i in 0..65_537 {
        w.record(f64::from(i) * 0.001);
    }
    assert_eq!(w.count(60_999.999), 65_537);
    assert_eq!(w.reset_at(60_999.999), 61_000.0);
    assert_eq!(w.count(61_000.0), 0);
    assert_eq!(w.count(60_000.0), usize::MAX);
    w.record(59_000.0);
    assert!(w.count(61_000.0) >= 1);
    assert_eq!(w.count(121_000.0), 0);
}

#[test]
fn out_of_order_records_never_undercount_ts_prefix_semantics() {
    let mut w = SlidingWindow::new(MINUTE);
    let mut ts = std::collections::VecDeque::new();
    for at in [10_000.0, 5_000.0, 11_000.0, -100_000.0, 12_000.0] {
        w.record(at);
        ts.push_back(at);
    }
    for now in [12_000.0, 65_000.0, 70_000.0, 71_000.0, 72_000.0] {
        while ts.front().is_some_and(|s| *s <= now - MINUTE) {
            ts.pop_front();
        }
        assert!(w.count(now) >= ts.len());
    }
    assert_eq!(w.count(72_000.0), 0);
}

#[test]
fn fallback_burst_and_backdated_records_keep_live_buckets() {
    let mut w = SlidingWindow::new(MINUTE);
    let mut stamps = Vec::new();
    for i in 0..65_537 {
        let at = f64::from(i) * 0.25;
        w.record(at);
        stamps.push(at);
    }
    for at in [20_999.75, 20_999.75, 21_000.0, 59_999.75, 60_000.0] {
        w.record(at);
        stamps.push(at);
    }
    for now in [
        60_000.0, 60_999.75, 61_000.0, 75_999.75, 76_000.0, 80_999.75, 81_000.0,
    ] {
        let cutoff = now - MINUTE;
        let exact = stamps.iter().filter(|s| **s > cutoff).count();
        let trailing = stamps
            .iter()
            .filter(|s| **s <= cutoff && **s >= (cutoff / 1000.0).floor() * 1000.0)
            .count();
        let count = w.count(now);
        assert!(
            count >= exact && count <= exact + trailing,
            "at {now}: {count} vs {exact}+{trailing}"
        );
    }
    // Far-backdated arrival cannot reuse/overwrite a live bucket slot.
    w.record(-1_000_000.0);
    assert!(w.count(81_000.0) >= 3);
    assert_eq!(w.count(142_000.0), 0);
}

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

// ---- memory bounded independently of configuration and request rate

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
        let mut exact = std::collections::VecDeque::new();
        let mut bounded = SlidingWindow::with_limit(MINUTE, Some(limit));
        let mut now = 0.0;
        for _ in 0..20_000 {
            now += f64::from(u32::try_from(next() % 50).expect("small"));
            while exact.front().is_some_and(|s| *s <= now - MINUTE) {
                exact.pop_front();
            }
            let (a, b) = (exact.len(), bounded.count(now));
            assert_eq!(a, b, "count at {now}, limit {limit}");
            assert_eq!(
                exact.front().map_or(now, |s| s + MINUTE),
                bounded.reset_at(now),
                "reset at {now}, limit {limit}"
            );
            #[allow(clippy::cast_possible_truncation)]
            if (a as u64) < limit {
                exact.push_back(now);
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
/// cannot grow it past its fixed cap either: past `MAX_ENTRIES`, fixed-width
/// buckets retain counts at exclusive ends, conservatively delaying expiry.
#[test]
fn sub_millisecond_stamps_are_capped_too() {
    let mut w = SlidingWindow::with_limit(MINUTE, Some(100_000_000));
    for i in 0..200_000_u32 {
        w.record(f64::from(i) * 0.25);
    }
    assert!(w.retained() <= SlidingWindow::MAX_ENTRIES);
    assert_eq!(w.count(50_000.0), 200_000);
}
