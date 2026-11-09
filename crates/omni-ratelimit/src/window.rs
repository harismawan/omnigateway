//! `SlidingWindow` from `packages/ratelimit/src/window.ts`: an exact sliding
//! count of event timestamps. `now` is a parameter on every method.
//!
//! **Memory has a fixed entry cap, independent of configuration.** TS keeps every
//! stamp in a minute ("sixty requests in a minute is sixty numbers"), which
//! at the Rust gateway's ~51 k req/s is ~3 M numbers per key. Here:
//! - equal stamps are held as one `(stamp, count)` entry. The gateway's
//!   stamps are whole milliseconds, so a minute is at most 60 000 entries
//!   whatever the rate, and counts and resets stay exact;
//! - configuration changes never discard events, including when no minute
//!   limit is configured. A later limit can therefore use prior admissions;
//! - at most [`SlidingWindow::MAX_ENTRIES`] entries. Only stamps finer than a
//!   millisecond can reach it; past it the two oldest entries merge into the
//!   later stamp, which can only make a count higher and a reset later.
//!   This legacy fallback has no bound on expiration delay (L2 pending).
//!   Exactness resumes after the merged history expires. Ordered timestamps
//!   are assumed, as in TS; this is not a backward-clock guarantee.

use std::collections::VecDeque;

#[derive(Debug, Clone)]
pub struct SlidingWindow {
    window_ms: f64,
    /// Ascending `(stamp, events at it)`: every event is appended at the
    /// newest end, equal stamps share an entry.
    entries: VecDeque<(f64, u32)>,
    /// Events held: the sum of the entries' counts.
    held: usize,
}

impl SlidingWindow {
    /// The most entries a window holds. A minute of whole-millisecond stamps
    /// is 60 000; this is the next power of two.
    pub const MAX_ENTRIES: usize = 65_536;

    /// TS's window: every event held (in run-length entries).
    pub fn new(window_ms: f64) -> Self {
        Self {
            window_ms,
            entries: VecDeque::new(),
            held: 0,
        }
    }

    /// Configuration-compatible constructor. History is independent of the
    /// current limit: even `None` must retain events for a later enabled limit.
    pub fn with_limit(window_ms: f64, _limit: Option<u64>) -> Self {
        Self::new(window_ms)
    }

    /// Retained for callers that update configuration. Never discards history:
    /// a future arbitrary increase must still count every live admission.
    pub fn set_limit(&mut self, _limit: Option<u64>) {}

    pub fn window_ms(&self) -> f64 {
        self.window_ms
    }

    /// Drops what has aged out, then reports what is left. The window is the
    /// half-open interval `(now - windowMs, now]`.
    pub fn count(&mut self, now: f64) -> usize {
        let cutoff = now - self.window_ms;
        while let Some(&(s, n)) = self.entries.front() {
            if s > cutoff {
                break;
            }
            self.entries.pop_front();
            self.held -= n as usize;
        }
        // Give memory back once a burst has aged out.
        if self.entries.capacity() > 64 && self.entries.capacity() > 4 * self.entries.len() {
            self.entries.shrink_to(self.entries.len() * 2);
        }
        self.held
    }

    pub fn record(&mut self, now: f64) {
        match self.entries.back_mut() {
            Some((s, n)) if *s == now && *n < u32::MAX => *n += 1,
            _ => self.entries.push_back((now, 1)),
        }
        self.held += 1;
        if self.entries.len() > Self::MAX_ENTRIES
            && let (Some((_, a)), Some((_, b))) =
                (self.entries.pop_front(), self.entries.front_mut())
        {
            // The older entry's events now age out with the later stamp.
            *b = b.saturating_add(a);
        }
    }

    /// Drops one event recorded at `at`, scanning from the newest end. Silent
    /// when it has already aged out.
    pub fn forget(&mut self, at: f64) {
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

    /// When the oldest held event ages out; `now` when nothing is held. Reads
    /// what `count` last left behind.
    pub fn reset_at(&self, now: f64) -> f64 {
        self.entries
            .front()
            .map_or(now, |(oldest, _)| oldest + self.window_ms)
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Entries held: what the window's memory is proportional to.
    pub fn retained(&self) -> usize {
        self.entries.len()
    }
}
