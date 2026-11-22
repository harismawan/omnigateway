//! The registry under concurrent writers and scrapes (A1 fix round 1):
//!
//! - I1: a scrape is a coherent histogram snapshot: finite buckets
//!   non-decreasing and ≤ `+Inf`, `+Inf == _count`, and (for a fixed-value
//!   workload) `_sum == _count × value`.
//! - I3: once cardinality is stable, every established series is written
//!   without the registry's creation lock, past 1024 raw series too, and a
//!   scrape never holds that lock while rendering.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use omni_gateway::telemetry::{Metric, Registry};

/// Every histogram series in `text`: (labels, finite buckets, +Inf, sum, count).
fn histograms(text: &str, name: &str) -> Vec<(String, Vec<u64>, u64, f64, u64)> {
    let mut out: Vec<(String, Vec<u64>, u64, f64, u64)> = Vec::new();
    for line in text.lines() {
        let Some(rest) = line.strip_prefix(name) else {
            continue;
        };
        let (series, value) = rest.rsplit_once(' ').expect("sample");
        if let Some(b) = series.strip_prefix("_bucket{") {
            let (labels, le) = b
                .rsplit_once(",le=")
                .unwrap_or(("", b.trim_start_matches("le=")));
            let labels = labels.to_owned();
            if out.last().is_none_or(|h| h.0 != labels || h.4 != u64::MAX) {
                out.push((labels.clone(), Vec::new(), 0, 0.0, u64::MAX));
            }
            let h = out.last_mut().expect("series");
            let n: u64 = value.parse().expect("bucket");
            if le.starts_with("\"+Inf\"") {
                h.2 = n;
            } else {
                h.1.push(n);
            }
        } else if series.starts_with("_sum") {
            out.last_mut().expect("series").3 = value.parse().expect("sum");
        } else if series.starts_with("_count") {
            out.last_mut().expect("series").4 = value.parse().expect("count");
        }
    }
    out
}

#[test]
fn concurrent_observe_and_scrape_yield_coherent_histograms() {
    let r = Arc::new(Registry::new(5000.0));
    let labels = [("provider", "p"), ("model", "m")];
    // 0.25 is exact in binary: the sum of n observations is exactly n/4.
    r.observe(Metric::RequestDuration, 0.25, &labels);
    let stop = Arc::new(AtomicBool::new(false));
    let writers: Vec<_> = (0..4)
        .map(|_| {
            let (r, stop) = (r.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut n = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    r.observe(Metric::RequestDuration, 0.25, &labels);
                    n += 1;
                }
                n
            })
        })
        .collect();
    let deadline = Instant::now() + Duration::from_millis(1500);
    let mut scrapes = 0;
    let mut bad = Vec::new();
    while Instant::now() < deadline && bad.len() < 5 {
        let text = r.render();
        for (labels, buckets, inf, sum, count) in histograms(&text, "omni_request_duration_seconds")
        {
            let ok = buckets.len() == 13
                && buckets.windows(2).all(|w| w[0] <= w[1])
                && buckets.iter().all(|b| *b <= inf)
                && inf == count
                && (sum - count as f64 * 0.25).abs() < 1e-9
                // Every observation is 0.25: from the 0.25 bucket on, all of them.
                && buckets[5..].iter().all(|b| *b == count)
                && buckets[..5].iter().all(|b| *b == 0);
            if !ok {
                bad.push(format!(
                    "{labels}: buckets {buckets:?} +Inf {inf} sum {sum} count {count}"
                ));
            }
        }
        scrapes += 1;
    }
    stop.store(true, Ordering::Relaxed);
    let total: u64 = writers
        .into_iter()
        .map(|w| w.join().expect("writer"))
        .sum::<u64>()
        + 1;
    assert!(
        bad.is_empty(),
        "{scrapes} scrapes, incoherent:\n{}",
        bad.join("\n")
    );
    assert!(
        scrapes > 50 && total > 10_000,
        "scrapes {scrapes}, observations {total}"
    );
    // Quiescent: the final scrape counts every observation.
    let last = histograms(&r.render(), "omni_request_duration_seconds");
    assert_eq!(last.len(), 1);
    assert_eq!((last[0].2, last[0].4), (total, total));
    assert!((last[0].3 - total as f64 * 0.25).abs() < 1e-6);
}

/// Above 1024 raw series, with cardinality then stable, writes to every
/// series take no lock: established series reach the lock-free index
/// without further growth, and rendering does not hold the creation lock.
#[test]
fn stable_cardinality_above_1024_writes_lock_free_with_concurrent_scrapes() {
    const SERIES: usize = 1500;
    let r = Arc::new(Registry::new(100_000.0));
    let keys: Vec<String> = (0..SERIES).map(|i| format!("key-{i}")).collect();
    for k in &keys {
        r.add(Metric::RequestsTotal, &[("api_key_id", k)], 1.0);
    }
    // Every established series is now in the index, with no further growth.
    for k in &keys {
        assert!(
            r.is_lock_free(Metric::RequestsTotal, &[("api_key_id", k)]),
            "{k} not published"
        );
    }
    let before = r.locked_writes();
    let stop = Arc::new(AtomicBool::new(false));
    let scraper = {
        let (r, stop) = (r.clone(), stop.clone());
        std::thread::spawn(move || {
            let mut n = 0;
            while !stop.load(Ordering::Relaxed) {
                assert!(
                    r.render()
                        .contains("omni_requests_total{api_key_id=\"key-1499\"}")
                );
                n += 1;
            }
            n
        })
    };
    let writers: Vec<_> = (0..4)
        .map(|t| {
            let (r, keys) = (r.clone(), keys.clone());
            std::thread::spawn(move || {
                for round in 0..20 {
                    for (i, k) in keys.iter().enumerate() {
                        if (i + round + t) % 4 == 0 {
                            r.add(Metric::RequestsTotal, &[("api_key_id", k)], 1.0);
                        }
                    }
                }
            })
        })
        .collect();
    for w in writers {
        w.join().expect("writer");
    }
    stop.store(true, Ordering::Relaxed);
    let scrapes = scraper.join().expect("scraper");
    assert_eq!(
        r.locked_writes(),
        before,
        "a write to an established series took the lock"
    );
    assert!(scrapes > 0);
    // 20 rounds × 4 threads, each series written by exactly one thread per
    // round: 1 + 20 for each series.
    let text = r.render();
    for k in &keys {
        assert!(
            text.contains(&format!("omni_requests_total{{api_key_id=\"{k}\"}} 21\n")),
            "{k}"
        );
    }
}

/// A scrape does not block writers: while one render is running, writes to
/// established series still complete (they never wait on the lock).
#[test]
fn a_scrape_does_not_hold_the_writer_lock() {
    let r = Arc::new(Registry::new(100_000.0));
    for i in 0..5000 {
        r.add(
            Metric::RequestsTotal,
            &[("api_key_id", &format!("k{i}"))],
            1.0,
        );
    }
    assert!(!r.render_holds_creation_lock());
}
