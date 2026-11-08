//! `SlidingWindow` from `packages/ratelimit/src/window.ts`: an exact sliding
//! count of event timestamps. `now` is a parameter on every method.

use std::collections::VecDeque;

#[derive(Debug, Clone)]
pub struct SlidingWindow {
    window_ms: f64,
    /// Ascending: every event is appended at the newest end.
    stamps: VecDeque<f64>,
}

impl SlidingWindow {
    pub fn new(window_ms: f64) -> Self {
        Self {
            window_ms,
            stamps: VecDeque::new(),
        }
    }

    pub fn window_ms(&self) -> f64 {
        self.window_ms
    }

    /// Drops what has aged out, then reports what is left. The window is the
    /// half-open interval `(now - windowMs, now]`.
    pub fn count(&mut self, now: f64) -> usize {
        let cutoff = now - self.window_ms;
        while self.stamps.front().is_some_and(|&s| s <= cutoff) {
            self.stamps.pop_front();
        }
        self.stamps.len()
    }

    pub fn record(&mut self, now: f64) {
        self.stamps.push_back(now);
    }

    /// Drops one event recorded at `at`, scanning from the newest end. Silent
    /// when it has already aged out.
    pub fn forget(&mut self, at: f64) {
        for index in (0..self.stamps.len()).rev() {
            let stamp = self.stamps[index];
            if stamp < at {
                return;
            }
            if stamp == at {
                self.stamps.remove(index);
                return;
            }
        }
    }

    /// When the oldest held event ages out; `now` when nothing is held. Reads
    /// what `count` last left behind.
    pub fn reset_at(&self, now: f64) -> f64 {
        self.stamps
            .front()
            .map_or(now, |oldest| oldest + self.window_ms)
    }

    pub fn is_empty(&self) -> bool {
        self.stamps.is_empty()
    }
}
