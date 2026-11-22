//! How the router reads a quota snapshot (`packages/router/src/quota.ts`).

use omni_ir::js::{math_max, math_min};
use omni_store::{AuthType, Credential, QuotaWindow};

/// Neutral score for a credential whose provider reports no usage at all.
pub const UNKNOWN_QUOTA: f64 = 0.5;

/// Below this, a rotation should stop feeding an account.
pub const QUOTA_FLOOR: f64 = 0.1;

/// Three poll intervals, never less than three minutes.
pub fn quota_stale_after_ms(poll_interval_ms: f64) -> f64 {
    math_max(poll_interval_ms, 60_000.0) * 3.0
}

/// `durationFor`: the provider's stated length when positive.
fn duration_for(window: &QuotaWindow) -> f64 {
    match window.window_ms {
        Some(ms) if ms > 0.0 => ms,
        _ => window.window_type.nominal_ms(),
    }
}

/// `quotaRolledOver`.
pub(crate) fn rolled_over(window: &QuotaWindow, now: f64) -> bool {
    window.resets_at.is_some_and(|r| r <= now)
}

fn clamp01(x: f64) -> f64 {
    math_max(0.0, math_min(1.0, x))
}

fn pace_adjusted(window: &QuotaWindow, now: f64) -> f64 {
    let Some(limit) = window.limit.filter(|l| *l > 0.0) else {
        return 1.0;
    };
    let headroom = clamp01(1.0 - window.used / limit);
    let Some(resets_at) = window.resets_at else {
        return headroom;
    };
    let remaining = math_max(
        0.05,
        math_min(1.0, (resets_at - now) / duration_for(window)),
    );
    clamp01(headroom / remaining)
}

/// `quotaHeadroom`: the tightest usable window, in 0..1.
pub fn quota_headroom(
    credential: &Credential,
    windows: &[QuotaWindow],
    now: f64,
    poll_interval_ms: f64,
) -> f64 {
    let stale_after = quota_stale_after_ms(poll_interval_ms);
    let mut usable = windows
        .iter()
        .filter(|w| {
            w.limit.is_some_and(|l| l > 0.0)
                && w.observed_at > 0.0
                && now - w.observed_at <= stale_after
                && !rolled_over(w, now)
        })
        .peekable();
    if usable.peek().is_none() {
        return if credential.auth_type == AuthType::ApiKey {
            1.0
        } else {
            UNKNOWN_QUOTA
        };
    }
    usable
        .map(|w| pace_adjusted(w, now))
        .fold(f64::INFINITY, math_min)
}
