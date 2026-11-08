//! Counters in time buckets for the long windows: `memoryCoord().buckets` in
//! `packages/coord/src/index.ts`, for one key.
//!
//! A window is the sum of its live buckets — those whose start is within
//! `window_ms` of `now` — so it slides at the grain and over-counts by at most
//! one bucket at its trailing edge, the direction the limiter permits. An
//! unseeded picture sums to `None`, which is a distinct answer from zero.

use std::collections::BTreeMap;

/// `Counts`: what one bucket, or a whole window, holds.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Counts {
    pub requests: f64,
    pub tokens: f64,
    pub cost_usd: f64,
}

impl Counts {
    fn add(&mut self, other: Counts) {
        self.requests += other.requests;
        self.tokens += other.tokens;
        self.cost_usd += other.cost_usd;
    }
}

#[derive(Debug, Clone)]
pub struct Buckets {
    grain_ms: f64,
    window_ms: f64,
    /// Bucket start → counts. `None` until seeded.
    held: Option<BTreeMap<i64, Counts>>,
}

/// Bucket starts are whole multiples of the grain, so they are exact as `i64`.
#[allow(clippy::cast_possible_truncation)]
fn key(start: f64) -> i64 {
    start as i64
}

impl Buckets {
    pub fn new(grain_ms: f64, window_ms: f64) -> Self {
        Self {
            grain_ms,
            window_ms,
            held: None,
        }
    }

    fn bucket_of(&self, at: f64) -> f64 {
        (at / self.grain_ms).floor() * self.grain_ms
    }

    /// Drops buckets outside the window. A picture stays seeded when empty.
    fn trim(&mut self, now: f64) {
        let oldest = key(self.bucket_of(now - self.window_ms));
        if let Some(held) = &mut self.held {
            *held = held.split_off(&oldest);
        }
    }

    pub fn is_seeded(&self) -> bool {
        self.held.is_some()
    }

    /// Adds to the bucket holding `now`. Ignored while unseeded: the row this
    /// debit describes is already in the store the seed will read.
    pub fn add(&mut self, now: f64, delta: Counts) {
        self.trim(now);
        let start = key(self.bucket_of(now));
        if let Some(held) = &mut self.held {
            held.entry(start).or_default().add(delta);
        }
    }

    pub fn sum(&mut self, now: f64) -> Option<Counts> {
        self.trim(now);
        let held = self.held.as_ref()?;
        let mut total = Counts::default();
        for counts in held.values() {
            total.add(*counts);
        }
        Some(total)
    }

    /// Installs a starting picture, replacing whatever was there. A row is
    /// filed under the start of the grain it falls in.
    pub fn seed(&mut self, now: f64, rows: &[(f64, Counts)]) {
        let mut held = BTreeMap::new();
        for (start, counts) in rows {
            // `Map.set` in TS: a later row for the same bucket replaces.
            held.insert(key(self.bucket_of(*start)), *counts);
        }
        self.held = Some(held);
        self.trim(now);
    }

    /// Forgets the picture, so the next reader must seed again.
    pub fn unseed(&mut self) {
        self.held = None;
    }
}
