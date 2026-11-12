//! The Lua scripts, byte-for-byte the text of the frozen TS
//! `apps/gateway/src/coord/redis.ts`, so both runtimes load the same digests
//! and a TS→Rust cutover runs the same server-side logic. A unit test re-reads
//! the TS file and fails on any drift.
//!
//! Each script is the atomic half of one primitive: what the in-memory
//! implementation does between one call and the next return, done server-side
//! so N processes see one another's claims the instant they land.

use std::sync::LazyLock;

/// A Lua script and its SHA1 digest, called by `EVALSHA` and sent whole
/// (`EVAL`) only when the server answers `NOSCRIPT`. D3's combined admission
/// script is one more of these, passed in `RedisCoordOptions::extra_scripts`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoordScript {
    pub name: &'static str,
    pub source: &'static str,
    pub sha: String,
}

impl CoordScript {
    pub fn new(name: &'static str, source: &'static str) -> Self {
        Self {
            name,
            source,
            sha: redis::Script::new(source).get_hash().to_owned(),
        }
    }
}
pub(crate) const WINDOW_CLAIM_SRC: &str = r#"
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', tonumber(ARGV[1]) - tonumber(ARGV[2]))
  local used = redis.call('ZCARD', KEYS[1])
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  redis.call('ZADD', KEYS[1], ARGV[1], ARGV[3])
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return { used, oldest[2] }
"#;
pub(crate) const WINDOW_ROLLBACK_SRC: &str = r#"
  local one = redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], ARGV[1], 'LIMIT', 0, 1)
  if one[1] then redis.call('ZREM', KEYS[1], one[1]) end
  return 0
"#;
pub(crate) const GAUGE_ACQUIRE_SRC: &str = r#"
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  local mine = redis.call('ZSCORE', KEYS[1], ARGV[3])
  local before = redis.call('ZCARD', KEYS[1])
  if mine then before = before - 1 end
  redis.call('ZADD', KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]), ARGV[3])
  if redis.call('PTTL', KEYS[1]) < tonumber(ARGV[2]) then
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  redis.call('SADD', KEYS[2], KEYS[1])
  return before
"#;
pub(crate) const GAUGE_RENEW_SRC: &str = r#"
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  redis.call('ZADD', KEYS[1], 'XX', tonumber(ARGV[1]) + tonumber(ARGV[2]), ARGV[3])
  if redis.call('PTTL', KEYS[1]) < tonumber(ARGV[2]) then
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
  end
  return 0
"#;
pub(crate) const GAUGE_READ_SRC: &str = r#"
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  return redis.call('ZCARD', KEYS[1])
"#;
pub(crate) const GAUGE_RELEASE_SRC: &str = r#"
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
  if ARGV[2] == '' then
    redis.call('ZPOPMIN', KEYS[1])
  else
    redis.call('ZREM', KEYS[1], ARGV[2])
  end
  return 0
"#;
pub(crate) const GAUGE_SNAPSHOT_SRC: &str = r#"
  local out = {}
  for _, key in ipairs(redis.call('SMEMBERS', KEYS[1])) do
    redis.call('ZREMRANGEBYSCORE', key, '-inf', ARGV[1])
    local count = redis.call('ZCARD', key)
    if count > 0 then
      if string.sub(key, 1, string.len(ARGV[2])) == ARGV[2] then
        out[#out + 1] = key
        out[#out + 1] = count
      end
    else
      redis.call('SREM', KEYS[1], key)
    end
  end
  return out
"#;
pub(crate) const BUCKETS_SEED_SRC: &str = r#"
  redis.call('DEL', KEYS[1])
  redis.call('HSET', KEYS[1], unpack(ARGV, 2))
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  return 0
"#;
pub(crate) const PUBLISH_SEQUENCED_SRC: &str = r#"
  local seq = redis.call('INCR', KEYS[1])
  redis.call('PUBLISH', ARGV[1], cjson.encode({ topic = ARGV[2], payload = seq .. ':' .. ARGV[3] }))
  return seq
"#;
pub(crate) const BUCKETS_ADD_SRC: &str = r#"
  if redis.call('HEXISTS', KEYS[1], 'seeded') == 0 then return 0 end
  local start = math.floor(tonumber(ARGV[1]) / tonumber(ARGV[2])) * tonumber(ARGV[2])
  redis.call('HINCRBY', KEYS[1], start .. ':r', ARGV[4])
  redis.call('HINCRBY', KEYS[1], start .. ':t', ARGV[5])
  redis.call('HINCRBYFLOAT', KEYS[1], start .. ':c', ARGV[6])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
  return 1
"#;
pub(crate) const BUCKETS_SUM_SRC: &str = r#"
  if redis.call('HEXISTS', KEYS[1], 'seeded') == 0 then return nil end
  local oldest = math.floor((tonumber(ARGV[1]) - tonumber(ARGV[3])) / tonumber(ARGV[2])) * tonumber(ARGV[2])
  local all = redis.call('HGETALL', KEYS[1])
  local r, t, c = 0, 0, 0
  for i = 1, #all, 2 do
    local field = all[i]
    local sep = string.find(field, ':')
    if sep then
      local start = tonumber(string.sub(field, 1, sep - 1))
      local kind = string.sub(field, sep + 1)
      if start < oldest then
        redis.call('HDEL', KEYS[1], field)
      elseif kind == 'r' then r = r + tonumber(all[i + 1])
      elseif kind == 't' then t = t + tonumber(all[i + 1])
      elseif kind == 'c' then c = c + tonumber(all[i + 1])
      end
    end
  end
  return { tostring(r), tostring(t), tostring(c) }
"#;
pub(crate) const MUTEX_RELEASE_SRC: &str = r#"
  if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
  return 0
"#;
pub(crate) const LEASE_ACQUIRE_SRC: &str = r#"
  local holder = redis.call('GET', KEYS[1])
  if holder == false or holder == ARGV[1] then
    redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
    return 1
  end
  return 0
"#;

/// `LEASE_RELEASE` is `MUTEX_RELEASE` in TS: release only what this holder took.
pub(crate) const LEASE_RELEASE_SRC: &str = MUTEX_RELEASE_SRC;
pub static WINDOW_CLAIM: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("WINDOW_CLAIM", WINDOW_CLAIM_SRC));
pub static WINDOW_ROLLBACK: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("WINDOW_ROLLBACK", WINDOW_ROLLBACK_SRC));
pub static GAUGE_ACQUIRE: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("GAUGE_ACQUIRE", GAUGE_ACQUIRE_SRC));
pub static GAUGE_RENEW: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("GAUGE_RENEW", GAUGE_RENEW_SRC));
pub static GAUGE_READ: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("GAUGE_READ", GAUGE_READ_SRC));
pub static GAUGE_RELEASE: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("GAUGE_RELEASE", GAUGE_RELEASE_SRC));
pub static GAUGE_SNAPSHOT: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("GAUGE_SNAPSHOT", GAUGE_SNAPSHOT_SRC));
pub static BUCKETS_SEED: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("BUCKETS_SEED", BUCKETS_SEED_SRC));
pub static PUBLISH_SEQUENCED: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("PUBLISH_SEQUENCED", PUBLISH_SEQUENCED_SRC));
pub static BUCKETS_ADD: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("BUCKETS_ADD", BUCKETS_ADD_SRC));
pub static BUCKETS_SUM: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("BUCKETS_SUM", BUCKETS_SUM_SRC));
pub static MUTEX_RELEASE: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("MUTEX_RELEASE", MUTEX_RELEASE_SRC));
pub static LEASE_ACQUIRE: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("LEASE_ACQUIRE", LEASE_ACQUIRE_SRC));
pub static LEASE_RELEASE: LazyLock<CoordScript> =
    LazyLock::new(|| CoordScript::new("LEASE_RELEASE", LEASE_RELEASE_SRC));

/// Loaded at every connect, in TS `SCRIPTS` order.
pub(crate) fn builtin() -> [&'static CoordScript; 13] {
    [
        &WINDOW_CLAIM,
        &WINDOW_ROLLBACK,
        &GAUGE_ACQUIRE,
        &GAUGE_RENEW,
        &GAUGE_READ,
        &GAUGE_RELEASE,
        &GAUGE_SNAPSHOT,
        &BUCKETS_ADD,
        &BUCKETS_SUM,
        &BUCKETS_SEED,
        &MUTEX_RELEASE,
        &LEASE_ACQUIRE,
        &PUBLISH_SEQUENCED,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frozen TS source, read at test time: a drift in either file fails.
    #[test]
    fn scripts_are_the_frozen_ts_text() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../apps/gateway/src/coord/redis.ts"
        );
        let ts = std::fs::read_to_string(path).expect("frozen TS redis coord");
        for script in builtin() {
            let start = format!("const {} = `", script.name);
            let at = ts
                .find(&start)
                .unwrap_or_else(|| panic!("{} missing in TS", script.name))
                + start.len();
            let len = ts[at..].find('`').expect("closing backtick");
            assert_eq!(
                &ts[at..at + len],
                script.source,
                "{} drifted from TS",
                script.name
            );
        }
        assert!(ts.contains("const LEASE_RELEASE = MUTEX_RELEASE;"));
        assert_eq!(LEASE_RELEASE.sha, MUTEX_RELEASE.sha);
    }
}
