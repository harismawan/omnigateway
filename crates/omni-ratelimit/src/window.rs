//! Bounded sliding history, independent of configured limits.
//!
//! Ordered traffic is exact up to MAX_ENTRIES distinct timestamps. Beyond it,
//! entries become fixed one-second buckets, represented by their exclusive end.
//! Expiration at end + window is conservative: only the trailing bucket can
//! overcount. A minute overlaps up to 61 buckets. Exact mode resumes when empty.
//!
//! TS appends in arrival order and removes only an expired prefix. Backdated
//! records here are clamped to the high-water timestamp, preserving that prefix's
//! conservative blocking behavior without an unbounded unsorted log. Reads below
//! high-water fail closed (usize::MAX); they cannot reconstruct expired history.
//! The one-bucket error bound applies to ordered traffic, not clock rollback.

use std::collections::VecDeque;

#[derive(Debug, Clone)]
pub struct SlidingWindow {
    window_ms: f64,
    entries: VecDeque<(f64, usize)>,
    held: usize,
    bucketed: bool,
    // Clamping loses original timestamps and the TS reverse-scan stopping
    // point. Do not remove any representative until this history drains.
    clamped_history: bool,
    high_water: f64,
}

impl SlidingWindow {
    pub const MAX_ENTRIES: usize = 65_536;
    const GRAIN_MS: f64 = 1_000.0;

    pub fn new(window_ms: f64) -> Self {
        Self {
            window_ms,
            entries: VecDeque::new(),
            held: 0,
            bucketed: false,
            clamped_history: false,
            high_water: f64::NEG_INFINITY,
        }
    }

    /// Limits never discard history, including `None`.
    pub fn with_limit(window_ms: f64, _limit: Option<u64>) -> Self {
        Self::new(window_ms)
    }

    pub fn set_limit(&mut self, _limit: Option<u64>) {}

    pub fn window_ms(&self) -> f64 {
        self.window_ms
    }

    pub fn count(&mut self, now: f64) -> usize {
        if now < self.high_water {
            return usize::MAX;
        }
        self.high_water = now;
        let cutoff = now - self.window_ms;
        while let Some(&(s, n)) = self.entries.front() {
            if s > cutoff {
                break;
            }
            self.entries.pop_front();
            self.held -= n;
        }
        if self.entries.is_empty() {
            self.bucketed = false;
            self.clamped_history = false;
        }
        if self.entries.capacity() > 64 && self.entries.capacity() > 4 * self.entries.len() {
            self.entries.shrink_to(self.entries.len() * 2);
        }
        self.held
    }

    fn end(at: f64) -> f64 {
        (at / Self::GRAIN_MS).floor() * Self::GRAIN_MS + Self::GRAIN_MS
    }

    fn append(&mut self, at: f64, count: usize) {
        match self.entries.back_mut() {
            Some((s, n)) if *s == at => *n = n.saturating_add(count),
            _ => self.entries.push_back((at, count)),
        }
    }

    pub fn record(&mut self, now: f64) {
        let clamped = now < self.high_water;
        let at = now.max(self.high_water);
        // Expiration here bounds storage even for callers recording without reads.
        self.count(at);
        self.clamped_history |= clamped;
        self.append(if self.bucketed { Self::end(at) } else { at }, 1);
        self.held = self.held.saturating_add(1);
        if self.entries.len() > Self::MAX_ENTRIES {
            let entries = std::mem::take(&mut self.entries);
            for (stamp, n) in entries {
                self.append(Self::end(stamp), n);
            }
            self.bucketed = true;
        }
    }

    /// Approximate or clamped history cannot identify a particular event safely;
    /// rollback then retains conservative debt until expiration.
    pub fn forget(&mut self, at: f64) {
        if self.bucketed || self.clamped_history {
            return;
        }
        for index in (0..self.entries.len()).rev() {
            let (stamp, n) = self.entries[index];
            if stamp < at {
                return;
            }
            if stamp == at {
                if n > 1 {
                    self.entries[index].1 -= 1;
                } else {
                    self.entries.remove(index);
                }
                self.held -= 1;
                return;
            }
        }
    }

    pub fn reset_at(&self, now: f64) -> f64 {
        if now < self.high_water {
            return self.high_water + self.window_ms;
        }
        self.entries
            .front()
            .map_or(now, |(s, _)| s + self.window_ms)
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn retained(&self) -> usize {
        self.entries.len()
    }
}
