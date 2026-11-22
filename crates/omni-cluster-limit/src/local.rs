//! The fail-open per-process limiter, for when the server cannot answer.
//!
//! The per-step sequence run against D2's
//! `MemoryCoord`: per
//! subject the `1m` claim and the named gauge acquire (or read, for a
//! consume), judged, and on a refusal rolled back. Long windows are not
//! enforced here: their shared picture is unreachable and the request path
//! never reads the store. `1m` and `concurrency` — the limits that stop abuse
//! fastest — keep enforcing, per process, for the outage.

use std::sync::Arc;

use futures_util::FutureExt;
use omni_coord::Coord;
use omni_ratelimit::{Window, combine_all};

use crate::judge::{self, Observed, RateLimitExceeded};
use crate::{Admission, Ask, Held, Inner, Mode, Slot, spawn_renewal};

pub(crate) async fn run(
    inner: &Arc<Inner>,
    asks: Vec<Ask>,
    mode: Mode,
    now: f64,
) -> Result<Admission, RateLimitExceeded> {
    let local = &inner.local;
    let mut observed = Vec::with_capacity(asks.len());
    let mut stamps = Vec::with_capacity(asks.len());
    for a in &asks {
        let id = &a.subject.id;
        let claim = local.window_claim(id, Window::M1.ms(), now).await;
        stamps.push(claim.stamp);
        let concurrency = match (mode, &a.holder) {
            (Mode::Admit, Some(h)) => local
                .gauge_acquire(id, inner.opts.gauge_ttl_ms, Some(h))
                .await
                .unwrap_or(0),
            (Mode::Admit, None) => 0,
            (Mode::Consume, _) => local.gauge_read(id).await,
        };
        #[allow(clippy::cast_precision_loss)]
        observed.push(Observed {
            before_1m: claim.before,
            concurrency: concurrency as f64,
            long: [None, None],
            oldest: [None, None],
        });
    }
    let scopes: Vec<_> = asks.iter().map(|a| a.scope.clone()).collect();
    let decisions = judge::decide(&scopes, &observed, now);
    let combined = combine_all(&decisions);
    if combined.violation.is_some() {
        for (a, stamp) in asks.iter().zip(&stamps) {
            local.window_rollback(&a.subject.id, *stamp).await;
            if let Some(h) = &a.holder {
                let _released = local.gauge_release(&a.subject.id, Some(h)).await.is_ok();
            }
        }
        crate::bump(&inner.metrics.refusals);
        if let Some(r) = judge::refusal(&decisions, &observed, now) {
            if let Some(hook) = &inner.opts.on_rejected {
                hook(r.violation.dimension, r.violation.window);
            }
            return Err(r);
        }
    }
    let slots: Vec<Slot> = asks
        .iter()
        .filter_map(|a| {
            a.holder.as_ref().map(|h| Slot {
                subject: a.subject.id.clone(),
                holder: h.clone(),
            })
        })
        .collect();
    let renewal = spawn_renewal(inner, &slots, true, now);
    Ok(Admission {
        headroom: combined.headroom,
        unseeded: Vec::new(),
        local: true,
        held: (!slots.is_empty()).then(|| Held {
            inner: Arc::clone(inner),
            slots,
            local: true,
            renewal,
        }),
    })
}

/// Memory calls complete on their first poll (D2 `MemoryCoord`), so a
/// synchronous release can drive one to completion.
pub(crate) fn release(inner: &Inner, subject: &str, holder: &str) {
    let done = inner
        .local
        .gauge_release(subject, Some(holder))
        .now_or_never();
    debug_assert!(done.is_some(), "memory gauge release must complete at once");
}

pub(crate) async fn renew(inner: &Inner, subject: &str, holder: &str) {
    let _renewed = inner
        .local
        .gauge_renew(subject, holder, inner.opts.gauge_ttl_ms)
        .await
        .is_ok();
}
