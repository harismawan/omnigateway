//! The scripts this crate adds beside D2's per-step ones (which stay loaded,
//! byte-identical to TS, for everything else that uses them).
//!
//! [`ADMIT`] is TS `ApiKeyRateLimiter.admit` / `consume`'s sequence of
//! per-step scripts done as one atomic call: for each subject, in order,
//! exactly `WINDOW_CLAIM`, then `GAUGE_ACQUIRE` (only for a subject with a
//! concurrency ceiling, the spec's rule) or `GAUGE_READ`'s prune (consume),
//! then `BUCKETS_SUM` for both long windows when the scope has any; then the
//! ceiling test `evaluate` makes (`used >= limit`); and on a refusal exactly
//! `WINDOW_ROLLBACK` and the named `GAUGE_RELEASE` for every subject. Each
//! step's Redis commands and arguments are the per-step script's own, so the
//! keys it leaves are the ones TS's sequence leaves.
//!
//! The reply carries every figure the decision is rendered from, so the
//! caller computes headroom, the violation and `Retry-After` with
//! `omni-ratelimit` (the reviewed port of `@omni/ratelimit`); the script's
//! verdict is the same predicate on the same numbers and is only what makes
//! the refusal's rollback atomic.

use std::sync::LazyLock;

use omni_coord::redis::CoordScript;

/// Keys per subject in [`ADMIT`]: window, gauge, gauge index, 5h buckets,
/// 1w buckets.
pub const ADMIT_KEYS_PER_SUBJECT: usize = 5;
/// Arguments per subject in [`ADMIT`].
pub const ADMIT_ARGS_PER_SUBJECT: usize = 11;
/// Leading arguments in [`ADMIT`].
pub const ADMIT_HEAD_ARGS: usize = 10;
/// Reply items per subject (after the leading verdict).
pub const ADMIT_REPLY_PER_SUBJECT: usize = 13;

/// The combined admission.
///
/// `KEYS` per subject *i* (5 each): `omni:w:<id>`, `omni:g:<id>`, the gauge
/// index, `omni:b:lim:<id>:5h`, `omni:b:lim:<id>:1w`.
///
/// `ARGV`: `now`, gauge `now`, gauge TTL, `1m` length, mode (`a` admit, `c`
/// consume), subject count, 5h grain, 5h length, 1w grain, 1w length; then
/// per subject (11 each): window member, gauge holder (`''`: raise none),
/// `requests/1m` ceiling, `concurrency` ceiling, long windows wanted
/// (`1`/`0`), then `requests`, `tokens`, `spend` ceilings at 5h and at 1w.
/// An absent ceiling is `''`.
///
/// Reply: `{ verdict (1 admit, 0 refuse), then per subject: used1m,
/// oldest1m|'', concurrency before, then per long window (5h, 1w): seeded,
/// r, t, c, oldest-row }`; a long window not asked for, or unseeded, reads
/// `'','','',''` after its seeded flag (`0` unseeded, `2` not asked for).
///
/// The long sums are compared, and returned, through `tostring` exactly as
/// TS reads `BUCKETS_SUM`'s reply (`Number(tostring(x))`, Lua's `%.14g`).
///
/// **Oldest row** (a refusal's exact reset, TS `oldestSince`, from Redis
/// instead of the store). Beside the counts, a hash may carry
/// `<s>:a` / `<s>:z`: the least and greatest `at` of the done rows whose
/// `at` falls in `[s, s + grain)` — keyed by the row's own instant, not by
/// when it was debited (written by the seed and by batched debits; ignored
/// by TS's `BUCKETS_SUM`/`BUCKETS_ADD`; pruned with the counts, which is
/// safe: a range older than the oldest live bucket holds only rows before
/// the cutoff). With TS's cutoff `now - length`, a range contributes `a`
/// when `a >= cutoff` (then it is that bucket's oldest in-window row,
/// exact), else `z` when `z >= cutoff` (the cutoff falls inside this
/// bucket: some in-window row exists at or before `z`, and every one is
/// `>= cutoff > s`, so `z` is later than TS by less than one grain), else
/// nothing. The reply is the least contribution's stored text, or `''`
/// (no range known: the caller keeps the overstated `now + window`, as TS
/// does when `oldestSince` finds nothing). Every contribution is the `at` of
/// a real in-window row, so the reset is never earlier than TS's.
pub const ADMIT_SRC: &str = r#"
  local now = tonumber(ARGV[1])
  local gnow = ARGV[2]
  local ttl = tonumber(ARGV[3])
  local admit = ARGV[5] == 'a'
  local n = tonumber(ARGV[6])
  local grain = { tonumber(ARGV[7]), tonumber(ARGV[9]) }
  local length = { tonumber(ARGV[8]), tonumber(ARGV[10]) }
  local function ceiling(s) if s == '' then return nil end return tonumber(s) end
  local function sum(key, g, len)
    if redis.call('HEXISTS', key, 'seeded') == 0 then return nil end
    local oldest = math.floor((now - len) / g) * g
    local cutoff = now - len
    local all = redis.call('HGETALL', key)
    local r, t, c = 0, 0, 0
    local lo, hi = {}, {}
    for i = 1, #all, 2 do
      local field = all[i]
      local sep = string.find(field, ':')
      if sep then
        local start = tonumber(string.sub(field, 1, sep - 1))
        local kind = string.sub(field, sep + 1)
        if start < oldest then
          redis.call('HDEL', key, field)
        elseif kind == 'r' then r = r + tonumber(all[i + 1])
        elseif kind == 't' then t = t + tonumber(all[i + 1])
        elseif kind == 'c' then c = c + tonumber(all[i + 1])
        elseif kind == 'a' then lo[start] = all[i + 1]
        elseif kind == 'z' then hi[start] = all[i + 1]
        end
      end
    end
    -- `lo`/`hi` share their starts (written together).
    local best, bestn = '', nil
    local function offer(text)
      local n = tonumber(text)
      if n and n >= cutoff and (bestn == nil or n < bestn) then best, bestn = text, n end
    end
    for start, a in pairs(lo) do
      local an = tonumber(a)
      if an and an >= cutoff then offer(a) elseif hi[start] then offer(hi[start]) end
    end
    for start, z in pairs(hi) do
      if lo[start] == nil then offer(z) end
    end
    return tostring(r), tostring(t), tostring(c), best
  end
  local out = { 1 }
  local refuse = false
  for i = 1, n do
    local k = (i - 1) * 5
    local a = 10 + (i - 1) * 11
    local w, g = KEYS[k + 1], KEYS[k + 2]
    local holder = ARGV[a + 2]
    redis.call('ZREMRANGEBYSCORE', w, '-inf', tonumber(ARGV[1]) - tonumber(ARGV[4]))
    local used = redis.call('ZCARD', w)
    local oldest = redis.call('ZRANGE', w, 0, 0, 'WITHSCORES')
    redis.call('ZADD', w, ARGV[1], ARGV[a + 1])
    redis.call('PEXPIRE', w, ARGV[4])
    local before = 0
    if holder ~= '' then
      redis.call('ZREMRANGEBYSCORE', g, '-inf', gnow)
      local mine = redis.call('ZSCORE', g, holder)
      before = redis.call('ZCARD', g)
      if mine then before = before - 1 end
      redis.call('ZADD', g, tonumber(gnow) + ttl, holder)
      if redis.call('PTTL', g) < ttl then
        redis.call('PEXPIRE', g, ARGV[3])
      end
      redis.call('SADD', KEYS[k + 3], g)
    elseif not admit then
      redis.call('ZREMRANGEBYSCORE', g, '-inf', gnow)
      before = redis.call('ZCARD', g)
    end
    local l1m = ceiling(ARGV[a + 3])
    if l1m and used >= l1m then refuse = true end
    local lc = ceiling(ARGV[a + 4])
    if lc and before >= lc then refuse = true end
    out[#out + 1] = used
    out[#out + 1] = oldest[2] or ''
    out[#out + 1] = before
    for j = 1, 2 do
      if ARGV[a + 5] ~= '1' then
        out[#out + 1] = 2
        out[#out + 1] = ''
        out[#out + 1] = ''
        out[#out + 1] = ''
        out[#out + 1] = ''
      else
        local r, t, c, first = sum(KEYS[k + 3 + j], grain[j], length[j])
        if r == nil then
          out[#out + 1] = 0
          out[#out + 1] = ''
          out[#out + 1] = ''
          out[#out + 1] = ''
          out[#out + 1] = ''
        else
          local b = a + 5 + (j - 1) * 3
          local lr, lt, ls = ceiling(ARGV[b + 1]), ceiling(ARGV[b + 2]), ceiling(ARGV[b + 3])
          if lr and tonumber(r) >= lr then refuse = true end
          if lt and tonumber(t) >= lt then refuse = true end
          if ls and tonumber(c) >= ls then refuse = true end
          out[#out + 1] = 1
          out[#out + 1] = r
          out[#out + 1] = t
          out[#out + 1] = c
          out[#out + 1] = first
        end
      end
    end
  end
  if refuse then
    out[1] = 0
    for i = 1, n do
      local k = (i - 1) * 5
      local a = 10 + (i - 1) * 11
      local one = redis.call('ZRANGEBYSCORE', KEYS[k + 1], ARGV[1], ARGV[1], 'LIMIT', 0, 1)
      if one[1] then redis.call('ZREM', KEYS[k + 1], one[1]) end
      if ARGV[a + 2] ~= '' then
        redis.call('ZREMRANGEBYSCORE', KEYS[k + 2], '-inf', gnow)
        redis.call('ZREM', KEYS[k + 2], ARGV[a + 2])
      end
    end
  end
  return out
"#;

/// A batch of long-window debits, aggregated per (bucket hash, bucket
/// start), applied in one call.
///
/// `KEYS`: bucket hashes (one per entry; a hash may repeat for another
/// start). `ARGV` per entry: an instant inside the bucket, grain, window
/// length, requests, tokens, `m`, then `m` row ranges `(least at, greatest
/// at)` each within one grain-aligned range bucket, then `n`, then the `n`
/// individual costs. The count bucket's start is computed (and spelled,
/// `start .. ':r'`) exactly as `BUCKETS_ADD` does. Each entry is what that
/// many `BUCKETS_ADD` calls leave: an unseeded hash ignores it; a seeded one
/// gets `HINCRBY` of the summed requests and tokens (integers, exact) and
/// one `HINCRBYFLOAT` per cost in order (so the stored float is the one the
/// per-debit sequence writes), and `PEXPIRE` 2×window. Beyond TS it widens
/// each row range's `<s>:a` / `<s>:z` (see [`ADMIT_SRC`]). Reply: per entry,
/// 1 applied or 0 unseeded.
pub const DEBIT_BATCH_SRC: &str = r#"
  local out = {}
  local a = 0
  for i = 1, #KEYS do
    local g = tonumber(ARGV[a + 2])
    local m = tonumber(ARGV[a + 6])
    local n = tonumber(ARGV[a + 7 + 2 * m])
    if redis.call('HEXISTS', KEYS[i], 'seeded') == 0 then
      out[i] = 0
    else
      local start = math.floor(tonumber(ARGV[a + 1]) / g) * g
      redis.call('HINCRBY', KEYS[i], start .. ':r', ARGV[a + 4])
      redis.call('HINCRBY', KEYS[i], start .. ':t', ARGV[a + 5])
      for j = 1, n do
        redis.call('HINCRBYFLOAT', KEYS[i], start .. ':c', ARGV[a + 7 + 2 * m + j])
      end
      for j = 1, m do
        local lo, hi = ARGV[a + 5 + 2 * j], ARGV[a + 6 + 2 * j]
        local s = math.floor(tonumber(lo) / g) * g
        local was = redis.call('HGET', KEYS[i], s .. ':a')
        if (not was) or tonumber(lo) < tonumber(was) then
          redis.call('HSET', KEYS[i], s .. ':a', lo)
        end
        was = redis.call('HGET', KEYS[i], s .. ':z')
        if (not was) or tonumber(hi) > tonumber(was) then
          redis.call('HSET', KEYS[i], s .. ':z', hi)
        end
      end
      redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[a + 3]) * 2)
      out[i] = 1
    end
    a = a + 7 + 2 * m + n
  end
  return out
"#;

/// Row ranges installed by a seed (background only), merged min/max per
/// range bucket into a seeded hash; nothing else is touched.
///
/// `KEYS[1]`: the bucket hash. `ARGV`: grain, then `(least at, greatest
/// at)` pairs. Reply: 1 merged, 0 unseeded (left alone).
pub const RANGES_MERGE_SRC: &str = r#"
  if redis.call('HEXISTS', KEYS[1], 'seeded') == 0 then return 0 end
  local g = tonumber(ARGV[1])
  for j = 2, #ARGV, 2 do
    local lo, hi = ARGV[j], ARGV[j + 1]
    local s = math.floor(tonumber(lo) / g) * g
    local was = redis.call('HGET', KEYS[1], s .. ':a')
    if (not was) or tonumber(lo) < tonumber(was) then
      redis.call('HSET', KEYS[1], s .. ':a', lo)
    end
    was = redis.call('HGET', KEYS[1], s .. ':z')
    if (not was) or tonumber(hi) > tonumber(was) then
      redis.call('HSET', KEYS[1], s .. ':z', hi)
    end
  end
  return 1
"#;

/// One replica's load picture, replaced whole in one step.
///
/// `KEYS`: the replica's hash, the replica index. `ARGV`: TTL ms, expiry
/// (index score), replica id, then `field, count` pairs. An empty picture
/// deletes the hash and leaves the index entry to expire.
pub const LOAD_PUBLISH_SRC: &str = r#"
  redis.call('DEL', KEYS[1])
  if #ARGV > 3 then
    redis.call('HSET', KEYS[1], unpack(ARGV, 4))
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
  end
  redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
  redis.call('PEXPIRE', KEYS[2], ARGV[1])
  return 0
"#;

/// Every other live replica's load, summed per field.
///
/// `KEYS`: the replica index. `ARGV`: now, this replica's id, the hash
/// prefix. Prunes expired replicas from the index first. Reply: flat
/// `field, count` pairs.
pub const LOAD_SNAPSHOT_SRC: &str = r#"
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  local totals = {}
  local order = {}
  for _, replica in ipairs(redis.call('ZRANGE', KEYS[1], 0, -1)) do
    if replica ~= ARGV[2] then
      local all = redis.call('HGETALL', ARGV[3] .. replica)
      for i = 1, #all, 2 do
        local field = all[i]
        if totals[field] == nil then
          totals[field] = 0
          order[#order + 1] = field
        end
        totals[field] = totals[field] + tonumber(all[i + 1])
      end
    end
  end
  local out = {}
  for _, field in ipairs(order) do
    out[#out + 1] = field
    out[#out + 1] = totals[field]
  end
  return out
"#;

pub static ADMIT: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("RATE_LIMIT_ADMIT", ADMIT_SRC));
pub static DEBIT_BATCH: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("RATE_LIMIT_DEBIT_BATCH", DEBIT_BATCH_SRC));
pub static RANGES_MERGE: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("RATE_LIMIT_RANGES_MERGE", RANGES_MERGE_SRC));
pub static LOAD_PUBLISH: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("LOAD_PUBLISH", LOAD_PUBLISH_SRC));
pub static LOAD_SNAPSHOT: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("LOAD_SNAPSHOT", LOAD_SNAPSHOT_SRC));

/// Every script this crate calls, for `RedisCoordOptions::extra_scripts`
/// (loaded at each connect, so a call never waits on a load; without them a
/// call still works, sent whole once on `NOSCRIPT`).
pub fn all() -> Vec<CoordScript> {
    vec![
        ADMIT.clone(),
        DEBIT_BATCH.clone(),
        RANGES_MERGE.clone(),
        LOAD_PUBLISH.clone(),
        LOAD_SNAPSHOT.clone(),
    ]
}
