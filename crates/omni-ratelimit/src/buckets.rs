//! `Counts`: what one long-window bucket, or a whole window, holds. A value
//! type only; the buckets themselves are state, and live with the limiter
//! in `omni-gateway-core`.

/// `Counts`: what one bucket, or a whole window, holds.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Counts {
    pub requests: f64,
    pub tokens: f64,
    pub cost_usd: f64,
}

impl Counts {
    pub fn add(&mut self, other: Counts) {
        self.requests += other.requests;
        self.tokens += other.tokens;
        self.cost_usd += other.cost_usd;
    }
}
