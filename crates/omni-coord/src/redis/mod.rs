//! `redisCoord`: the fleet's coordinator on Redis or Valkey, and what it does
//! when the server is not there.
//!
//! Two layers:
//!
//! - [`Remote`] — every primitive against the server, returning an explicit
//!   [`Fault`] on a transport fault, a timeout or a server error. A caller
//!   that wants to choose its own degraded mode (D3's combined admission
//!   script turning a fault into local limiting) uses this.
//! - [`RedisCoord`] — the [`Coord`] TS's `redisCoord` is: on a fault, the
//!   proxy-path primitives (window, gauge, buckets, pubsub, incr) fall through
//!   to an embedded [`MemoryCoord`], so limits degrade to per-process and no
//!   request is refused over it; a lease that cannot be confirmed is not
//!   held; a lock that cannot be taken is `LOCK_UNAVAILABLE`; and `kv` is
//!   [`CoordError::Unavailable`] (TS `OVERLOADED`), because a session verified
//!   against a fallback map is one a password change elsewhere cannot end.
//!
//! Plumbing (spec "Redis"): one pipelined command connection with a single
//! ordered, bounded submission queue (`link`; its own RESP2 reader, not the
//! `redis` crate's multiplexer, whose send channel cannot order a detached
//! release ahead of a later admission), one pub/sub connection (the `redis`
//! crate's), scripts loaded once per connect and called by `EVALSHA` (resent
//! whole on `NOSCRIPT` ahead of anything unwritten; detached releases go as
//! `EVAL`), a deadline on every command, and reconnection with backoff for
//! both connections. The `redis` crate still encodes every command.
//!
//! Key schema (identical to TS; `NS` = `omni:`):
//!
//! | primitive | key | type |
//! |---|---|---|
//! | window | `omni:w:<name>` | ZSET, member `<stamp>-<uuid>`, score stamp |
//! | gauge | `omni:g:<name>` + index `omni:gidx:<prefix-to-first-colon>` | ZSET by expiry + SET |
//! | buckets | `omni:b:<name>` | HASH `seeded`, `<start>:r|t|c` |
//! | lease | `omni:lease:<name>` | STRING holder id, `PX` |
//! | mutex | `omni:lock:<name>` | STRING random token, `PX`, `NX` |
//! | incr / sequence | `omni:seq:<name>` | STRING counter |
//! | kv | `omni:kv:<name>` | STRING value, `PX` |
//! | pubsub | channel `omni:pubsub` | JSON `{"topic","payload"}` |

mod link;
mod resp;
pub mod scripts;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use redis::Value;
use tokio::sync::watch;

use crate::memory::MemoryCoord;
use crate::{
    BucketRow, Clock, Coord, CoordError, Counts, Handler, LockToken, RECONNECTED_TOPIC,
    Subscribers, Subscription, WindowClaim, WindowCounter, js_number, system_clock,
};
pub use link::Refused;
use link::{Link, Request};
pub use scripts::CoordScript;

/// Every key this coordinator writes starts here.
pub const NS: &str = "omni:";

/// One channel carries every topic; the topic rides in the envelope.
pub const CHANNEL: &str = "omni:pubsub";

/// `omni:<kind>:<name>`.
pub fn key(kind: &str, name: &str) -> String {
    format!("{NS}{kind}:{name}")
}

/// The index set a gauge key is listed in: its prefix up to and including
/// the first colon (`load:<id>` keys share `omni:gidx:load:`). A key with no
/// colon is its own set.
pub fn gauge_index(name: &str) -> String {
    let prefix = match name.find(':') {
        Some(colon) => &name[..=colon],
        None => name,
    };
    key("gidx", prefix)
}

/// Why a call did not reach, or was not answered by, the server.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Fault {
    /// No connection is installed (never connected, or dropped and not yet
    /// re-established), or the pub/sub connection is not listening.
    #[error("not connected")]
    NotConnected,
    /// The command outran its deadline. It may still land.
    #[error("command timed out")]
    TimedOut,
    /// The connection failed under the command (its kind, not its text).
    #[error("connection: {0}")]
    Connection(String),
    /// The server answered with an error (its code, not its text).
    #[error("server: {0}")]
    Server(String),
    /// The submission queue is at its admission capacity.
    #[error("command queue full")]
    Saturated,
}

impl Fault {
    /// The closed reason logged with a fault, as TS `describeError` names
    /// `TimedOut` "command timed out".
    pub fn reason(&self) -> &'static str {
        match self {
            Self::NotConnected => "not connected",
            Self::TimedOut => "command timed out",
            Self::Connection(_) => "connection",
            Self::Server(_) => "server error",
            Self::Saturated => "queue full",
        }
    }
}

/// Construction options. Defaults are TS's constants.
#[derive(Clone)]
pub struct RedisCoordOptions {
    /// What gauge expiry is computed against (TS `now`).
    pub now: Clock,
    /// TS `COMMAND_TIMEOUT_MS` / `commandTimeoutMs`.
    pub command_timeout: Duration,
    /// TS `connectionTimeout`: one connect attempt, scripts included.
    pub connect_timeout: Duration,
    /// TS `CONNECT_WAIT_MS`: how long construction waits for the first
    /// connect (and first subscribe) to settle.
    pub connect_wait: Duration,
    /// TS `faultLogIntervalMs`.
    pub fault_log_interval: Duration,
    /// TS `LOCK_POLL_MS`.
    pub lock_poll: Duration,
    pub reconnect_min: Duration,
    pub reconnect_max: Duration,
    /// Queued plus in-flight commands on the command connection.
    pub queue_capacity: usize,
    /// Of `queue_capacity`, what only releases may use, so a connection
    /// saturated by admissions still takes the releases that free them.
    pub release_reserve: usize,
    /// How long `close` keeps writing queued releases.
    pub drain_timeout: Duration,
    /// How often the idle command connection and the pub/sub connection are
    /// PINGed, so a dead one is replaced before a call has to fail on it and
    /// a deaf subscriber is resubscribed.
    pub heartbeat: Duration,
    /// More scripts to load at every connect, beside the built-in ones —
    /// where D3's combined admission script goes. Called through
    /// [`Remote::eval`].
    pub extra_scripts: Vec<CoordScript>,
}

impl Default for RedisCoordOptions {
    fn default() -> Self {
        Self {
            now: system_clock(),
            command_timeout: Duration::from_millis(1_000),
            connect_timeout: Duration::from_millis(2_000),
            connect_wait: Duration::from_millis(2_000),
            fault_log_interval: Duration::from_millis(30_000),
            lock_poll: Duration::from_millis(50),
            reconnect_min: link::RECONNECT_MIN,
            reconnect_max: link::RECONNECT_MAX,
            heartbeat: Duration::from_millis(1_000),
            queue_capacity: 4_096,
            release_reserve: 1_024,
            drain_timeout: Duration::from_millis(1_000),
            extra_scripts: Vec::new(),
        }
    }
}

impl std::fmt::Debug for RedisCoordOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RedisCoordOptions")
            .field("command_timeout", &self.command_timeout)
            .field("connect_timeout", &self.connect_timeout)
            .field("connect_wait", &self.connect_wait)
            .field("fault_log_interval", &self.fault_log_interval)
            .field("lock_poll", &self.lock_poll)
            .field("extra_scripts", &self.extra_scripts.len())
            .finish_non_exhaustive()
    }
}

// --- Remote: the server, with explicit faults ----------------------------

/// Every primitive against the server, with an explicit [`Fault`] instead of
/// a fallback. Cheap to clone.
#[derive(Clone)]
pub struct Remote {
    link: Arc<Link>,
    listening: Arc<AtomicBool>,
}

impl std::fmt::Debug for Remote {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Remote")
            .field("healthy", &self.link.healthy())
            .finish_non_exhaustive()
    }
}

fn eval_cmds(script: &CoordScript, keys: &[String], args: &[String]) -> (redis::Cmd, redis::Cmd) {
    let mut by_sha = redis::cmd("EVALSHA");
    by_sha.arg(&script.sha).arg(keys.len()).arg(keys).arg(args);
    let mut whole = redis::cmd("EVAL");
    whole.arg(script.source).arg(keys.len()).arg(keys).arg(args);
    (by_sha, whole)
}

fn parse_err(what: &str) -> Fault {
    Fault::Server(format!("unexpected reply to {what}"))
}

fn int_of(v: &Value) -> Option<i64> {
    match v {
        Value::Int(n) => Some(*n),
        Value::BulkString(b) => std::str::from_utf8(b).ok()?.parse().ok(),
        Value::SimpleString(s) => s.parse().ok(),
        _ => None,
    }
}

fn str_of(v: &Value) -> Option<String> {
    match v {
        Value::BulkString(b) => String::from_utf8(b.clone()).ok(),
        Value::SimpleString(s) => Some(s.clone()),
        Value::Int(n) => Some(n.to_string()),
        _ => None,
    }
}

/// JS `Number(s)` for the decimal strings Redis and Lua `tostring` write.
fn num_of(v: &Value) -> Option<f64> {
    match v {
        Value::Int(n) => Some(*n as f64),
        Value::Double(d) => Some(*d),
        _ => {
            let s = str_of(v)?;
            match s.as_str() {
                "inf" | "+inf" => Some(f64::INFINITY),
                "-inf" => Some(f64::NEG_INFINITY),
                _ => s.trim().parse().ok(),
            }
        }
    }
}

fn nonnegative(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

/// `SCAN MATCH` treats `* ? [ ] \` as glob syntax; a literal prefix escapes
/// them. (TS passes the prefix raw; every prefix TS writes is free of them,
/// so the two agree on every real key.)
fn glob_escape(prefix: &str) -> String {
    let mut out = String::with_capacity(prefix.len() + 1);
    for c in prefix.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

impl Remote {
    /// Whether the last call reached the server: what `/health` reports.
    pub fn healthy(&self) -> bool {
        self.link.healthy()
    }

    /// Faults since boot, timeouts included (`omni_coord_faults_total`).
    pub fn faults(&self) -> u64 {
        self.link.faults()
    }

    /// Whether the pub/sub connection is subscribed to [`CHANNEL`].
    pub fn listening(&self) -> bool {
        self.listening.load(Ordering::SeqCst)
    }

    /// `EVALSHA`, or `EVAL` once on `NOSCRIPT` (a server that lost its script
    /// cache), resent ahead of anything not yet written. Keys and args go as
    /// given.
    pub async fn eval(
        &self,
        script: &CoordScript,
        keys: &[String],
        args: &[String],
    ) -> Result<Value, Fault> {
        let (by_sha, whole) = eval_cmds(script, keys, args);
        let req = Request::Eval {
            by_sha: by_sha.get_packed_command(),
            whole: whole.get_packed_command(),
        };
        link::one(self.link.call(req).await?)
    }

    /// Any one command, under the deadline.
    pub async fn query(&self, cmd: redis::Cmd) -> Result<Value, Fault> {
        link::one(
            self.link
                .call(Request::One(cmd.get_packed_command()))
                .await?,
        )
    }

    /// A pipeline in one round trip, under the deadline — D3's 100 ms load
    /// publish is one of these. Any command's error fails the call. Not for
    /// `MULTI` pipelines (`Fault::Server`).
    pub async fn pipeline(&self, pipe: redis::Pipeline) -> Result<Vec<Value>, Fault> {
        if pipe.is_transaction() {
            return Err(Fault::Server("transactions unsupported".to_owned()));
        }
        if pipe.is_empty() {
            return Ok(Vec::new());
        }
        let req = Request::Many {
            bytes: pipe.get_packed_pipeline(),
            replies: pipe.len(),
        };
        self.link
            .call(req)
            .await?
            .into_iter()
            .map(|r| r.map_err(|e| Fault::Server(e.code)))
            .collect()
    }

    /// Queues a release script — `EVAL`, sent whole so a lost script cache
    /// cannot reorder it — ahead of every command submitted after this
    /// returns, and does not wait for it (TS `void evalScript(...)`).
    ///
    /// `idempotent` says the script is safe to run twice (a named gauge
    /// slot; a token compare-and-delete): such a release is kept across a
    /// reconnect, and queued even while disconnected, to be written first on
    /// the next connection. A non-idempotent one (unnamed `GAUGE_RELEASE`) is
    /// refused while disconnected and not replayed.
    ///
    /// On refusal (queue full, closing, or down) the release is counted in
    /// [`Remote::releases_dropped`] and logged, and what it would have
    /// released is held until its TTL.
    pub fn eval_detached(
        &self,
        script: &CoordScript,
        keys: &[String],
        args: &[String],
        idempotent: bool,
    ) -> Result<(), Refused> {
        let (_, whole) = eval_cmds(script, keys, args);
        self.link.release(whole.get_packed_command(), idempotent)
    }

    /// Releases not delivered since boot (refused, or lost with a retired
    /// connection): each one held something until its TTL.
    pub fn releases_dropped(&self) -> u64 {
        self.link.releases_dropped()
    }

    /// Commands queued or awaiting replies on the command connection.
    pub fn outstanding(&self) -> usize {
        self.link.outstanding()
    }

    /// Detached [`GAUGE_RELEASE`](scripts::GAUGE_RELEASE): the concurrency
    /// release D3 sends at stream end. Named slots are idempotent.
    pub fn gauge_release_detached(
        &self,
        name: &str,
        now: f64,
        holder: Option<&str>,
    ) -> Result<(), Refused> {
        self.eval_detached(
            &scripts::GAUGE_RELEASE,
            &[key("g", name)],
            &[js_number(now), holder.unwrap_or("").to_owned()],
            holder.is_some(),
        )
    }

    /// Detached token-safe lock release.
    pub fn lock_release_detached(&self, name: &str, token: &str) -> Result<(), Refused> {
        self.eval_detached(
            &scripts::MUTEX_RELEASE,
            &[key("lock", name)],
            &[token.to_owned()],
            true,
        )
    }

    pub async fn window_claim(
        &self,
        name: &str,
        window_ms: f64,
        at: f64,
    ) -> Result<WindowClaim, Fault> {
        let member = format!("{}-{}", js_number(at), uuid::Uuid::new_v4());
        let out = self
            .eval(
                &scripts::WINDOW_CLAIM,
                &[key("w", name)],
                &[js_number(at), js_number(window_ms), member],
            )
            .await?;
        let Value::Array(items) = out else {
            return Err(parse_err("WINDOW_CLAIM"));
        };
        let used = items
            .first()
            .and_then(int_of)
            .ok_or_else(|| parse_err("WINDOW_CLAIM"))?;
        let reset_at = match items.get(1) {
            None | Some(Value::Nil) => at,
            Some(oldest) => num_of(oldest).ok_or_else(|| parse_err("WINDOW_CLAIM"))? + window_ms,
        };
        Ok(WindowClaim {
            stamp: at,
            before: WindowCounter {
                used: used as f64,
                reset_at,
            },
        })
    }

    pub async fn window_rollback(&self, name: &str, stamp: f64) -> Result<(), Fault> {
        self.eval(
            &scripts::WINDOW_ROLLBACK,
            &[key("w", name)],
            &[js_number(stamp)],
        )
        .await
        .map(drop)
    }

    /// `holder` must not be blank; [`RedisCoord`] checks.
    pub async fn gauge_acquire(
        &self,
        name: &str,
        now: f64,
        ttl_ms: u64,
        holder: Option<&str>,
    ) -> Result<u64, Fault> {
        // An unnamed slot gets a uuid: a distinct member nothing can address.
        let member = holder.map_or_else(|| uuid::Uuid::new_v4().to_string(), str::to_owned);
        let out = self
            .eval(
                &scripts::GAUGE_ACQUIRE,
                &[key("g", name), gauge_index(name)],
                &[js_number(now), ttl_ms.to_string(), member],
            )
            .await?;
        int_of(&out)
            .map(nonnegative)
            .ok_or_else(|| parse_err("GAUGE_ACQUIRE"))
    }

    pub async fn gauge_renew(
        &self,
        name: &str,
        now: f64,
        holder: &str,
        ttl_ms: u64,
    ) -> Result<(), Fault> {
        self.eval(
            &scripts::GAUGE_RENEW,
            &[key("g", name)],
            &[js_number(now), ttl_ms.to_string(), holder.to_owned()],
        )
        .await
        .map(drop)
    }

    /// The unnamed release is `""` on the wire (Lua has no undefined).
    pub async fn gauge_release(
        &self,
        name: &str,
        now: f64,
        holder: Option<&str>,
    ) -> Result<(), Fault> {
        self.eval(
            &scripts::GAUGE_RELEASE,
            &[key("g", name)],
            &[js_number(now), holder.unwrap_or("").to_owned()],
        )
        .await
        .map(drop)
    }

    pub async fn gauge_read(&self, name: &str, now: f64) -> Result<u64, Fault> {
        let out = self
            .eval(&scripts::GAUGE_READ, &[key("g", name)], &[js_number(now)])
            .await?;
        int_of(&out)
            .map(nonnegative)
            .ok_or_else(|| parse_err("GAUGE_READ"))
    }

    pub async fn gauge_snapshot(
        &self,
        prefix: &str,
        now: f64,
    ) -> Result<BTreeMap<String, u64>, Fault> {
        // The index is coarser than an arbitrary prefix, so the full
        // namespaced prefix goes to the script and it filters.
        let out = self
            .eval(
                &scripts::GAUGE_SNAPSHOT,
                &[gauge_index(prefix)],
                &[js_number(now), key("g", prefix)],
            )
            .await?;
        let Value::Array(flat) = out else {
            return Err(parse_err("GAUGE_SNAPSHOT"));
        };
        let strip = key("g", "");
        let mut map = BTreeMap::new();
        for pair in flat.as_chunks::<2>().0 {
            let (Some(full), Some(count)) = (str_of(&pair[0]), int_of(&pair[1])) else {
                return Err(parse_err("GAUGE_SNAPSHOT"));
            };
            let name = full.strip_prefix(&strip).unwrap_or(&full).to_owned();
            map.insert(name, nonnegative(count));
        }
        Ok(map)
    }

    /// Whether the debit was recorded (`false`: the key is unseeded).
    pub async fn buckets_add(
        &self,
        name: &str,
        grain_ms: f64,
        window_ms: f64,
        at: f64,
        delta: Counts,
    ) -> Result<bool, Fault> {
        let out = self
            .eval(
                &scripts::BUCKETS_ADD,
                &[key("b", name)],
                &[
                    js_number(at),
                    js_number(grain_ms),
                    js_number(window_ms),
                    js_number(delta.requests),
                    js_number(delta.tokens),
                    js_number(delta.cost_usd),
                ],
            )
            .await?;
        Ok(int_of(&out) == Some(1))
    }

    pub async fn buckets_sum(
        &self,
        name: &str,
        grain_ms: f64,
        window_ms: f64,
        at: f64,
    ) -> Result<Option<Counts>, Fault> {
        let out = self
            .eval(
                &scripts::BUCKETS_SUM,
                &[key("b", name)],
                &[js_number(at), js_number(grain_ms), js_number(window_ms)],
            )
            .await?;
        match out {
            Value::Nil => Ok(None),
            Value::Array(items) if items.len() == 3 => {
                let n = |i: usize| num_of(&items[i]).ok_or_else(|| parse_err("BUCKETS_SUM"));
                Ok(Some(Counts {
                    requests: n(0)?,
                    tokens: n(1)?,
                    cost_usd: n(2)?,
                }))
            }
            _ => Err(parse_err("BUCKETS_SUM")),
        }
    }

    pub async fn buckets_seed(
        &self,
        name: &str,
        grain_ms: f64,
        window_ms: f64,
        at: f64,
        rows: &[BucketRow],
    ) -> Result<(), Fault> {
        let mut args = vec![
            js_number(window_ms * 2.0),
            "seeded".to_owned(),
            "1".to_owned(),
        ];
        let oldest = ((at - window_ms) / grain_ms).floor() * grain_ms;
        for (start, counts) in rows {
            let bucket = (start / grain_ms).floor() * grain_ms;
            if bucket < oldest {
                continue;
            }
            let b = js_number(bucket);
            args.extend([
                format!("{b}:r"),
                js_number(counts.requests),
                format!("{b}:t"),
                js_number(counts.tokens),
                format!("{b}:c"),
                js_number(counts.cost_usd),
            ]);
        }
        self.eval(&scripts::BUCKETS_SEED, &[key("b", name)], &args)
            .await
            .map(drop)
    }

    pub async fn lease_acquire(
        &self,
        name: &str,
        holder_id: &str,
        ttl_ms: u64,
    ) -> Result<bool, Fault> {
        let out = self
            .eval(
                &scripts::LEASE_ACQUIRE,
                &[key("lease", name)],
                &[holder_id.to_owned(), ttl_ms.to_string()],
            )
            .await?;
        Ok(int_of(&out) == Some(1))
    }

    pub async fn lease_release(&self, name: &str, holder_id: &str) -> Result<(), Fault> {
        self.eval(
            &scripts::LEASE_RELEASE,
            &[key("lease", name)],
            &[holder_id.to_owned()],
        )
        .await
        .map(drop)
    }

    /// One `SET NX PX` attempt under `token`: whether it was taken.
    pub async fn lock_try(&self, name: &str, token: &str, ttl_ms: u64) -> Result<bool, Fault> {
        let mut cmd = redis::cmd("SET");
        cmd.arg(key("lock", name))
            .arg(token)
            .arg("PX")
            .arg(ttl_ms)
            .arg("NX");
        let out = self.query(cmd).await?;
        Ok(matches!(out, Value::Okay) || matches!(&out, Value::SimpleString(s) if s == "OK"))
    }

    /// Releases `name` only if `token` still holds it. Whether it did.
    pub async fn lock_release(&self, name: &str, token: &str) -> Result<bool, Fault> {
        let out = self
            .eval(
                &scripts::MUTEX_RELEASE,
                &[key("lock", name)],
                &[token.to_owned()],
            )
            .await?;
        Ok(int_of(&out) == Some(1))
    }

    /// `PUBLISH omni:pubsub {"topic","payload"}`. Refused while the pub/sub
    /// connection is not listening, as TS refuses: a process is always its
    /// own audience, so the publish must then go through memory.
    pub async fn publish(&self, topic: &str, payload: &str) -> Result<(), Fault> {
        if !self.listening() {
            self.link.fault(&Fault::NotConnected);
            return Err(Fault::NotConnected);
        }
        let envelope = serde_json::json!({ "topic": topic, "payload": payload }).to_string();
        let mut cmd = redis::cmd("PUBLISH");
        cmd.arg(CHANNEL).arg(envelope);
        self.query(cmd).await.map(drop)
    }

    pub async fn publish_sequenced(
        &self,
        topic: &str,
        payload: &str,
        seq_key: &str,
    ) -> Result<u64, Fault> {
        if !self.listening() {
            self.link.fault(&Fault::NotConnected);
            return Err(Fault::NotConnected);
        }
        let out = self
            .eval(
                &scripts::PUBLISH_SEQUENCED,
                &[key("seq", seq_key)],
                &[CHANNEL.to_owned(), topic.to_owned(), payload.to_owned()],
            )
            .await?;
        int_of(&out)
            .map(nonnegative)
            .ok_or_else(|| parse_err("PUBLISH_SEQUENCED"))
    }

    pub async fn incr(&self, name: &str) -> Result<u64, Fault> {
        let mut cmd = redis::cmd("INCR");
        cmd.arg(key("seq", name));
        let out = self.query(cmd).await?;
        int_of(&out)
            .map(nonnegative)
            .ok_or_else(|| parse_err("INCR"))
    }

    pub async fn kv_set(&self, name: &str, value: &str, ttl_ms: u64) -> Result<(), Fault> {
        let mut cmd = redis::cmd("SET");
        cmd.arg(key("kv", name)).arg(value).arg("PX").arg(ttl_ms);
        self.query(cmd).await.map(drop)
    }

    pub async fn kv_get(&self, name: &str) -> Result<Option<String>, Fault> {
        let mut cmd = redis::cmd("GET");
        cmd.arg(key("kv", name));
        match self.query(cmd).await? {
            Value::Nil => Ok(None),
            other => str_of(&other).map(Some).ok_or_else(|| parse_err("GET")),
        }
    }

    pub async fn kv_del(&self, name: &str) -> Result<(), Fault> {
        let mut cmd = redis::cmd("UNLINK");
        cmd.arg(key("kv", name));
        self.query(cmd).await.map(drop)
    }

    /// `SCAN` + `UNLINK` of every `omni:kv:<prefix>*`. Each page and each
    /// `UNLINK` is one bounded call.
    pub async fn kv_del_prefix(&self, prefix: &str) -> Result<(), Fault> {
        let pattern = format!("{}*", glob_escape(&key("kv", prefix)));
        let found = link::scan(&self.link, &pattern).await?;
        for chunk in found.chunks(512) {
            let mut unlink = redis::cmd("UNLINK");
            unlink.arg(chunk);
            self.query(unlink).await?;
        }
        Ok(())
    }
}

// --- RedisCoord: the Coord, failing open ---------------------------------

/// TS `redisCoord`. Construct with [`RedisCoord::connect`] inside a Tokio
/// runtime; [`RedisCoord::close`] (or drop) stops its two connections.
pub struct RedisCoord {
    remote: Remote,
    fallback: MemoryCoord,
    subscribers: Arc<Subscribers>,
    now: Clock,
}

impl std::fmt::Debug for RedisCoord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RedisCoord")
            .field("remote", &self.remote)
            .finish_non_exhaustive()
    }
}

impl RedisCoord {
    /// Opens both connections in the background and waits — at most
    /// `connect_wait` — for each one's first attempt to settle, so the first
    /// call neither waits on a connect nor fails one that was about to land
    /// (TS `ready` / `listened`). Fails only on a malformed URL.
    pub async fn connect(url: &str, opts: RedisCoordOptions) -> Result<Self, redis::RedisError> {
        let client = redis::Client::open(url)?;
        let mut scripts: Vec<CoordScript> =
            scripts::builtin().iter().map(|s| (*s).clone()).collect();
        scripts.extend(opts.extra_scripts.iter().cloned());
        let now = Arc::clone(&opts.now);
        let wait = opts.connect_wait;
        let link = Arc::new(Link::new(client, opts, scripts));
        let subscribers = Arc::new(Subscribers::default());
        let listening = Arc::new(AtomicBool::new(false));

        let (sub_settled_tx, mut sub_settled) = watch::channel(false);
        let faults_at_start = link.faults();
        let mut connected = link.connected.subscribe();
        link.runtime.spawn(Arc::clone(&link).maintain());
        link.runtime.spawn(supervise_listener(
            Arc::clone(&link),
            Arc::clone(&subscribers),
            Arc::clone(&listening),
            sub_settled_tx,
        ));
        // The command connection's first attempt settles when it is
        // installed or a fault is counted; the pub/sub one reports its own.
        let first_attempt = async {
            let mut tick = tokio::time::interval(Duration::from_millis(5));
            while !*connected.borrow_and_update() && link.faults() == faults_at_start {
                tokio::select! {
                    _ = connected.changed() => {}
                    _ = tick.tick() => {}
                }
            }
        };
        // Past the wait, calls simply read the state (TS: `Promise.race`
        // with a sleep): a server still connecting is a fault answered at
        // once, never a wait.
        let settled = tokio::time::timeout(wait, async {
            first_attempt.await;
            // Only fails if the listener task ended, i.e. at close.
            sub_settled.wait_for(|s| *s).await.is_ok()
        })
        .await;
        if settled.is_err() {
            tracing::debug!(
                coord = "redis",
                "first connect still pending after the wait"
            );
        }

        Ok(Self {
            remote: Remote { link, listening },
            fallback: MemoryCoord::with_subscribers(Arc::clone(&now), Arc::clone(&subscribers)),
            subscribers,
            now,
        })
    }

    /// The server with explicit faults — for D3's admission script and any
    /// caller choosing its own degraded mode.
    pub fn remote(&self) -> &Remote {
        &self.remote
    }

    /// Whether the last call reached the server.
    pub fn healthy(&self) -> bool {
        self.remote.healthy()
    }

    /// Faults since boot, timeouts included.
    pub fn faults(&self) -> u64 {
        self.remote.faults()
    }

    /// Stops both connections. Admissions are refused at once; releases
    /// already queued keep being written for up to `drain_timeout` (the
    /// link task outlives this call by at most that), then anything left is
    /// counted in `releases_dropped` and logged. Idempotent; dropping the
    /// coordinator does the same.
    pub fn close(&self) {
        self.remote.link.close();
    }

    /// [`RedisCoord::close`], then waits until the drain has finished.
    pub async fn shutdown(&self) {
        self.close();
        self.remote.link.stopped().await;
    }

    fn now(&self) -> f64 {
        (self.now)()
    }
}

impl Drop for RedisCoord {
    fn drop(&mut self) {
        self.close();
    }
}

fn blank(holder: Option<&str>) -> Result<(), CoordError> {
    if holder == Some("") {
        Err(CoordError::BlankHolder)
    } else {
        Ok(())
    }
}

#[async_trait]
impl Coord for RedisCoord {
    async fn window_claim(&self, key: &str, window_ms: f64, now: f64) -> WindowClaim {
        match self.remote.window_claim(key, window_ms, now).await {
            Ok(claim) => claim,
            Err(_) => self.fallback.window_claim(key, window_ms, now).await,
        }
    }

    async fn window_rollback(&self, key: &str, stamp: f64) {
        if self.remote.window_rollback(key, stamp).await.is_err() {
            self.fallback.window_rollback(key, stamp).await;
        }
    }

    async fn gauge_acquire(
        &self,
        key: &str,
        ttl_ms: u64,
        holder: Option<&str>,
    ) -> Result<u64, CoordError> {
        blank(holder)?;
        match self
            .remote
            .gauge_acquire(key, self.now(), ttl_ms, holder)
            .await
        {
            Ok(before) => Ok(before),
            Err(_) => self.fallback.gauge_acquire(key, ttl_ms, holder).await,
        }
    }

    async fn gauge_renew(&self, key: &str, holder: &str, ttl_ms: u64) -> Result<(), CoordError> {
        blank(Some(holder))?;
        match self
            .remote
            .gauge_renew(key, self.now(), holder, ttl_ms)
            .await
        {
            Ok(()) => Ok(()),
            Err(_) => self.fallback.gauge_renew(key, holder, ttl_ms).await,
        }
    }

    async fn gauge_release(&self, key: &str, holder: Option<&str>) -> Result<(), CoordError> {
        blank(holder)?;
        match self.remote.gauge_release(key, self.now(), holder).await {
            Ok(()) => Ok(()),
            Err(_) => self.fallback.gauge_release(key, holder).await,
        }
    }

    async fn gauge_read(&self, key: &str) -> u64 {
        match self.remote.gauge_read(key, self.now()).await {
            Ok(n) => n,
            Err(_) => self.fallback.gauge_read(key).await,
        }
    }

    async fn gauge_snapshot(&self, prefix: &str) -> BTreeMap<String, u64> {
        match self.remote.gauge_snapshot(prefix, self.now()).await {
            Ok(map) => map,
            Err(_) => self.fallback.gauge_snapshot(prefix).await,
        }
    }

    /// Polls `SET NX PX` until taken or `wait` passes.
    ///
    /// Token-safe cleanup covers every way an attempt can end without
    /// handing the token to the caller: a fault (the `SET` may still land
    /// after its deadline, or on a retired connection a slow server reads
    /// late) and cancellation of this future mid-attempt. Each queues a
    /// compare-and-delete for this attempt's token, ordered after the `SET`
    /// on the connection, so it can never remove another holder's lock. If
    /// the release itself cannot be queued it is counted and the lock lapses
    /// at `ttl_ms`.
    async fn lock(&self, key: &str, ttl_ms: u64, wait: Duration) -> Result<LockToken, CoordError> {
        struct Attempt<'a> {
            remote: &'a Remote,
            name: &'a str,
            token: Option<String>,
        }
        impl Drop for Attempt<'_> {
            fn drop(&mut self) {
                if let Some(token) = self.token.take() {
                    // Counted and logged inside on refusal.
                    let _queued = self.remote.lock_release_detached(self.name, &token).is_ok();
                }
            }
        }
        let mut attempt = Attempt {
            remote: &self.remote,
            name: key,
            token: Some(uuid::Uuid::new_v4().to_string()),
        };
        let token = attempt.token.clone().unwrap_or_default();
        // Real elapsed time: the wait is time spent polling, whatever the
        // injected clock says.
        let deadline = tokio::time::Instant::now() + wait;
        let poll = self.remote.link.opts.lock_poll;
        loop {
            match self.remote.lock_try(key, &token, ttl_ms).await {
                Ok(true) => {
                    attempt.token = None;
                    return Ok(LockToken {
                        name: key.to_owned(),
                        token,
                    });
                }
                Ok(false) => {}
                // `attempt` drops here and queues the cleanup.
                Err(_) => return Err(CoordError::LockUnavailable(key.to_owned())),
            }
            if tokio::time::Instant::now() >= deadline {
                // Not taken: nothing to clean up.
                attempt.token = None;
                return Err(CoordError::LockUnavailable(key.to_owned()));
            }
            tokio::time::sleep(poll).await;
        }
    }

    /// Queues the token-safe release (so cancelling the caller cannot lose
    /// it) and waits — bounded by the command deadline — for the server to
    /// confirm it.
    async fn unlock(&self, token: LockToken) {
        if self
            .remote
            .lock_release_detached(&token.name, &token.token)
            .is_err()
        {
            return;
        }
        // The release is ahead of this PING on the connection: when the PING
        // answers, the release has run.
        if let Err(fault) = self.remote.query(redis::cmd("PING")).await {
            tracing::debug!(
                coord = "redis",
                reason = fault.reason(),
                "unlock unconfirmed"
            );
        }
    }

    fn unlock_detached(&self, token: LockToken) {
        // Counted and logged inside on refusal.
        let _queued = self
            .remote
            .lock_release_detached(&token.name, &token.token)
            .is_ok();
    }

    async fn buckets_add(&self, key: &str, grain_ms: f64, window_ms: f64, now: f64, delta: Counts) {
        if self
            .remote
            .buckets_add(key, grain_ms, window_ms, now, delta)
            .await
            .is_err()
        {
            // This debit is lost (memory ignores an unseeded key), so the
            // shared picture is short: reseed on recovery.
            self.remote.link.note_lost_debit();
            self.fallback
                .buckets_add(key, grain_ms, window_ms, now, delta)
                .await;
        }
    }

    async fn buckets_sum(
        &self,
        key: &str,
        grain_ms: f64,
        window_ms: f64,
        now: f64,
    ) -> Option<Counts> {
        match self.remote.buckets_sum(key, grain_ms, window_ms, now).await {
            Ok(out) => out,
            Err(_) => {
                self.fallback
                    .buckets_sum(key, grain_ms, window_ms, now)
                    .await
            }
        }
    }

    async fn buckets_seed(
        &self,
        key: &str,
        grain_ms: f64,
        window_ms: f64,
        now: f64,
        rows: &[BucketRow],
    ) {
        if self
            .remote
            .buckets_seed(key, grain_ms, window_ms, now, rows)
            .await
            .is_err()
        {
            self.fallback
                .buckets_seed(key, grain_ms, window_ms, now, rows)
                .await;
        }
    }

    async fn lease_acquire(&self, name: &str, holder_id: &str, ttl_ms: u64) -> bool {
        // A lease that cannot be confirmed is not held.
        self.remote
            .lease_acquire(name, holder_id, ttl_ms)
            .await
            .unwrap_or(false)
    }

    async fn lease_release(&self, name: &str, holder_id: &str) {
        let _released = self.remote.lease_release(name, holder_id).await;
    }

    async fn publish(&self, topic: &str, payload: &str) {
        if self.remote.publish(topic, payload).await.is_err() {
            self.fallback.publish(topic, payload).await;
        }
    }

    async fn publish_sequenced(&self, topic: &str, payload: &str, seq_key: &str) -> u64 {
        match self.remote.publish_sequenced(topic, payload, seq_key).await {
            Ok(seq) => seq,
            Err(_) => {
                self.fallback
                    .publish_sequenced(topic, payload, seq_key)
                    .await
            }
        }
    }

    fn subscribe(&self, pattern: &str, handler: Handler) -> Subscription {
        self.subscribers.add(pattern, handler)
    }

    async fn incr(&self, key: &str) -> u64 {
        match self.remote.incr(key).await {
            Ok(n) => n,
            Err(_) => self.fallback.incr(key).await,
        }
    }

    async fn kv_set(&self, key: &str, value: &str, ttl_ms: u64) -> Result<(), CoordError> {
        self.remote
            .kv_set(key, value, ttl_ms)
            .await
            .map_err(|_| CoordError::Unavailable)
    }

    async fn kv_get(&self, key: &str) -> Result<Option<String>, CoordError> {
        self.remote
            .kv_get(key)
            .await
            .map_err(|_| CoordError::Unavailable)
    }

    async fn kv_del(&self, key: &str) -> Result<(), CoordError> {
        self.remote
            .kv_del(key)
            .await
            .map_err(|_| CoordError::Unavailable)
    }

    async fn kv_del_prefix(&self, prefix: &str) -> Result<(), CoordError> {
        self.remote
            .kv_del_prefix(prefix)
            .await
            .map_err(|_| CoordError::Unavailable)
    }
}

// --- pub/sub ---------------------------------------------------------------

#[derive(serde::Deserialize)]
struct Envelope {
    topic: String,
    payload: String,
}

/// The pub/sub connection: subscribes to [`CHANNEL`], dispatches every frame
/// locally, and on a drop reconnects and resubscribes — on a fresh
/// connection, so a frame is never delivered twice. Each (re)subscribe
/// dispatches [`RECONNECTED_TOPIC`] locally (TS `onconnect`).
/// Runs [`listen`] and restarts it if it ever ends abnormally — a panic
/// escaping a handler in an unwinding build (release builds abort on panic,
/// per the workspace profile) — so the coordinator never stays deaf with
/// `listening` reading true.
async fn supervise_listener(
    link: Arc<Link>,
    subscribers: Arc<Subscribers>,
    listening: Arc<AtomicBool>,
    settled: watch::Sender<bool>,
) {
    let settled = Arc::new(settled);
    loop {
        let task = link.runtime.spawn(listen(
            Arc::clone(&link),
            Arc::clone(&subscribers),
            Arc::clone(&listening),
            Arc::clone(&settled),
        ));
        let ended = task.await;
        listening.store(false, Ordering::SeqCst);
        match ended {
            Ok(()) => return,
            Err(e) => {
                tracing::error!(
                    coord = "redis",
                    panicked = e.is_panic(),
                    "pubsub listener died; restarting"
                );
                link.fault(&Fault::Connection("pubsub listener died".to_owned()));
                if *link.shutdown.borrow() {
                    return;
                }
                tokio::time::sleep(link.opts.reconnect_min).await;
            }
        }
    }
}

async fn listen(
    link: Arc<Link>,
    subscribers: Arc<Subscribers>,
    listening: Arc<AtomicBool>,
    settled: Arc<watch::Sender<bool>>,
) {
    let mut shutdown = link.shutdown.subscribe();
    let mut delay = link.opts.reconnect_min;
    loop {
        if *shutdown.borrow() {
            return;
        }
        let attempt = async {
            let mut pubsub = link.client.get_async_pubsub().await?;
            pubsub.subscribe(CHANNEL).await?;
            Ok::<_, redis::RedisError>(pubsub)
        };
        let opened = tokio::select! {
            out = tokio::time::timeout(link.opts.connect_timeout, attempt) => out,
            _ = shutdown.changed() => return,
        };
        match opened {
            Ok(Ok(pubsub)) => {
                delay = link.opts.reconnect_min;
                listening.store(true, Ordering::SeqCst);
                settled.send_replace(true);
                subscribers.dispatch(RECONNECTED_TOPIC, "");
                let (mut sink, mut stream) = pubsub.split();
                let mut heartbeat = tokio::time::interval(link.opts.heartbeat);
                heartbeat.tick().await;
                loop {
                    let msg = tokio::select! {
                        msg = stream.next() => msg,
                        _ = heartbeat.tick() => {
                            // A connection nothing answers on (blackholed,
                            // paused) never ends its stream; a PING that
                            // outruns the deadline replaces it.
                            let ping = tokio::time::timeout(
                                link.opts.command_timeout,
                                sink.ping::<redis::Value>(),
                            )
                            .await;
                            if matches!(ping, Ok(Ok(_))) {
                                continue;
                            }
                            None
                        }
                        _ = shutdown.changed() => {
                            listening.store(false, Ordering::SeqCst);
                            return;
                        }
                    };
                    let Some(msg) = msg else { break };
                    let Ok(raw) = msg.get_payload::<String>() else {
                        continue;
                    };
                    match serde_json::from_str::<Envelope>(&raw) {
                        Ok(env) => subscribers.dispatch(&env.topic, &env.payload),
                        Err(_) => tracing::debug!(coord = "redis", "unreadable pubsub frame"),
                    }
                }
                listening.store(false, Ordering::SeqCst);
                link.fault(&Fault::Connection("pubsub closed".to_owned()));
            }
            Ok(Err(e)) => {
                settled.send_replace(true);
                link.fault(&Fault::Connection(format!("{:?}", e.kind())));
            }
            Err(_) => {
                settled.send_replace(true);
                link.fault(&Fault::TimedOut);
            }
        }
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            _ = shutdown.changed() => return,
        }
        delay = (delay * 2).min(link.opts.reconnect_max);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_follow_the_ts_schema() {
        assert_eq!(key("kv", "sess:admin:ab"), "omni:kv:sess:admin:ab");
        assert_eq!(gauge_index("load:a"), "omni:gidx:load:");
        assert_eq!(gauge_index("load:a:b"), "omni:gidx:load:");
        assert_eq!(gauge_index("plain"), "omni:gidx:plain");
        assert_eq!(gauge_index("load:"), "omni:gidx:load:");
    }

    #[test]
    fn glob_escape_makes_a_literal_prefix() {
        assert_eq!(glob_escape("omni:kv:sess:"), "omni:kv:sess:");
        assert_eq!(glob_escape("a*b?[c]\\"), "a\\*b\\?\\[c\\]\\\\");
    }

    #[test]
    fn envelope_is_what_ts_json_stringify_writes() {
        let env = serde_json::json!({ "topic": "routing", "payload": "{\"a\":1}\n\u{1}é" });
        assert_eq!(
            env.to_string(),
            r#"{"topic":"routing","payload":"{\"a\":1}\n\u0001é"}"#
        );
    }
}
