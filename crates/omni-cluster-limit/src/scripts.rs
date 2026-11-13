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
//!
//! ## Long-window state: the TS hash and its Rust companion
//!
//! The bucket hash `omni:b:lim:<subject>:<window>` holds exactly what TS's
//! scripts write — `seeded` and `<start>:r|t|c`, written in TS's order, so a
//! TS reader (`BUCKETS_SUM`, `BUCKETS_ADD`) sees the same hash. Everything
//! Rust needs beyond it lives in a companion hash `<that key>:meta`:
//!
//! - `snap` and `since` — the commit snapshot and the row-selection
//!   boundary of the store read the seed installed (see
//!   [`DEBIT_BATCH_SRC`]): together, which committed rows the seed counted.
//! - `<s>:a` / `<s>:z` — row ranges: the least and greatest `at` of the done
//!   rows whose own `at` falls in `[s, s + grain)` (a refusal's reset, TS
//!   `oldestSince`, read from Redis; see [`ADMIT_SRC`]).
//!
//! Both are written in one step with the counts ([`SEED_INSTALL_SRC`]), and
//! each other write touches both ([`DEBIT_BATCH_SRC`]). A picture is
//! **complete** only when both hashes exist and the companion has `snap`:
//! the counts hash alone (TS's `BUCKETS_SEED`, a lost companion) reads as
//! unseeded and is reseeded whole. The companion carries the counts hash's
//! TTL, so they expire together.

use std::sync::LazyLock;

use omni_coord::redis::CoordScript;

/// Keys per subject in [`ADMIT`]: window, gauge, gauge index, then for 5h
/// and 1w the bucket hash and its companion.
pub const ADMIT_KEYS_PER_SUBJECT: usize = 7;
/// Arguments per subject in [`ADMIT`].
pub const ADMIT_ARGS_PER_SUBJECT: usize = 11;
/// Leading arguments in [`ADMIT`].
pub const ADMIT_HEAD_ARGS: usize = 10;
/// Reply items per subject (after the leading verdict).
pub const ADMIT_REPLY_PER_SUBJECT: usize = 13;

/// The companion hash of a bucket hash (full key in, full key out).
pub fn meta_key(bucket_hash: &str) -> String {
    format!("{bucket_hash}:meta")
}

/// The combined admission.
///
/// `KEYS` per subject *i* (7 each): `omni:w:<id>`, `omni:g:<id>`, the gauge
/// index, `omni:b:lim:<id>:5h` and its companion, `omni:b:lim:<id>:1w` and
/// its companion.
///
/// `ARGV`: `now`, gauge `now`, gauge TTL, `1m` length, mode (`a` admit, `c`
/// consume), subject count, 5h grain, 5h length, 1w grain, 1w length; then
/// per subject (11 each): window member, gauge holder (`''`: raise none),
/// `requests/1m` ceiling, `concurrency` ceiling, long windows wanted
/// (`1`/`0`), then `requests`, `tokens`, `spend` ceilings at 5h and at 1w.
/// An absent ceiling is `''`.
///
/// **Complete picture.** A long window is judged only when it is complete
/// (both hashes, `snap` in the companion — see the module docs). Anything
/// else reads as unseeded: not judged, and a seed is asked for, which
/// replaces the picture whole. Pruning of aged buckets is TS's, in the
/// counts hash, and the same in the companion.
///
/// Reply: `{ verdict (1 admit, 0 refuse), then per subject: used1m,
/// oldest1m|'', concurrency before, then per long window (5h, 1w): seeded,
/// r, t, c, oldest-row }`; a long window not asked for, or unseeded, reads
/// `'','','',''` after its seeded flag (`0` unseeded, `2` not asked for).
///
/// The long sums are compared, and returned, through `tostring` exactly as
/// TS reads `BUCKETS_SUM`'s reply (`Number(tostring(x))`, Lua's `%.14g`).
///
/// **Oldest row.** With TS's cutoff `now - length`, a range contributes `a`
/// when `a >= cutoff` (that bucket's oldest in-window row, exact), else `z`
/// when `z >= cutoff` (the cutoff falls inside this bucket: its oldest
/// in-window row is `>= cutoff > s` and `<= z`, so `z` is later than TS by
/// less than one grain), else nothing. The reply is the least contribution,
/// or `''` (no in-window row: the caller keeps the overstated
/// `now + window`, as TS does when `oldestSince` finds nothing). Every
/// contribution is the `at` of a real in-window row, so the reset is never
/// earlier than TS's. Ranges cover every counted row: the seed installs the
/// ranges of the rows it counts, in the same step, and every applied debit
/// widens them in the same step as its count.
pub const ADMIT_SRC: &str = r#"
  local now = tonumber(ARGV[1])
  local gnow = ARGV[2]
  local ttl = tonumber(ARGV[3])
  local admit = ARGV[5] == 'a'
  local n = tonumber(ARGV[6])
  local grain = { tonumber(ARGV[7]), tonumber(ARGV[9]) }
  local length = { tonumber(ARGV[8]), tonumber(ARGV[10]) }
  local function ceiling(s) if s == '' then return nil end return tonumber(s) end
  local function sum(key, meta, g, len)
    if redis.call('HEXISTS', meta, 'snap') == 0 or redis.call('HEXISTS', key, 'seeded') == 0 then
      return nil
    end
    local oldest = math.floor((now - len) / g) * g
    local cutoff = now - len
    local all = redis.call('HGETALL', key)
    local r, t, c = 0, 0, 0
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
        end
      end
    end
    local lo, hi = {}, {}
    all = redis.call('HGETALL', meta)
    for i = 1, #all, 2 do
      local field = all[i]
      local sep = string.find(field, ':')
      if sep then
        local start = tonumber(string.sub(field, 1, sep - 1))
        local kind = string.sub(field, sep + 1)
        if start < oldest then
          redis.call('HDEL', meta, field)
        elseif kind == 'a' then lo[start] = all[i + 1]
        elseif kind == 'z' then hi[start] = all[i + 1]
        end
      end
    end
    local best, bestn = '', nil
    local function offer(text)
      local v = tonumber(text)
      if v and v >= cutoff and (bestn == nil or v < bestn) then best, bestn = text, v end
    end
    for start, a in pairs(lo) do
      local av = tonumber(a)
      if av and av >= cutoff then offer(a) elseif hi[start] then offer(hi[start]) end
    end
    for start, z in pairs(hi) do
      if lo[start] == nil then offer(z) end
    end
    return tostring(r), tostring(t), tostring(c), best
  end
  local out = { 1 }
  local refuse = false
  for i = 1, n do
    local k = (i - 1) * 7
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
        local r, t, c, first = sum(KEYS[k + 2 + 2 * j], KEYS[k + 3 + 2 * j], grain[j], length[j])
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
      local k = (i - 1) * 7
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

/// A batch of long-window debits, one call per batch.
///
/// `KEYS` per entry (3): the bucket hash, its companion, its seed lock
/// (`omni:lock:seed:<bucket>`). `ARGV` per entry: an instant inside the
/// count bucket, grain, window length, `k`, then `k` runs, each: the
/// commit id (`''`: unknown), `n`, then `n` rows `(row at, tokens, cost)`
/// in debit order.
///
/// Per entry, by the picture's state:
/// - **incomplete** (see the module docs): `2` *wait* when its seed lock is
///   held (a seed is between its store read and its install: the rows may
///   or may not be in it — the caller keeps the entry and retries after the
///   install), else `0` *ignored*, TS's "an unseeded key ignores adds": the
///   next seed reads the committed rows.
/// - **complete**: per row (ruling R1), *covered* exactly when the seed
///   counted it — its commit is visible to the seed's snapshot (`snap`)
///   **and** its `at` is inside the seed's row selection (`at >= since`, the
///   boundary the store read used) — else *applied*: what TS's
///   `BUCKETS_ADD` leaves for those rows — `HINCRBY` of the applied count
///   and summed tokens (integers, exact), one `HINCRBYFLOAT` per applied cost
///   in debit order (TS's float sequence exactly), `PEXPIRE` 2×window — and
///   the applied rows' ranges widened in the companion (same TTL). A run
///   whose transaction spans the boundary is split row by row. Reply
///   `{applied rows, covered rows}`.
///
/// `snap` is `xmin:xmax:xip,…`, Postgres `pg_snapshot` text, with
/// `pg_visible_in_snapshot` semantics: a commit `c < xmin` was seen,
/// `c >= xmax` was not, otherwise seen unless listed. Ids are compared as
/// decimal strings, exactly at any width. A run with no commit id is never
/// covered.
pub const DEBIT_BATCH_SRC: &str = r#"
  local function lt(x, y)
    if #x ~= #y then return #x < #y end
    return x < y
  end
  local function seen(snap, c)
    if c == '' then return false end
    if lt(c, snap.xmin) then return true end
    if not lt(c, snap.xmax) then return false end
    return not snap.xip[c]
  end
  local out = {}
  local a = 0
  for i = 1, #KEYS / 3 do
    local key, meta, lock = KEYS[3 * i - 2], KEYS[3 * i - 1], KEYS[3 * i]
    local g = tonumber(ARGV[a + 2])
    local window = tonumber(ARGV[a + 3])
    local runs = tonumber(ARGV[a + 4])
    local start = math.floor(tonumber(ARGV[a + 1]) / g) * g
    a = a + 4
    local complete = redis.call('HEXISTS', meta, 'snap') == 1 and redis.call('HEXISTS', key, 'seeded') == 1
    local snap, since = nil, nil
    if complete then
      local xmin, xmax, xip = string.match(redis.call('HGET', meta, 'snap'), '^(%d+):(%d+):(.*)$')
      snap = { xmin = xmin, xmax = xmax, xip = {} }
      for x in string.gmatch(xip, '%d+') do snap.xip[x] = true end
      since = tonumber(redis.call('HGET', meta, 'since')) or -math.huge
    end
    local applied, covered = 0, 0
    local count, tokens = 0, 0
    local costs = {}
    local lo, hi, order = {}, {}, {}
    for _ = 1, runs do
      local c = ARGV[a + 1]
      local n = tonumber(ARGV[a + 2])
      local visible = complete and seen(snap, c)
      for j = 1, n do
        local b = a + 2 + 3 * (j - 1)
        local at = tonumber(ARGV[b + 1])
        if complete then
          if visible and at >= since then
            covered = covered + 1
          else
            applied = applied + 1
            count = count + 1
            tokens = tokens + tonumber(ARGV[b + 2])
            costs[#costs + 1] = ARGV[b + 3]
            local s = math.floor(at / g) * g
            if lo[s] == nil then
              order[#order + 1] = s
              lo[s], hi[s] = ARGV[b + 1], ARGV[b + 1]
            else
              if at < tonumber(lo[s]) then lo[s] = ARGV[b + 1] end
              if at > tonumber(hi[s]) then hi[s] = ARGV[b + 1] end
            end
          end
        end
      end
      a = a + 2 + 3 * n
    end
    if complete then
      if count > 0 then
        -- TS's field order (`:r`, `:t`, `:c`) and float sequence.
        redis.call('HINCRBY', key, start .. ':r', count)
        redis.call('HINCRBY', key, start .. ':t', string.format('%.0f', tokens))
        for _, cost in ipairs(costs) do
          redis.call('HINCRBYFLOAT', key, start .. ':c', cost)
        end
        for _, s in ipairs(order) do
          local was = redis.call('HGET', meta, s .. ':a')
          if (not was) or tonumber(lo[s]) < tonumber(was) then
            redis.call('HSET', meta, s .. ':a', lo[s])
          end
          was = redis.call('HGET', meta, s .. ':z')
          if (not was) or tonumber(hi[s]) > tonumber(was) then
            redis.call('HSET', meta, s .. ':z', hi[s])
          end
        end
        redis.call('PEXPIRE', key, window * 2)
        redis.call('PEXPIRE', meta, window * 2)
      end
      out[i] = { applied, covered }
    elseif redis.call('EXISTS', lock) == 1 then
      out[i] = 2
    else
      out[i] = 0
    end
  end
  return out
"#;

/// A seed's picture, installed whole in one step (I1/I2 ruling): exactly
/// what TS's `BUCKETS_SEED` writes to the counts hash (`DEL`; `seeded` and
/// the count fields, in its order; `PEXPIRE`), plus the companion with the
/// read's row-selection boundary (`since`), commit snapshot (`snap`, last)
/// and the row ranges, under the same TTL. No reader ever sees counts
/// without their ranges, boundary and snapshot. TS's `BUCKETS_SEED` itself
/// is untouched (D2, byte-identical).
///
/// `KEYS`: the bucket hash, its companion, its seed lock. `ARGV`: the lock
/// token (required: a seed installs only under its own lock — ruling R1),
/// `PEXPIRE` ms (2×window), the snapshot, grain, the selection boundary,
/// `n`, then `n` count `field, value` pairs (TS's spelling: `seeded 1`,
/// then `<start>:r|t|c`), then `(least at, greatest at)` range pairs.
///
/// Reply: `1` installed; `0` a complete picture is already there (another
/// replica's, just as exact; left alone); `-1` the lock is not this seed's
/// (it lapsed): nothing written, the seed fails and is asked again.
/// Arguments are validated before the first write, so a bad call cannot
/// leave a half-written picture.
pub const SEED_INSTALL_SRC: &str = r#"
  if ARGV[1] == '' or redis.call('GET', KEYS[3]) ~= ARGV[1] then return -1 end
  if redis.call('HEXISTS', KEYS[2], 'snap') == 1 and redis.call('HEXISTS', KEYS[1], 'seeded') == 1 then
    return 0
  end
  local ttl = tonumber(ARGV[2])
  local g = tonumber(ARGV[4])
  local since = tonumber(ARGV[5])
  local n = tonumber(ARGV[6])
  if not (ttl and g and since and n) or not string.match(ARGV[3], '^%d+:%d+:[%d,]*$') then
    return redis.error_reply('ERR bad seed install')
  end
  local first = 7 + 2 * n
  if first - 1 > #ARGV or (#ARGV - first + 1) % 2 ~= 0 then
    return redis.error_reply('ERR bad seed install')
  end
  for j = first, #ARGV do
    if not tonumber(ARGV[j]) then return redis.error_reply('ERR bad seed install') end
  end
  redis.call('DEL', KEYS[1], KEYS[2])
  local i, last = 7, first - 1
  while i <= last do
    local j = math.min(i + 999, last)
    redis.call('HSET', KEYS[1], unpack(ARGV, i, j))
    i = j + 1
  end
  redis.call('PEXPIRE', KEYS[1], ttl)
  for j = first, #ARGV, 2 do
    local s = math.floor(tonumber(ARGV[j]) / g) * g
    redis.call('HSET', KEYS[2], s .. ':a', ARGV[j], s .. ':z', ARGV[j + 1])
  end
  redis.call('HSET', KEYS[2], 'since', ARGV[5])
  redis.call('HSET', KEYS[2], 'snap', ARGV[3])
  redis.call('PEXPIRE', KEYS[2], ttl)
  return 1
"#;

/// One replica's load picture, replaced whole in one step.
///
/// `KEYS`: the replica's hash, the replica index, a staging hash. `ARGV`:
/// TTL ms, expiry (index score), replica id, then `field, count` pairs. The
/// new picture is built in the staging hash in chunks (one Lua call cannot
/// unpack 8,192 values) and `RENAME`d over the old one, so a failure part
/// way leaves the previous picture as it was. An empty picture deletes it.
pub const LOAD_PUBLISH_SRC: &str = r#"
  if (#ARGV - 3) % 2 ~= 0 then return redis.error_reply('ERR bad load picture') end
  redis.call('DEL', KEYS[3])
  local i = 4
  -- Building may fail part way (memory limit, a wrong-typed field value);
  -- the live picture is untouched until the swap.
  while i <= #ARGV do
    local j = math.min(i + 999, #ARGV)
    redis.call('HSET', KEYS[3], unpack(ARGV, i, j))
    i = j + 1
  end
  if #ARGV > 3 then
    redis.call('PEXPIRE', KEYS[3], ARGV[1])
    redis.call('RENAME', KEYS[3], KEYS[1])
  else
    redis.call('DEL', KEYS[1])
  end
  redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
  redis.call('PEXPIRE', KEYS[2], ARGV[1])
  return 0
"#;

/// Every other live replica's load, summed per field, bounded server-side.
///
/// `KEYS`: the replica index. `ARGV`: now, this replica's id, the hash
/// prefix, the most keys to return, the most replicas to read, the most
/// fields one picture may hold (the fleet's publisher bound). Prunes
/// expired replicas; sums every field of at most `max replicas` pictures
/// (each read up to the publisher bound — a publisher within the fleet's
/// bound is read whole, so the totals are exact); returns the `max keys`
/// busiest totals (ties by name). Reply: flat `field, count` pairs.
pub const LOAD_SNAPSHOT_SRC: &str = r#"
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  local maxk = tonumber(ARGV[4])
  local maxr = tonumber(ARGV[5])
  local maxp = tonumber(ARGV[6])
  local totals = {}
  local order = {}
  local read = 0
  for _, replica in ipairs(redis.call('ZRANGE', KEYS[1], 0, maxr)) do
    if replica ~= ARGV[2] and read < maxr then
      read = read + 1
      local all = redis.call('HGETALL', ARGV[3] .. replica)
      for i = 1, math.min(#all, 2 * maxp), 2 do
        local field = all[i]
        if totals[field] == nil then
          totals[field] = 0
          order[#order + 1] = field
        end
        totals[field] = totals[field] + tonumber(all[i + 1])
      end
    end
  end
  table.sort(order, function(x, y)
    if totals[x] ~= totals[y] then return totals[x] > totals[y] end
    return x < y
  end)
  local out = {}
  for i = 1, math.min(#order, maxk) do
    out[#out + 1] = order[i]
    out[#out + 1] = totals[order[i]]
  end
  return out
"#;

pub static ADMIT: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("RATE_LIMIT_ADMIT", ADMIT_SRC));
pub static DEBIT_BATCH: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("RATE_LIMIT_DEBIT_BATCH", DEBIT_BATCH_SRC));
pub static SEED_INSTALL: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("RATE_LIMIT_SEED_INSTALL", SEED_INSTALL_SRC));
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
        SEED_INSTALL.clone(),
        LOAD_PUBLISH.clone(),
        LOAD_SNAPSHOT.clone(),
    ]
}
