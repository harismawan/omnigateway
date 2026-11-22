//! The circuit breaker.

use omni_ir::error::ErrorCode;
use omni_ir::js::math_round;
use omni_store::settings::Settings;
use omni_store::{BreakerState, CredentialHealth};

/// How a failure reflects on the credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Penalty {
    None,
    Soft,
    Hard,
}

/// `PENALTY[code]`.
pub fn penalty(code: ErrorCode) -> Penalty {
    use ErrorCode::*;
    match code {
        Auth | Upstream | Timeout | Network | ModelUnavailable => Penalty::Hard,
        RateLimit | QuotaExhausted | Overloaded => Penalty::Soft,
        BadRequest | Conflict | ContentFilter | CapabilityMismatch | FingerprintRefused
        | NoCandidates | AllCandidatesFailed | Internal => Penalty::None,
    }
}

const DEFAULT_RATE_LIMIT_MS: f64 = 60_000.0;
const QUOTA_PARK_MS: f64 = 3_600_000.0;
const MAX_JITTER_MS: f64 = 2_000.0;

pub fn blank_health(credential_id: &str, model: &str) -> CredentialHealth {
    CredentialHealth {
        scalar: None,
        credential_id: credential_id.to_owned(),
        model: model.to_owned(),
        breaker_state: BreakerState::Closed,
        consecutive_failures: 0,
        opened_at: None,
        rate_limited_until: None,
    }
}

/// `successWouldChange`: no row reads as blank, so a success there writes
/// nothing.
pub fn success_would_change(current: Option<&CredentialHealth>) -> bool {
    current.is_some_and(|h| {
        h.breaker_state != BreakerState::Closed
            || h.scalar.is_some()
            || h.consecutive_failures != 0
            || h.opened_at.is_some()
            || h.rate_limited_until.is_some()
    })
}

pub fn record_success(current: &CredentialHealth) -> CredentialHealth {
    CredentialHealth {
        scalar: None,
        breaker_state: BreakerState::Closed,
        consecutive_failures: 0,
        opened_at: None,
        rate_limited_until: None,
        ..current.clone()
    }
}

/// `recordFailure`'s options.
#[derive(Debug, Clone, Copy)]
pub struct Failure<'a> {
    pub settings: &'a Settings,
    /// The caller's clock, a JS number.
    pub now: f64,
    pub code: ErrorCode,
    pub retry_after_ms: Option<f64>,
    /// 0..1, injected so the jittered window stays testable.
    pub jitter: f64,
}

/// Instants keep any fraction.
#[allow(clippy::cast_precision_loss)]
pub fn record_failure(current: &CredentialHealth, opts: &Failure<'_>) -> CredentialHealth {
    match penalty(opts.code) {
        Penalty::None => current.clone(),
        Penalty::Soft => {
            let base = if opts.code == ErrorCode::QuotaExhausted {
                QUOTA_PARK_MS
            } else {
                opts.retry_after_ms.unwrap_or(DEFAULT_RATE_LIMIT_MS)
            };
            let until = opts.now + base + math_round(opts.jitter * MAX_JITTER_MS);
            let mut next = CredentialHealth {
                rate_limited_until: Some(until),
                ..current.clone()
            };
            next.refresh_scalar(false, true);
            next
        }
        Penalty::Hard => {
            let mut next = current.clone();
            next.increment_failures();
            let failures = next.failure_number();
            let open = opts.code == ErrorCode::Auth
                || current.breaker_state == BreakerState::HalfOpen
                || failures >= opts.settings.breaker_threshold;
            next = CredentialHealth {
                breaker_state: if open {
                    BreakerState::Open
                } else {
                    BreakerState::Closed
                },
                opened_at: if open {
                    Some(opts.now)
                } else {
                    current.opened_at
                },
                ..next
            };
            next.refresh_scalar(open, false);
            next
        }
    }
}
