//! The circuit breaker (`packages/router/src/breaker.ts`).

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
            || h.consecutive_failures != 0
            || h.opened_at.is_some()
            || h.rate_limited_until.is_some()
    })
}

pub fn record_success(current: &CredentialHealth) -> CredentialHealth {
    CredentialHealth {
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
    pub now: i64,
    pub code: ErrorCode,
    pub retry_after_ms: Option<f64>,
    /// 0..1, injected so the jittered window stays testable.
    pub jitter: f64,
}

/// `recordFailure`.
///
/// One difference from TS, invisible to routing: a fractional `Retry-After`
/// makes TS store a fractional `rate_limited_until`; the column here is an
/// integer and takes the ceiling, which agrees with `until > now` for every
/// integer `now`.
#[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
pub fn record_failure(current: &CredentialHealth, opts: &Failure<'_>) -> CredentialHealth {
    match penalty(opts.code) {
        Penalty::None => current.clone(),
        Penalty::Soft => {
            let base = if opts.code == ErrorCode::QuotaExhausted {
                QUOTA_PARK_MS
            } else {
                opts.retry_after_ms.unwrap_or(DEFAULT_RATE_LIMIT_MS)
            };
            let until = opts.now as f64 + base + math_round(opts.jitter * MAX_JITTER_MS);
            CredentialHealth {
                rate_limited_until: Some(until.ceil() as i64),
                ..current.clone()
            }
        }
        Penalty::Hard => {
            let failures = current.consecutive_failures + 1;
            let open = opts.code == ErrorCode::Auth
                || current.breaker_state == BreakerState::HalfOpen
                || failures as f64 >= opts.settings.breaker_threshold;
            CredentialHealth {
                consecutive_failures: failures,
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
                ..current.clone()
            }
        }
    }
}
