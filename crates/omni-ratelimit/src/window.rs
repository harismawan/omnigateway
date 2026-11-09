//! `SlidingWindow` from `packages/ratelimit/src/window.ts`: an exact sliding
//! count of event timestamps. `now` is a parameter on every method.
//!
//! **Memory scales with the limit, not the request rate.** TS keeps every
//! stamp in a minute ("sixty requests in a minute is sixty numbers"), which
//! at the Rust gateway's ~51 k req/s is ~3 M numbers per key. Here:
//! - equal stamps are held as one `(stamp, count)` entry. The gateway's
//!   stamps are whole milliseconds, so a minute is at most 60 000 entries
//!   whatever the rate, and counts and resets stay exact;
//! - a window built [`SlidingWindow::with_limit`] holds at most `limit` events:
//!   admission needs only `count < limit`, and the exact reset (the oldest
//!   held stamp plus the window) only the newest `limit`. Under the gateway's
//!   discipline (record only an admitted request, that is when
//!   `count < limit`) nothing is ever trimmed by it, so it answers exactly as
//!   TS's unbounded window. Only a limit lowered mid-window trims to the
//!   newest `limit`: `used` then reads as the limit (still refused), and the
//!   reset is when one of those frees a slot;
//! - at most [`SlidingWindow::MAX_ENTRIES`] entries. Only stamps finer than a
//!   millisecond can reach it; past it the two oldest entries merge into the
//!   later stamp, which can only make a count higher and a reset later.

use std::collections::VecDeque;

#[derive(Debug, Clone)]
pub struct SlidingWindow {
    window_ms: f64,
    /// Ascending `(stamp, events at it)`: every event is appended at the
    /// newest end, equal stamps share an entry.
    entries: VecDeque<(f64, u32)>,
    /// Events held: the sum of the entries' counts.
    held: usize,
    /// At most this many events are held (`None`: unbounded, TS's window).
    limit: Option<usize>,
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
            limit: None,
        }
    }

    /// A window that holds at most `limit` events; `None` (no limit
    /// configured on it) holds none, since nothing reads them.
    pub fn with_limit(window_ms: f64, limit: Option<u64>) -> Self {
        let mut w = Self::new(window_ms);
        w.set_limit(limit);
        w
    }

    /// Re-bounds the window for a limit that changed: the newest `limit`
    /// events are kept.
    pub fn set_limit(&mut self, limit: Option<u64>) {
        self.limit = Some(limit.map_or(0, |l| usize::try_from(l).unwrap_or(usize::MAX)));
        self.trim_to_limit();
    }

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
        if self.limit == Some(0) {
            return;
        }
        match self.entries.back_mut() {
            Some((s, n)) if *s == now && *n < u32::MAX => *n += 1,
            _ => self.entries.push_back((now, 1)),
        }
        self.held += 1;
        self.trim_to_limit();
        if self.entries.len() > Self::MAX_ENTRIES
            && let (Some((_, a)), Some((_, b))) =
                (self.entries.pop_front(), self.entries.front_mut())
        {
            // The older entry's events now age out with the later stamp.
            *b = b.saturating_add(a);
        }
    }

    /// Drops the oldest events beyond the limit.
    fn trim_to_limit(&mut self) {
        let Some(limit) = self.limit else { return };
        while self.held > limit {
            let Some(front) = self.entries.front_mut() else {
                break;
            };
            let excess = self.held - limit;
            if (front.1 as usize) <= excess {
                self.held -= front.1 as usize;
                self.entries.pop_front();
            } else {
                // `excess < front.1 <= u32::MAX`.
                front.1 -= u32::try_from(excess).unwrap_or(u32::MAX);
                self.held -= excess;
            }
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
