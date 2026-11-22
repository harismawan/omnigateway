//! Rate-limit arithmetic.
//!
//! Pure: no clock, no I/O, `now` a parameter wherever time matters. The
//! caller observes the counters (a ring for `1m`, buckets for the long
//! windows, a gauge for concurrency) and this crate judges them.
//!
//! Instants and amounts are `f64`, matching the JS-number spelling the
//! headroom figures reach response headers in (`String(n)`).
//!
//! **Precondition: every counter, limit and instant is finite.** They come
//! from integer rows, positive parsed limits and this gateway's own sums, so
//! NaN cannot arise. The `f64::max` used here would clamp a NaN to zero;
//! the precondition keeps that case unreachable, and debug builds assert it
//! at each entry point.

pub mod buckets;
pub mod limits;
pub mod window;

use limits::{CountWindows, LimitScope, SpendWindows, WINDOW_MS_1M, WINDOW_MS_1W, WINDOW_MS_5H};

/// `Window`: the persisted window names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Window {
    M1,
    H5,
    W1,
}

impl Window {
    /// `WINDOWS`, in order.
    pub const ALL: [Window; 3] = [Window::M1, Window::H5, Window::W1];

    pub fn as_str(self) -> &'static str {
        match self {
            Window::M1 => "1m",
            Window::H5 => "5h",
            Window::W1 => "1w",
        }
    }

    /// `WINDOW_MS[window]`.
    #[allow(clippy::cast_precision_loss)]
    pub fn ms(self) -> f64 {
        (match self {
            Window::M1 => WINDOW_MS_1M,
            Window::H5 => WINDOW_MS_5H,
            Window::W1 => WINDOW_MS_1W,
        }) as f64
    }
}

/// `Dimension`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Dimension {
    Requests,
    Tokens,
    Spend,
    Concurrency,
}

impl Dimension {
    pub fn as_str(self) -> &'static str {
        match self {
            Dimension::Requests => "requests",
            Dimension::Tokens => "tokens",
            Dimension::Spend => "spend",
            Dimension::Concurrency => "concurrency",
        }
    }
}

/// The dimensions counted over a window, in `WINDOWED` order.
const WINDOWED: [Dimension; 3] = [Dimension::Requests, Dimension::Tokens, Dimension::Spend];

/// `WindowCounter`: usage inside one window, and when it next frees a slot.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowCounter {
    pub used: f64,
    pub reset_at: f64,
}

/// `DimensionCounters`: one dimension's observed windows.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct DimensionCounters {
    pub m1: Option<WindowCounter>,
    pub h5: Option<WindowCounter>,
    pub w1: Option<WindowCounter>,
}

impl DimensionCounters {
    pub fn get(&self, window: Window) -> Option<WindowCounter> {
        match window {
            Window::M1 => self.m1,
            Window::H5 => self.h5,
            Window::W1 => self.w1,
        }
    }

    pub fn set(&mut self, window: Window, counter: WindowCounter) {
        match window {
            Window::M1 => self.m1 = Some(counter),
            Window::H5 => self.h5 = Some(counter),
            Window::W1 => self.w1 = Some(counter),
        }
    }
}

/// `CounterSnapshot`: what the caller observed. An absent window reads as
/// nothing used and a full window ahead.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CounterSnapshot {
    pub requests: DimensionCounters,
    pub tokens: DimensionCounters,
    pub spend: DimensionCounters,
    /// In-flight requests right now. A gauge, not a window.
    pub concurrency: f64,
}

impl CounterSnapshot {
    fn dimension(&self, dimension: Dimension) -> DimensionCounters {
        match dimension {
            Dimension::Requests => self.requests,
            Dimension::Tokens => self.tokens,
            Dimension::Spend | Dimension::Concurrency => self.spend,
        }
    }
}

/// `Violation`. `window` is `None` for `concurrency`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Violation {
    pub dimension: Dimension,
    pub window: Option<Window>,
    pub limit: f64,
    pub used: f64,
    pub reset_at: f64,
}

/// `Headroom`: one dimension's figure for the rate-limit headers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Headroom {
    pub window: Window,
    pub limit: f64,
    pub used: f64,
    /// Floored at zero.
    pub remaining: f64,
    pub reset_at: f64,
}

impl Headroom {
    fn proportion(&self) -> f64 {
        self.used / self.limit
    }
}

/// `HeadroomByDimension`: per windowed dimension, the configured window
/// nearest exhaustion. `None` for a dimension with no configured limit.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct HeadroomByDimension {
    pub requests: Option<Headroom>,
    pub tokens: Option<Headroom>,
    pub spend: Option<Headroom>,
}

impl HeadroomByDimension {
    pub fn is_empty(&self) -> bool {
        self.requests.is_none() && self.tokens.is_none() && self.spend.is_none()
    }

    pub fn get(&self, dimension: Dimension) -> Option<Headroom> {
        match dimension {
            Dimension::Requests => self.requests,
            Dimension::Tokens => self.tokens,
            Dimension::Spend => self.spend,
            Dimension::Concurrency => None,
        }
    }

    fn slot(&mut self, dimension: Dimension) -> Option<&mut Option<Headroom>> {
        match dimension {
            Dimension::Requests => Some(&mut self.requests),
            Dimension::Tokens => Some(&mut self.tokens),
            Dimension::Spend => Some(&mut self.spend),
            Dimension::Concurrency => None,
        }
    }

    pub fn set(&mut self, dimension: Dimension, headroom: Headroom) {
        if let Some(slot) = self.slot(dimension) {
            *slot = Some(headroom);
        }
    }
}

/// `Decision`.
#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub allowed: bool,
    /// Of `violations`, the one clearing last.
    pub violation: Option<Violation>,
    /// Every limit the request trips, unordered.
    pub violations: Vec<Violation>,
    pub headroom: HeadroomByDimension,
}

impl Decision {
    /// The empty decision [`combine_all`] answers for no subjects.
    pub fn unlimited() -> Self {
        Self {
            allowed: true,
            violation: None,
            violations: Vec::new(),
            headroom: HeadroomByDimension::default(),
        }
    }
}

#[allow(clippy::cast_precision_loss)]
fn count_limit(windows: &CountWindows, window: Window) -> Option<f64> {
    let pair = match window {
        Window::M1 => windows.one_minute,
        Window::H5 => windows.five_hours,
        Window::W1 => windows.one_week,
    };
    pair.flatten().map(|n| n as f64)
}

fn spend_limit(windows: &SpendWindows, window: Window) -> Option<f64> {
    match window {
        Window::M1 => None,
        Window::H5 => windows.five_hours.flatten(),
        Window::W1 => windows.one_week.flatten(),
    }
}

/// The configured ceiling of one dimension at one window, if any.
pub fn limit_of(scope: &LimitScope, dimension: Dimension, window: Window) -> Option<f64> {
    match dimension {
        Dimension::Requests => scope.requests.as_ref().and_then(|w| count_limit(w, window)),
        Dimension::Tokens => scope.tokens.as_ref().and_then(|w| count_limit(w, window)),
        Dimension::Spend => scope.spend.as_ref().and_then(|w| spend_limit(w, window)),
        Dimension::Concurrency => None,
    }
}

fn dimension_configured(scope: &LimitScope, dimension: Dimension) -> bool {
    match dimension {
        Dimension::Requests => scope.requests.is_some(),
        Dimension::Tokens => scope.tokens.is_some(),
        Dimension::Spend => scope.spend.is_some(),
        Dimension::Concurrency => false,
    }
}

fn counters_finite(c: &CounterSnapshot) -> bool {
    let dim = |d: &DimensionCounters| {
        [d.m1, d.h5, d.w1]
            .into_iter()
            .flatten()
            .all(|w| w.used.is_finite() && w.reset_at.is_finite())
    };
    c.concurrency.is_finite() && dim(&c.requests) && dim(&c.tokens) && dim(&c.spend)
}

/// The latest reset, then the larger overshoot, then walk order.
pub fn last_to_clear(violations: &[Violation]) -> Option<Violation> {
    let mut chosen: Option<Violation> = None;
    for candidate in violations {
        match chosen {
            None => chosen = Some(*candidate),
            Some(c) if candidate.reset_at > c.reset_at => chosen = Some(*candidate),
            Some(c)
                if candidate.reset_at == c.reset_at
                    && candidate.used / candidate.limit > c.used / c.limit =>
            {
                chosen = Some(*candidate);
            }
            Some(_) => {}
        }
    }
    chosen
}

/// `evaluate`: judges one request against one scope's limits. `used` is what
/// a window held before this request, so landing exactly on a ceiling is
/// allowed and the next request is refused.
pub fn evaluate(config: &LimitScope, counters: &CounterSnapshot, now: f64) -> Decision {
    debug_assert!(
        now.is_finite() && counters_finite(counters),
        "non-finite rate-limit counter"
    );
    let mut violations = Vec::new();
    let mut headroom = HeadroomByDimension::default();

    for dimension in WINDOWED {
        if !dimension_configured(config, dimension) {
            continue;
        }
        let observed = counters.dimension(dimension);
        let mut nearest: Option<Headroom> = None;
        for window in Window::ALL {
            let Some(limit) = limit_of(config, dimension, window) else {
                continue;
            };
            let counter = observed.get(window);
            let used = counter.map_or(0.0, |c| c.used);
            let reset_at = counter.map_or(now + window.ms(), |c| c.reset_at);
            if used >= limit {
                violations.push(Violation {
                    dimension,
                    window: Some(window),
                    limit,
                    used,
                    reset_at,
                });
            }
            let entry = Headroom {
                window,
                limit,
                used,
                remaining: (limit - used).max(0.0),
                reset_at,
            };
            if nearest.is_none_or(|n| entry.proportion() > n.proportion()) {
                nearest = Some(entry);
            }
        }
        if let Some(n) = nearest {
            headroom.set(dimension, n);
        }
    }

    #[allow(clippy::cast_precision_loss)]
    if let Some(concurrency) = config.concurrency.flatten().map(|n| n as f64) {
        let used = counters.concurrency;
        if used >= concurrency {
            violations.push(Violation {
                dimension: Dimension::Concurrency,
                window: None,
                limit: concurrency,
                used,
                reset_at: now,
            });
        }
    }

    let violation = last_to_clear(&violations);
    Decision {
        allowed: violation.is_none(),
        violation,
        violations,
        headroom,
    }
}

/// `combine`: the key-wide decision joined with a model override's. Ties in
/// headroom keep the key-wide entry.
pub fn combine(key: &Decision, model: &Decision) -> Decision {
    let violations: Vec<Violation> = key
        .violations
        .iter()
        .chain(model.violations.iter())
        .copied()
        .collect();
    let violation = last_to_clear(&violations);
    let mut headroom = key.headroom;
    for dimension in WINDOWED {
        let Some(candidate) = model.headroom.get(dimension) else {
            continue;
        };
        if headroom
            .get(dimension)
            .is_none_or(|current| candidate.proportion() > current.proportion())
        {
            headroom.set(dimension, candidate);
        }
    }
    Decision {
        allowed: violation.is_none(),
        violation,
        violations,
        headroom,
    }
}

/// Key-wide first, which is `combine`'s tie order.
pub fn combine_all(decisions: &[Decision]) -> Decision {
    let Some((first, rest)) = decisions.split_first() else {
        return Decision::unlimited();
    };
    rest.iter().fold(first.clone(), |acc, d| combine(&acc, d))
}

/// Never negative, zero for no violation.
pub fn retry_after_ms(violation: Option<&Violation>, now: f64) -> f64 {
    debug_assert!(now.is_finite() && violation.is_none_or(|v| v.reset_at.is_finite()));
    violation.map_or(0.0, |v| (v.reset_at - now).max(0.0))
}

/// `remaining` once the request being
/// served is counted. Only `requests` moves; tokens and spend debit later.
pub fn after_this_request(headroom: &HeadroomByDimension) -> HeadroomByDimension {
    debug_assert!(headroom.requests.is_none_or(|r| r.remaining.is_finite()));
    let mut out = *headroom;
    if let Some(r) = &mut out.requests {
        r.remaining = (r.remaining - 1.0).max(0.0);
    }
    out
}

/// Every reported dimension sitting on `window` takes `reset_at`.
pub fn with_reset(
    headroom: &HeadroomByDimension,
    window: Window,
    reset_at: f64,
) -> HeadroomByDimension {
    let mut out = *headroom;
    for dimension in WINDOWED {
        if let Some(slot) = out.slot(dimension)
            && let Some(entry) = slot
            && entry.window == window
        {
            entry.reset_at = reset_at;
        }
    }
    out
}

/// On a refusal, the refused dimension's header is the
/// violated entry itself, so it names the same instant as `Retry-After`.
pub fn refused_headroom(decision: &Decision, violation: &Violation) -> HeadroomByDimension {
    debug_assert!(violation.limit.is_finite() && violation.used.is_finite());
    let mut out = decision.headroom;
    if let Some(window) = violation.window
        && violation.dimension != Dimension::Concurrency
    {
        out.set(
            violation.dimension,
            Headroom {
                window,
                limit: violation.limit,
                used: violation.used,
                remaining: (violation.limit - violation.used).max(0.0),
                reset_at: violation.reset_at,
            },
        );
    }
    out
}
