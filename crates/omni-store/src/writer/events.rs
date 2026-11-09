//! What the request path hands the writer: plain owned data, no storage types.
//!
//! The shapes follow `apps/gateway/src/logging.ts`. A request emits a
//! [`LogEvent::Begin`] when routing first picks a target (`beginLog`), a
//! [`LogEvent::Route`] on each failover (`routeLog`), and one
//! [`LogEvent::Finish`] when it is done (`finishLog`), on success, error and
//! cancel (status 499) alike. The `api_key_id` the TS helpers take as a separate
//! `keyId` argument is a field here.

use crate::CredentialHealth;
use serde::Serialize;

/// `newPendingRequestLog` plus the key: what is known when a request starts.
/// Every other column of the pending row is a placeholder zero, which readers
/// tell apart from a measurement by `state = 'pending'`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingLog {
    pub id: String,
    /// Epoch milliseconds the request started at. The row keeps it on finish.
    pub at: i64,
    pub api_key_id: Option<String>,
    pub requested_model: String,
    pub resolved_provider: Option<String>,
    pub resolved_model: Option<String>,
    pub credential_id: Option<String>,
}

/// `routeLog`'s target: the candidate dispatch moved to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteTarget {
    pub provider: String,
    pub model: String,
    pub credential_id: String,
}

/// A finished request: the TS `RequestLog` without `state`, which is always
/// `done` here.
///
/// Counters are integers because the gateway only ever produces integers for
/// them; `cost_usd` is the one REAL column.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLog {
    pub id: String,
    /// Used only when no row began; a row that began keeps its own `at`.
    pub at: i64,
    /// `None` keeps whatever the pending row holds.
    pub api_key_id: Option<String>,
    /// `""` keeps whatever the pending row holds.
    pub requested_model: String,
    pub resolved_provider: Option<String>,
    pub resolved_model: Option<String>,
    pub credential_id: Option<String>,
    pub attempts: i64,
    pub status: i64,
    pub error_code: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub ttft_ms: Option<i64>,
    pub duration_ms: i64,
    pub cost_usd: f64,
    pub degradations: Vec<String>,
    pub rtk_applied: bool,
    pub rtk_filter_hits: i64,
    pub rtk_original_code_units: i64,
    pub rtk_compressed_code_units: i64,
    pub rtk_estimated_tokens_saved: i64,
    pub rtk_filters: Vec<String>,
}

impl RequestLog {
    /// `newCompletedRequestLog(id, at, { status })`: every measurement zero.
    pub fn new(id: impl Into<String>, at: i64, status: i64) -> Self {
        Self {
            id: id.into(),
            at,
            api_key_id: None,
            requested_model: String::new(),
            resolved_provider: None,
            resolved_model: None,
            credential_id: None,
            attempts: 0,
            status,
            error_code: None,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            ttft_ms: None,
            duration_ms: 0,
            cost_usd: 0.0,
            degradations: Vec::new(),
            rtk_applied: false,
            rtk_filter_hits: 0,
            rtk_original_code_units: 0,
            rtk_compressed_code_units: 0,
            rtk_estimated_tokens_saved: 0,
            rtk_filters: Vec::new(),
        }
    }
}

/// One request lifecycle step, in the order the request took it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LogEvent {
    /// `usage.begin`: files a pending row. A no-op when the id already has one.
    Begin(PendingLog),
    /// `usage.route`: rewrites the target of a row still pending.
    Route { id: String, target: RouteTarget },
    /// `usage.append`: completes the row (or files it done) and rolls it up.
    /// Claims only a pending or absent row, so a second finish counts nothing.
    Finish(RequestLog),
}

impl LogEvent {
    pub fn id(&self) -> &str {
        match self {
            Self::Begin(p) => &p.id,
            Self::Route { id, .. } => id,
            Self::Finish(l) => &l.id,
        }
    }
}

/// A health reading that is not a breaker decision: the failure count and the
/// rate-limit parking. Coalesced per batch, the last per (credential, model)
/// winning, and it never touches `breaker_state` or `opened_at` — so one that
/// lands after a [`BreakerTransition`] in the same batch cannot carry a stale
/// state back over it.
///
/// On a pair with no row yet it files one with the `blankHealth` state
/// (`closed`, no `opened_at`), which is the row `updateHealth` writes there.
#[derive(Debug, Clone, PartialEq)]
pub struct HealthMeasurement {
    pub credential_id: String,
    pub model: String,
    pub consecutive_failures: i64,
    /// A JS number; bound as `bun:sqlite` binds one.
    pub rate_limited_until: Option<f64>,
}

/// A breaker decision: the whole `credential_health` row as `updateHealth`
/// would persist it after the transition.
///
/// Never coalesced: every transition is applied in order, so the row a batch
/// leaves is the row TS leaves applying them one by one. In single mode routing
/// reads the in-process snapshot, so riding the batch is enough; the cluster
/// slice routes these through an immediate path instead, because other
/// replicas route on them.
#[derive(Debug, Clone, PartialEq)]
pub struct BreakerTransition(pub CredentialHealth);

/// Anything the writer persists.
#[derive(Debug, Clone, PartialEq)]
// Nearly every event is a `Log`; boxing it to shrink the rare health events
// would cost an allocation per request for nothing.
#[allow(clippy::large_enum_variant)]
pub enum WriteEvent {
    Log(LogEvent),
    HealthMeasurement(HealthMeasurement),
    BreakerTransition(BreakerTransition),
    /// Not persisted: a seed read, ordered with the writes around it.
    Seed(SeedQuery),
}

impl From<LogEvent> for WriteEvent {
    fn from(e: LogEvent) -> Self {
        Self::Log(e)
    }
}

impl From<HealthMeasurement> for WriteEvent {
    fn from(e: HealthMeasurement) -> Self {
        Self::HealthMeasurement(e)
    }
}

impl From<BreakerTransition> for WriteEvent {
    fn from(e: BreakerTransition) -> Self {
        Self::BreakerTransition(e)
    }
}

/// A completed `request_logs` row, as stored, delivered after the batch
/// that wrote it committed. The rate limiter debits its long windows with
/// these, in commit order (TS: "row first, then the debit").
#[derive(Debug, Clone, PartialEq)]
pub struct Completion {
    /// The request id (`request_logs.id`).
    pub id: String,
    pub api_key_id: Option<String>,
    pub requested_model: String,
    /// The four disjoint token classes, summed.
    pub tokens: f64,
    pub cost_usd: f64,
    /// `request_logs.at`.
    pub at: f64,
}

/// A long-window seed the writer reads on its own connection, between
/// batches: everything committed before it, nothing after.
#[derive(Debug, Clone, PartialEq)]
pub struct SeedQuery {
    /// The limiter's subject id, echoed back.
    pub subject: String,
    pub api_key_id: String,
    /// `None` for the key-wide subject.
    pub requested_model: Option<String>,
    /// Rows at or after this instant (ms).
    pub since_ms: i64,
    pub grain_ms: i64,
    /// Opaque to the writer; echoed back (the limiter's window index).
    pub tag: u8,
    /// The instant the seed was asked for, echoed back.
    pub now: f64,
    /// Most row stamps to return (the oldest), so the payload is bounded.
    pub stamp_cap: usize,
}

/// What a seed read: bucket sums and every retained done row's `at`.
#[derive(Debug, Clone, PartialEq)]
pub struct SeedRows {
    pub buckets: Vec<(i64, omni_ratelimit::buckets::Counts)>,
    pub stamps: Vec<i64>,
}

/// What the writer tells its commit sink, in the order it happened.
#[derive(Debug, Clone, PartialEq)]
pub enum Committed {
    /// A committed completion notification was shed. All following seeds and
    /// debits are ordered after this invalidation marker.
    Gap,
    /// One committed batch's completed rows.
    Completions(Vec<Completion>),
    /// A seed's read, taken after every completion delivered before it and
    /// before every one delivered after it.
    Seed {
        query: SeedQuery,
        result: Result<SeedRows, String>,
    },
}
