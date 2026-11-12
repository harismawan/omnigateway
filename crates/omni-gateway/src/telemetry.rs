//! The Prometheus registry and renderer (`telemetry/registry.ts`,
//! `telemetry/render.ts`) and the recording hooks of `telemetry/index.ts`.
//!
//! Same series, help and type lines, label sets and order, escaping, bucket
//! boundaries, number formatting and cardinality cap as TS:
//!
//! - A series is identified by its metric and label *set*; its labels render
//!   in the order of the first write that created it.
//! - The cap counts raw series (as written, before folding). Once
//!   `maxSeries` raw series exist, a new raw series that carries `api_key_id`
//!   is folded into the same labels with `api_key_id="other"`, and the first
//!   fold of each raw series counts one `omni_metrics_series_folded_total`.
//!   Series without `api_key_id` are never folded and always count.
//! - Metrics render in definition order; a metric with no series is omitted.
//!
//! **Hot path.** Every write resolves its raw series through an immutable
//! index read without a lock (`arc_swap`), then updates atomics. The mutex is
//! taken only to create a series (or for a series created since the index was
//! last published), and by a scrape. A raw series' resolution never changes
//! once made — the raw count only grows, so a folded series stays folded — so
//! caching the resolution is exact.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use arc_swap::ArcSwap;

/// `HISTOGRAM_BUCKETS`, and `String()` of each as the `le` label.
const BUCKETS: [f64; 13] = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0,
];
const BUCKET_LABELS: [&str; 13] = [
    "0.005", "0.01", "0.025", "0.05", "0.1", "0.25", "0.5", "1", "2.5", "5", "10", "30", "60",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Counter,
    Gauge,
    Histogram,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Counter => "counter",
            Kind::Gauge => "gauge",
            Kind::Histogram => "histogram",
        }
    }
}

macro_rules! metrics {
    ($($variant:ident => $name:literal, $kind:ident, $help:literal;)*) => {
        /// `MetricName`, in `DEFINITIONS` order (the render order).
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum Metric { $($variant),* }

        const DEFINITIONS: &[(Metric, &str, Kind, &str)] = &[
            $((Metric::$variant, $name, Kind::$kind, $help)),*
        ];
    };
}

metrics! {
    RequestsTotal => "omni_requests_total", Counter, "Requests completed by this process.";
    RequestDuration => "omni_request_duration_seconds", Histogram, "Request duration in seconds.";
    Ttft => "omni_ttft_seconds", Histogram, "Streaming time to first token in seconds.";
    TokensTotal => "omni_tokens_total", Counter, "Billable tokens completed by this process.";
    CostUsdTotal => "omni_cost_usd_total", Counter, "Request cost in US dollars.";
    UpstreamDuration => "omni_upstream_duration_seconds", Histogram, "Provider response-head duration in seconds.";
    Inflight => "omni_inflight", Gauge, "Provider requests in flight in this process.";
    BreakerOpen => "omni_breaker_open", Gauge, "Credential breakers observed open in this process.";
    RatelimitRejectedTotal => "omni_ratelimit_rejected_total", Counter, "API-key rate-limit refusals.";
    StreamConnections => "omni_stream_connections", Gauge, "Live stream connections in this process.";
    StreamQueued => "omni_stream_queued", Gauge, "Stream frames queued in this process.";
    StreamDroppedTotal => "omni_stream_dropped_total", Counter, "Stream frames dropped in this process.";
    CoordFallback => "omni_coord_fallback", Gauge, "Whether this process is using coordination fallback.";
    CoordFaultsTotal => "omni_coord_faults_total", Counter, "Coordinator calls this process answered from memory, timeouts included.";
    SeriesFoldedTotal => "omni_metrics_series_folded_total", Counter, "Metric series folded into api_key_id other.";
    OtlpSpansDroppedTotal => "omni_otlp_spans_dropped_total", Counter, "Spans dropped before OTLP export.";
    BuildInfo => "omni_build_info", Gauge, "Gateway build information.";
}

impl Metric {
    fn index(self) -> usize {
        self as usize
    }

    fn kind(self) -> Kind {
        DEFINITIONS[self.index()].2
    }

    /// The metric named `name`, if TS defines it.
    pub fn from_name(name: &str) -> Option<Metric> {
        DEFINITIONS
            .iter()
            .find(|(_, n, _, _)| *n == name)
            .map(|(m, _, _, _)| *m)
    }
}

/// One stored series. Values are `f64` bits; histogram buckets are counted
/// per bucket (the first boundary the value fits) and summed at render, which
/// is TS's cumulative count for every value but `NaN`, which fits none.
#[derive(Debug)]
struct Series {
    labels: Box<[(Box<str>, Box<str>)]>,
    value: AtomicU64,
    count: AtomicU64,
    buckets: Option<Box<[AtomicU64; 13]>>,
}

impl Series {
    fn new(metric: Metric, labels: Box<[(Box<str>, Box<str>)]>) -> Self {
        Self {
            labels,
            value: AtomicU64::new(0f64.to_bits()),
            count: AtomicU64::new(0),
            buckets: (metric.kind() == Kind::Histogram)
                .then(|| Box::new(std::array::from_fn(|_| AtomicU64::new(0)))),
        }
    }

    fn add(&self, v: f64) {
        let mut cur = self.value.load(Relaxed);
        loop {
            let next = (f64::from_bits(cur) + v).to_bits();
            match self
                .value
                .compare_exchange_weak(cur, next, Relaxed, Relaxed)
            {
                Ok(_) => return,
                Err(seen) => cur = seen,
            }
        }
    }

    fn set(&self, v: f64) {
        self.value.store(v.to_bits(), Relaxed);
    }

    fn observe(&self, v: f64) {
        self.add(v);
        self.count.fetch_add(1, Relaxed);
        if let Some(b) = &self.buckets
            && let Some(i) = BUCKETS.iter().position(|edge| v <= *edge)
        {
            b[i].fetch_add(1, Relaxed);
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum Op {
    Add(f64),
    Set(f64),
    Observe(f64),
}

impl Op {
    fn apply(self, s: &Series) {
        match self {
            Op::Add(v) => s.add(v),
            Op::Set(v) => s.set(v),
            Op::Observe(v) => s.observe(v),
        }
    }
}

/// Raw series key → the series it resolved to. `foldhash`: the index is
/// probed on every write, and the keys are this process's own label sets.
type Index = HashMap<Arc<str>, Arc<Series>, foldhash::fast::RandomState>;

/// One metric's series: normalized key → series, and creation order.
type Table = (HashMap<Box<str>, Arc<Series>>, Vec<Arc<Series>>);

#[derive(Debug, Default)]
struct State {
    /// `rawSeries`: raw keys counted against the cap.
    raw_series: HashSet<Arc<str>>,
    /// `folded`: raw keys already counted as folded.
    folded: HashSet<Arc<str>>,
    /// Every resolved raw key, folded or not; the index is a copy of this.
    resolved: Index,
    /// Per metric, normalized key → series, and the series in creation order.
    tables: Vec<Table>,
    /// `resolved.len()` when the index was last published.
    published: usize,
}

/// `createMetricRegistry`.
#[derive(Debug)]
pub struct Registry {
    max_series: f64,
    index: ArcSwap<Index>,
    state: Mutex<State>,
}

thread_local! {
    static KEY: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

/// The identity of a label set: metric, then pairs sorted by name, each
/// length-prefixed so no two sets share a key.
fn write_key(metric: Metric, labels: &[(&str, &str)], out: &mut String) {
    out.clear();
    let mut sorted: smallvec_like::Pairs<'_> = smallvec_like::Pairs::from(labels);
    sorted.sort();
    push_decimal(out, metric.index() as u64);
    out.push('|');
    for (k, v) in sorted.iter() {
        push_decimal(out, k.len() as u64);
        out.push(':');
        out.push_str(k);
        push_decimal(out, v.len() as u64);
        out.push(':');
        out.push_str(v);
    }
}

fn push_decimal(out: &mut String, mut n: u64) {
    let mut buf = [0u8; 20];
    let mut i = buf.len();
    loop {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    for &b in &buf[i..] {
        out.push(char::from(b));
    }
}

/// A fixed-capacity copy of a label slice for sorting without allocating.
mod smallvec_like {
    pub struct Pairs<'a> {
        inline: [(&'a str, &'a str); 8],
        len: usize,
        spill: Option<Vec<(&'a str, &'a str)>>,
    }

    impl<'a> From<&[(&'a str, &'a str)]> for Pairs<'a> {
        fn from(labels: &[(&'a str, &'a str)]) -> Self {
            if labels.len() <= 8 {
                let mut inline = [("", ""); 8];
                inline[..labels.len()].copy_from_slice(labels);
                Self {
                    inline,
                    len: labels.len(),
                    spill: None,
                }
            } else {
                Self {
                    inline: [("", ""); 8],
                    len: 0,
                    spill: Some(labels.to_vec()),
                }
            }
        }
    }

    impl<'a> Pairs<'a> {
        pub fn sort(&mut self) {
            match &mut self.spill {
                Some(v) => v.sort_unstable_by(|a, b| a.0.cmp(b.0)),
                None => self.inline[..self.len].sort_unstable_by(|a, b| a.0.cmp(b.0)),
            }
        }

        pub fn iter(&self) -> impl Iterator<Item = &(&'a str, &'a str)> {
            match &self.spill {
                Some(v) => v.iter(),
                None => self.inline[..self.len].iter(),
            }
        }
    }
}

/// Republish the index on every new series while it is small, then once
/// it has grown by an eighth: copying stays linear overall, and a stale
/// index only sends a recently created series' writers through the lock.
fn should_publish(resolved: usize, published: usize) -> bool {
    resolved <= 1024 || resolved - published >= resolved / 8
}

impl Registry {
    pub fn new(max_series: f64) -> Self {
        Self {
            max_series,
            index: ArcSwap::from_pointee(Index::default()),
            state: Mutex::new(State {
                tables: (0..DEFINITIONS.len()).map(|_| Default::default()).collect(),
                ..State::default()
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn add(&self, metric: Metric, labels: &[(&str, &str)], value: f64) {
        self.change(metric, labels, Op::Add(value));
    }

    pub fn set(&self, metric: Metric, labels: &[(&str, &str)], value: f64) {
        self.change(metric, labels, Op::Set(value));
    }

    pub fn observe(&self, metric: Metric, value: f64, labels: &[(&str, &str)]) {
        self.change(metric, labels, Op::Observe(value));
    }

    fn change(&self, metric: Metric, labels: &[(&str, &str)], op: Op) {
        KEY.with(|cell| {
            // A re-entrant use (none today) falls back to a fresh buffer.
            let mut owned;
            let mut borrowed = cell.try_borrow_mut();
            let key: &mut String = match &mut borrowed {
                Ok(b) => b,
                Err(_) => {
                    owned = String::new();
                    &mut owned
                }
            };
            write_key(metric, labels, key);
            if let Some(series) = self.index.load().get(key.as_str()) {
                op.apply(series);
                return;
            }
            let mut st = self.lock();
            let series = self.resolve(&mut st, metric, labels, key);
            op.apply(&series);
            if st.resolved.len() != st.published && should_publish(st.resolved.len(), st.published)
            {
                st.published = st.resolved.len();
                self.index.store(Arc::new(st.resolved.clone()));
            }
        });
    }

    /// `normalize` plus the table lookup, under the lock.
    fn resolve(
        &self,
        st: &mut State,
        metric: Metric,
        labels: &[(&str, &str)],
        raw: &str,
    ) -> Arc<Series> {
        if let Some(s) = st.resolved.get(raw) {
            return s.clone();
        }
        let raw: Arc<str> = Arc::from(raw);
        let has_key = labels.iter().any(|(k, _)| *k == "api_key_id");
        #[allow(clippy::cast_precision_loss)]
        let under_cap = (st.raw_series.len() as f64) < self.max_series;
        let normalized: Vec<(&str, &str)> = if under_cap || !has_key {
            st.raw_series.insert(raw.clone());
            labels.to_vec()
        } else {
            if st.folded.insert(raw.clone()) {
                let mut key = String::new();
                write_key(Metric::SeriesFoldedTotal, &[], &mut key);
                let folded = self.resolve(st, Metric::SeriesFoldedTotal, &[], &key);
                folded.add(1.0);
            }
            labels
                .iter()
                .map(|&(k, v)| {
                    if k == "api_key_id" {
                        (k, "other")
                    } else {
                        (k, v)
                    }
                })
                .collect()
        };
        let mut nkey = String::new();
        write_key(metric, &normalized, &mut nkey);
        let (table, order) = &mut st.tables[metric.index()];
        let series = match table.get(nkey.as_str()) {
            Some(s) => s.clone(),
            None => {
                // An object's keys: a repeated name keeps its first position
                // and its last value.
                let mut pairs: Vec<(Box<str>, Box<str>)> = Vec::with_capacity(normalized.len());
                for (k, v) in normalized {
                    match pairs.iter_mut().find(|(pk, _)| &**pk == k) {
                        Some(p) => p.1 = v.into(),
                        None => pairs.push((k.into(), v.into())),
                    }
                }
                let s = Arc::new(Series::new(metric, pairs.into_boxed_slice()));
                table.insert(nkey.into_boxed_str(), s.clone());
                order.push(s.clone());
                s
            }
        };
        st.resolved.insert(raw, series.clone());
        series
    }

    /// `renderPrometheus(snapshot())`.
    pub fn render(&self) -> String {
        let st = self.lock();
        let mut out = String::new();
        for (metric, name, kind, help) in DEFINITIONS {
            let order = &st.tables[metric.index()].1;
            if order.is_empty() {
                continue;
            }
            out.push_str("# HELP ");
            out.push_str(name);
            out.push(' ');
            out.push_str(help);
            out.push_str("\n# TYPE ");
            out.push_str(name);
            out.push(' ');
            out.push_str(kind.as_str());
            out.push('\n');
            for s in order {
                let value = f64::from_bits(s.value.load(Relaxed));
                match (&s.buckets, kind) {
                    (Some(buckets), Kind::Histogram) => {
                        let count = s.count.load(Relaxed);
                        let mut cumulative = 0u64;
                        for (i, le) in BUCKET_LABELS.iter().enumerate() {
                            cumulative += buckets[i].load(Relaxed);
                            sample(&mut out, name, "_bucket", &s.labels, Some(le));
                            push_u64(&mut out, cumulative);
                        }
                        sample(&mut out, name, "_bucket", &s.labels, Some("+Inf"));
                        push_u64(&mut out, count);
                        sample(&mut out, name, "_sum", &s.labels, None);
                        push_number(&mut out, value);
                        sample(&mut out, name, "_count", &s.labels, None);
                        push_u64(&mut out, count);
                    }
                    _ => {
                        sample(&mut out, name, "", &s.labels, None);
                        push_number(&mut out, value);
                    }
                }
            }
        }
        // `${out.join("\n")}\n`: every line ends in one newline, and an
        // empty registry is the single newline of joining nothing.
        if out.is_empty() {
            out.push('\n');
        }
        out
    }
}

/// One sample line up to its value: name, suffix, `{labels}` and a space.
fn sample(
    out: &mut String,
    name: &str,
    suffix: &str,
    labels: &[(Box<str>, Box<str>)],
    le: Option<&str>,
) {
    out.push_str(name);
    out.push_str(suffix);
    if !labels.is_empty() || le.is_some() {
        out.push('{');
        let mut first = true;
        let extra = le.map(|v| ("le", v));
        for (k, v) in labels.iter().map(|(k, v)| (&**k, &**v)).chain(extra) {
            if !first {
                out.push(',');
            }
            first = false;
            out.push_str(k);
            out.push_str("=\"");
            for c in v.chars() {
                match c {
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '"' => out.push_str("\\\""),
                    c => out.push(c),
                }
            }
            out.push('"');
        }
        out.push('}');
    }
    out.push(' ');
}

fn push_u64(out: &mut String, n: u64) {
    push_decimal(out, n);
    out.push('\n');
}

/// `number()`: `String(value)`, with Prometheus' spellings of the infinities.
fn push_number(out: &mut String, v: f64) {
    if v == f64::INFINITY {
        out.push_str("+Inf");
    } else if v == f64::NEG_INFINITY {
        out.push_str("-Inf");
    } else if v.is_nan() {
        out.push_str("NaN");
    } else {
        omni_ir::jsjson::write_number(v, out);
    }
    out.push('\n');
}

/// `createTelemetry`'s metrics half. Recording is a no-op unless metrics are
/// enabled (`OMNI_METRICS_TOKEN` set), as in TS; OTLP export is not ported.
#[derive(Debug)]
pub struct Telemetry {
    enabled: bool,
    registry: Registry,
    /// `openBreakers`: per provider, in first-seen order.
    open_breakers: Mutex<Vec<(String, f64)>>,
}

/// The gateway's own version (`version.ts`): a build-time `OMNI_CLI_VERSION`
/// wins, then `OMNI_VERSION` from the environment, then `0.0.0-dev`.
pub fn version(env: &HashMap<String, String>) -> String {
    match option_env!("OMNI_CLI_VERSION") {
        Some(v) => v.to_owned(),
        None => env
            .get("OMNI_VERSION")
            .cloned()
            .unwrap_or_else(|| "0.0.0-dev".to_owned()),
    }
}

impl Telemetry {
    pub fn new(enabled: bool, max_series: f64, version: &str) -> Self {
        let t = Self {
            enabled,
            registry: Registry::new(max_series),
            open_breakers: Mutex::new(Vec::new()),
        };
        if enabled {
            t.registry
                .set(Metric::BuildInfo, &[("version", version)], 1.0);
        }
        t
    }

    /// Off: every hook returns at once.
    pub fn disabled() -> Self {
        Self::new(false, 5000.0, "")
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// `record(log, keyId)`: one finished request, from `finishLog`.
    #[allow(clippy::cast_precision_loss)]
    pub fn record(&self, log: &omni_store::writer::RequestLog) {
        if !self.enabled {
            return;
        }
        let r = &self.registry;
        let provider = log.resolved_provider.as_deref().unwrap_or("");
        let model = log
            .resolved_model
            .as_deref()
            .unwrap_or(&log.requested_model);
        let key = log.api_key_id.as_deref().unwrap_or("");
        let status = log.status.to_string();
        r.add(
            Metric::RequestsTotal,
            &[
                ("provider", provider),
                ("model", model),
                ("status", &status),
                ("code", log.error_code.as_deref().unwrap_or("")),
                ("api_key_id", key),
            ],
            1.0,
        );
        let pm = [("provider", provider), ("model", model)];
        r.observe(
            Metric::RequestDuration,
            log.duration_ms as f64 / 1000.0,
            &pm,
        );
        if let Some(ttft) = log.ttft_ms {
            r.observe(Metric::Ttft, ttft as f64 / 1000.0, &pm);
        }
        for (kind, value) in [
            ("input", log.input_tokens),
            ("output", log.output_tokens),
            ("cache_read", log.cache_read_tokens),
            ("cache_write", log.cache_write_tokens),
        ] {
            r.add(
                Metric::TokensTotal,
                &[
                    ("provider", provider),
                    ("model", model),
                    ("api_key_id", key),
                    ("kind", kind),
                ],
                value as f64,
            );
        }
        r.add(
            Metric::CostUsdTotal,
            &[
                ("provider", provider),
                ("model", model),
                ("api_key_id", key),
            ],
            log.cost_usd,
        );
    }

    /// `httpHead`: a provider response head (or transport failure) arrived.
    #[allow(clippy::cast_precision_loss)]
    pub fn http_head(&self, provider: &str, duration_ms: u64) {
        if self.enabled {
            self.registry.observe(
                Metric::UpstreamDuration,
                duration_ms as f64 / 1000.0,
                &[("provider", provider)],
            );
        }
    }

    /// `breaker(provider, before, after)`.
    pub fn breaker(
        &self,
        provider: &str,
        before: &omni_store::BreakerState,
        after: &omni_store::BreakerState,
    ) {
        use omni_store::BreakerState::Open;
        if !self.enabled || before == after {
            return;
        }
        let delta = if *after == Open {
            1.0
        } else if *before == Open {
            -1.0
        } else {
            0.0
        };
        let mut open = self
            .open_breakers
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let i = match open.iter().position(|(p, _)| p == provider) {
            Some(i) => i,
            None => {
                open.push((provider.to_owned(), 0.0));
                open.len() - 1
            }
        };
        let count = (open[i].1 + delta).max(0.0);
        open[i].1 = count;
        self.registry
            .set(Metric::BreakerOpen, &[("provider", provider)], count);
    }

    /// `rateLimit(dimension, window)`: an API-key rate-limit refusal.
    pub fn rate_limit(&self, dimension: &str, window: Option<&str>) {
        if self.enabled {
            self.registry.add(
                Metric::RatelimitRejectedTotal,
                &[
                    ("dimension", dimension),
                    ("window", window.unwrap_or("none")),
                ],
                1.0,
            );
        }
    }

    /// `scrape(...)`: the gauges read at scrape time, then the text. This
    /// process has no stream sockets (0, 0, 0) and an in-memory coordinator
    /// (never in fallback, no faults), which is what TS reports for them.
    #[allow(clippy::cast_precision_loss)]
    pub fn scrape(&self, inflight: &[(String, u64)]) -> String {
        let r = &self.registry;
        for (provider, n) in inflight {
            r.set(Metric::Inflight, &[("provider", provider)], *n as f64);
        }
        r.set(Metric::StreamConnections, &[], 0.0);
        r.set(Metric::StreamQueued, &[], 0.0);
        r.set(Metric::StreamDroppedTotal, &[], 0.0);
        r.set(Metric::CoordFallback, &[], 0.0);
        r.set(Metric::CoordFaultsTotal, &[], 0.0);
        r.render()
    }
}
