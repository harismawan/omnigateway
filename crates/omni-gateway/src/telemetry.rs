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
//! **Hot path.** Every write resolves its raw series through an immutable,
//! sharded index read without a lock (`arc_swap`), then updates atomics. The
//! creation mutex is taken only to create a series; the new entry is published
//! to its shard before the lock is released, so an established series is
//! always lock-free. A raw series' resolution never changes once made — the
//! raw count only grows, so a folded series stays folded — so caching it is
//! exact. A scrape takes the creation lock only to copy the series lists,
//! then formats without it.
//!
//! **Coherent histograms.** A histogram is two buffers and a hot index
//! (Prometheus `client_golang`'s scheme): writers bump an observation counter
//! carrying the hot index and write the hot buffer, its count last; a scrape
//! (serialized per series) flips the index, waits until the cold buffer's
//! count equals the observations started before the flip, reads it, and folds
//! it into the new hot buffer. A scrape therefore sees whole observations
//! only: finite buckets ≤ `+Inf` == `_count`, and `_sum` of the same set.

use std::collections::{HashMap, HashSet};
use std::hash::BuildHasher as _;
use std::sync::atomic::{
    AtomicU64,
    Ordering::{Acquire, Relaxed, Release, SeqCst},
};
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

/// Adds `v` to an `f64` stored as bits.
fn add_f64(cell: &AtomicU64, v: f64) {
    let mut cur = cell.load(Relaxed);
    loop {
        let next = (f64::from_bits(cur) + v).to_bits();
        match cell.compare_exchange_weak(cur, next, Relaxed, Relaxed) {
            Ok(_) => return,
            Err(seen) => cur = seen,
        }
    }
}

/// One histogram buffer: per-bucket counts (the first boundary a value
/// fits; summed at render into TS's cumulative counts, `NaN` fitting none),
/// the sum, and the observations completed, written last.
#[derive(Debug, Default)]
struct Counts {
    buckets: [AtomicU64; 13],
    sum: AtomicU64,
    count: AtomicU64,
}

/// The hot index in the top bit, observations started below it.
const HOT_BIT: u64 = 1 << 63;

/// A histogram's two buffers. See the module documentation.
#[derive(Debug, Default)]
struct Histogram {
    hot: AtomicU64,
    counts: [Counts; 2],
    /// Serializes snapshots (scrapes) and the non-hot-path `add`/`set`.
    scrape: Mutex<()>,
}

/// A coherent read of one histogram.
struct HistSnapshot {
    buckets: [u64; 13],
    sum: f64,
    count: u64,
}

impl Histogram {
    fn observe(&self, v: f64) {
        let n = self.hot.fetch_add(1, SeqCst);
        let c = &self.counts[usize::from(n & HOT_BIT != 0)];
        if let Some(i) = BUCKETS.iter().position(|edge| v <= *edge) {
            c.buckets[i].fetch_add(1, Relaxed);
        }
        add_f64(&c.sum, v);
        // Last: a scrape that sees this count sees the bucket and the sum.
        c.count.fetch_add(1, Release);
    }

    fn lock(&self) -> MutexGuard<'_, ()> {
        self.scrape.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Flips the hot index, waits out writers still in the old buffer, folds
    /// it into the new one and returns what it held. Caller holds `scrape`.
    fn swap(&self) -> HistSnapshot {
        let n = self.hot.fetch_add(HOT_BIT, SeqCst);
        let started = n & !HOT_BIT;
        let old = usize::from(n & HOT_BIT != 0);
        let (cold, hot) = (&self.counts[old], &self.counts[1 - old]);
        // Every observation started before the flip lands in `cold`; each
        // is a handful of atomics, so this wait is short.
        let mut spins = 0u32;
        while cold.count.load(Acquire) != started {
            spins += 1;
            if spins < 64 {
                std::hint::spin_loop();
            } else {
                std::thread::yield_now();
            }
        }
        let mut buckets = [0u64; 13];
        for (i, b) in cold.buckets.iter().enumerate() {
            buckets[i] = b.swap(0, Relaxed);
            hot.buckets[i].fetch_add(buckets[i], Relaxed);
        }
        let sum = f64::from_bits(cold.sum.swap(0f64.to_bits(), Relaxed));
        add_f64(&hot.sum, sum);
        cold.count.store(0, Relaxed);
        hot.count.fetch_add(started, Release);
        HistSnapshot {
            buckets,
            sum,
            count: started,
        }
    }

    fn snapshot(&self) -> HistSnapshot {
        let _g = self.lock();
        self.swap()
    }

    /// `add` on a histogram's value (its sum, as TS stores it). Not a path
    /// any recording site takes; serialized with scrapes so it is not lost.
    fn add(&self, v: f64) {
        let _g = self.lock();
        let hot = usize::from(self.hot.load(SeqCst) & HOT_BIT != 0);
        add_f64(&self.counts[hot].sum, v);
    }

    /// `set` on a histogram's value: the sum becomes `v`, counts kept. The
    /// swap first folds both buffers into the hot one, so its sum is the
    /// whole value being replaced.
    fn set(&self, v: f64) {
        let _g = self.lock();
        let _folded = self.swap();
        let hot = usize::from(self.hot.load(SeqCst) & HOT_BIT != 0);
        self.counts[hot].sum.store(v.to_bits(), Relaxed);
    }
}

/// One stored series: a counter or gauge value (`f64` bits), or a histogram.
#[derive(Debug)]
struct Series {
    labels: Box<[(Box<str>, Box<str>)]>,
    value: AtomicU64,
    hist: Option<Box<Histogram>>,
}

impl Series {
    fn new(metric: Metric, labels: Box<[(Box<str>, Box<str>)]>) -> Self {
        Self {
            labels,
            value: AtomicU64::new(0f64.to_bits()),
            hist: (metric.kind() == Kind::Histogram).then(Box::default),
        }
    }

    fn add(&self, v: f64) {
        match &self.hist {
            Some(h) => h.add(v),
            None => add_f64(&self.value, v),
        }
    }

    fn set(&self, v: f64) {
        match &self.hist {
            Some(h) => h.set(v),
            None => self.value.store(v.to_bits(), Relaxed),
        }
    }

    fn observe(&self, v: f64) {
        match &self.hist {
            Some(h) => h.observe(v),
            // TS's `observe` on a counter or gauge adds the value and keeps a
            // count and buckets that a non-histogram never renders.
            None => add_f64(&self.value, v),
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

/// Raw series key → the series it resolved to, for one shard. `foldhash`:
/// the index is probed on every write, and the keys are this process's own
/// label sets.
type Index = HashMap<Arc<str>, Arc<Series>, foldhash::fast::RandomState>;

/// Index shards: a creation republishes one shard, so the copy is a
/// 1/`SHARDS` slice of the resolved series, not all of them.
const SHARDS: usize = 256;

fn shard_of(key: &str) -> usize {
    static PICK: std::sync::OnceLock<foldhash::fast::FixedState> = std::sync::OnceLock::new();
    #[allow(clippy::cast_possible_truncation)]
    let h = PICK
        .get_or_init(foldhash::fast::FixedState::default)
        .hash_one(key) as usize;
    h % SHARDS
}

/// One metric's series: normalized key → series, and creation order.
type Table = (HashMap<Box<str>, Arc<Series>>, Vec<Arc<Series>>);

#[derive(Debug, Default)]
struct State {
    /// `rawSeries`: raw keys counted against the cap.
    raw_series: HashSet<Arc<str>>,
    /// `folded`: raw keys already counted as folded.
    folded: HashSet<Arc<str>>,
    /// Every resolved raw key, folded or not, by shard; each published
    /// shard is a copy of its entry here.
    resolved: Vec<Index>,
    /// Per metric, normalized key → series, and the series in creation order.
    tables: Vec<Table>,
}

/// `createMetricRegistry`.
#[derive(Debug)]
pub struct Registry {
    max_series: f64,
    index: Box<[ArcSwap<Index>]>,
    state: Mutex<State>,
    /// Writes that took the creation lock (test hook).
    locked: AtomicU64,
}

thread_local! {
    static KEY: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

/// The identity of a label set: metric, then pairs sorted by name, each
/// length-prefixed so no two sets share a key. A repeated name counts once
/// with its last value, as the label object TS builds from it does.
fn write_key(metric: Metric, labels: &[(&str, &str)], out: &mut String) {
    out.clear();
    let mut sorted: smallvec_like::Pairs<'_> = smallvec_like::Pairs::from(labels);
    sorted.sort();
    push_decimal(out, metric.index() as u64);
    out.push('|');
    let mut it = sorted.iter().peekable();
    while let Some((k, v)) = it.next() {
        // Stable sort: the last of a run of equal names is the last written.
        if it.peek().is_some_and(|(next, _)| next == k) {
            continue;
        }
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
        /// Stable, so repeated names keep their write order.
        pub fn sort(&mut self) {
            match &mut self.spill {
                Some(v) => v.sort_by(|a, b| a.0.cmp(b.0)),
                None => self.inline[..self.len].sort_by(|a, b| a.0.cmp(b.0)),
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

/// `{ ...labels }`: a repeated name keeps its first position, last value.
fn dedupe<'a>(labels: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
    let mut out: Vec<(&str, &str)> = Vec::with_capacity(labels.len());
    for &(k, v) in labels {
        match out.iter_mut().find(|(pk, _)| *pk == k) {
            Some(p) => p.1 = v,
            None => out.push((k, v)),
        }
    }
    out
}

impl Registry {
    pub fn new(max_series: f64) -> Self {
        Self {
            max_series,
            index: (0..SHARDS)
                .map(|_| ArcSwap::from_pointee(Index::default()))
                .collect(),
            state: Mutex::new(State {
                resolved: (0..SHARDS).map(|_| Index::default()).collect(),
                tables: (0..DEFINITIONS.len()).map(|_| Default::default()).collect(),
                ..State::default()
            }),
            locked: AtomicU64::new(0),
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
            let shard = shard_of(key);
            if let Some(series) = self.index[shard].load().get(key.as_str()) {
                op.apply(series);
                return;
            }
            self.locked.fetch_add(1, Relaxed);
            let series = {
                let mut st = self.lock();
                self.resolve(&mut st, metric, labels, key)
            };
            // Outside the lock: a histogram `set` waits on its scrape lock.
            op.apply(&series);
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
        let shard = shard_of(raw);
        if let Some(s) = st.resolved[shard].get(raw) {
            return s.clone();
        }
        let raw: Arc<str> = Arc::from(raw);
        let labels = dedupe(labels);
        let labels = labels.as_slice();
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
                let pairs: Vec<(Box<str>, Box<str>)> = normalized
                    .into_iter()
                    .map(|(k, v)| (k.into(), v.into()))
                    .collect();
                let s = Arc::new(Series::new(metric, pairs.into_boxed_slice()));
                table.insert(nkey.into_boxed_str(), s.clone());
                order.push(s.clone());
                s
            }
        };
        st.resolved[shard].insert(raw, series.clone());
        // Published before the lock is released: an established series is
        // never left to the slow path.
        self.index[shard].store(Arc::new(st.resolved[shard].clone()));
        series
    }

    /// Test hook: whether a write of this label set resolves without the lock.
    #[doc(hidden)]
    pub fn is_lock_free(&self, metric: Metric, labels: &[(&str, &str)]) -> bool {
        let mut key = String::new();
        write_key(metric, labels, &mut key);
        self.index[shard_of(&key)].load().contains_key(key.as_str())
    }

    /// Test hook: how many writes have taken the creation lock.
    #[doc(hidden)]
    pub fn locked_writes(&self) -> u64 {
        self.locked.load(Relaxed)
    }

    /// Test hook: whether a render holds the creation lock while it formats.
    #[doc(hidden)]
    pub fn render_holds_creation_lock(&self) -> bool {
        let mut held = false;
        self.render_with(&mut || {
            held = matches!(
                self.state.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            );
        });
        held
    }

    /// `renderPrometheus(snapshot())`.
    pub fn render(&self) -> String {
        self.render_with(&mut || {})
    }

    /// Copies the series lists under the creation lock, then formats without
    /// it; `probe` runs once mid-format.
    fn render_with(&self, probe: &mut dyn FnMut()) -> String {
        let lists: Vec<Vec<Arc<Series>>> = {
            let st = self.lock();
            st.tables.iter().map(|(_, order)| order.clone()).collect()
        };
        let mut probe = Some(probe);
        let mut out = String::new();
        for (metric, name, kind, help) in DEFINITIONS {
            let order = &lists[metric.index()];
            if order.is_empty() {
                continue;
            }
            if let Some(p) = probe.take() {
                p();
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
                match (&s.hist, kind) {
                    (Some(h), Kind::Histogram) => {
                        let snap = h.snapshot();
                        let mut cumulative = 0u64;
                        for (i, le) in BUCKET_LABELS.iter().enumerate() {
                            cumulative += snap.buckets[i];
                            sample(&mut out, name, "_bucket", &s.labels, Some(le));
                            push_u64(&mut out, cumulative);
                        }
                        sample(&mut out, name, "_bucket", &s.labels, Some("+Inf"));
                        push_u64(&mut out, snap.count);
                        sample(&mut out, name, "_sum", &s.labels, None);
                        push_number(&mut out, snap.sum);
                        sample(&mut out, name, "_count", &s.labels, None);
                        push_u64(&mut out, snap.count);
                    }
                    _ => {
                        sample(&mut out, name, "", &s.labels, None);
                        push_number(&mut out, f64::from_bits(s.value.load(Relaxed)));
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
