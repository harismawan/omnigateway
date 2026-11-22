//! The Lua scripts. Every node of one fleet must load the same digests.
//! `scripts_are_byte_stable` pins the digest of each: changing a script is
//! deliberate and updates its digest with it.
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

/// `LEASE_RELEASE` is `MUTEX_RELEASE`: release only what this holder took.
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

/// Loaded at every connect, in this order.
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

    /// The pinned `EVALSHA` digest (SHA-1 of the text) of every built-in
    /// script.
    /// Every process in a fleet loads these digests, so a script that changes
    /// by one byte is a different script: a node on the old text and a node
    /// on the new one run different server-side logic against the same keys.
    /// Change a script only on purpose, and update its digest here with it.
    const DIGESTS: [(&str, &str); 13] = [
        ("WINDOW_CLAIM", "b688e999514b45766a7405e01ecf1ec9db34f406"),
        (
            "WINDOW_ROLLBACK",
            "9eb4084c9f65a3f4c5ad98cb87e60570c45a4317",
        ),
        ("GAUGE_ACQUIRE", "65ba4085d572c588766be1e43618fb4c642ee473"),
        ("GAUGE_RENEW", "f9d7537e43058399e1d4a6955c1dc66e9a55aa8b"),
        ("GAUGE_READ", "e7150687b8795f326d313045a18079121847964d"),
        ("GAUGE_RELEASE", "0608aa38aeb6e01088872768916b24a25b33bb1b"),
        ("GAUGE_SNAPSHOT", "66ec7f6c77e3c822761a51a4cafd43d394910ce1"),
        ("BUCKETS_ADD", "cb58b80c2f160efcbf9e789f6367c8a4d805c7b0"),
        ("BUCKETS_SUM", "58fca06c1a6565d024a28f7023b18d78cb91bab2"),
        ("BUCKETS_SEED", "c08ab8b91b81ad23a8ec285633e7c8d3621291f0"),
        ("MUTEX_RELEASE", "e810903f64fc9d5a53508485e066cc60b5b2a370"),
        ("LEASE_ACQUIRE", "fb02741994f17fedcfa2d4a3891beaa948399274"),
        (
            "PUBLISH_SEQUENCED",
            "b9cab81eee64f591234849533b329327365b07e7",
        ),
    ];

    #[test]
    fn scripts_are_byte_stable() {
        let scripts = builtin();
        assert_eq!(scripts.len(), DIGESTS.len());
        for (script, (name, sha)) in scripts.iter().zip(DIGESTS) {
            assert_eq!(script.name, name);
            assert_eq!(script.sha, sha, "{name} changed");
        }
        // Lease release is mutex release: release only what this holder took.
        assert_eq!(LEASE_RELEASE.source, MUTEX_RELEASE.source);
        assert_eq!(LEASE_RELEASE.sha, MUTEX_RELEASE.sha);
    }
}
