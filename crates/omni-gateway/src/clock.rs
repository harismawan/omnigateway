//! The wall clock as TS reads it (`Date.now()`: integer epoch ms) and the
//! random ids the gateway mints.

/// Epoch milliseconds, `Date.now()`.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// `crypto.randomUUID()`: a v4 UUID in lowercase hex.
pub fn uuid_v4() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format_uuid(&b)
}

/// `req_` + an RFC 9562 UUIDv7, minted monotonically in this process.
///
/// TS mints `req_${crypto.randomUUID()}` (v4). This is a deliberate,
/// documented difference (spec §Writes, "Request ids: time-ordered"):
/// `request_logs.id` is the table's primary key, and random v4 keys scatter
/// every insert across that index, which capped the writer below the
/// gateway's own throughput. v7 keys append at the index's right edge. The
/// `req_<lowercase hyphenated uuid>` shape, and every id derived from it, are
/// unchanged.
pub fn request_id() -> String {
    format!("req_{}", format_uuid(&uuid_v7()))
}

/// The last `unix_ts_ms << 12 | rand_a` minted, so the next one is larger.
static V7_LAST: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// An RFC 9562 UUIDv7 that sorts after every one minted before it here.
///
/// **Monotonicity: RFC 9562 §6.2 method 1, a fixed-length dedicated counter**
/// in the 12-bit `rand_a` field.
/// - In a new millisecond the counter starts at a random value below 2^11, so
///   at least 2048 more fit in that millisecond.
/// - Within the same millisecond (or if the clock steps back), the 60-bit
///   `unix_ts_ms << 12 | rand_a` value is the last one plus one.
/// - Should the counter overflow, it carries into the timestamp, which then
///   runs at most a few ms ahead of the clock until the clock catches up (the
///   RFC allows this). At the gateway's ~50 k req/s, about 50 ids share a
///   millisecond, far from the 2048 headroom.
///
/// One atomic compare-and-swap per id keeps the order across threads. The
/// 62 bits of `rand_b` come from `rand`'s thread-local CSPRNG (ChaCha seeded
/// from the OS).
fn uuid_v7() -> [u8; 16] {
    use std::sync::atomic::Ordering;
    let now = u64::try_from(now_ms()).unwrap_or(0) & ((1 << 48) - 1);
    let start: u64 = rand::random::<u64>() & 0x7ff;
    let mut last = V7_LAST.load(Ordering::Relaxed);
    let next = loop {
        let fresh = (now << 12) | start;
        let next = if fresh > last { fresh } else { last + 1 };
        match V7_LAST.compare_exchange_weak(last, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break next,
            Err(seen) => last = seen,
        }
    };
    let ts = next >> 12;
    let rand_a = next & 0xfff;
    let mut b: [u8; 16] = rand::random();
    b[..6].copy_from_slice(&ts.to_be_bytes()[2..]);
    // ver (4 bits) = 7, then rand_a's top 4 bits; rand_a's low 8 bits.
    b[6] = 0x70 | u8::try_from(rand_a >> 8).unwrap_or(0);
    b[7] = u8::try_from(rand_a & 0xff).unwrap_or(0);
    // var = 0b10, then rand_b.
    b[8] = (b[8] & 0x3f) | 0x80;
    b
}

/// Lowercase hyphenated `8-4-4-4-12`.
fn format_uuid(b: &[u8; 16]) -> String {
    let mut s = String::with_capacity(36);
    for (i, x) in b.iter().enumerate() {
        if matches!(i, 4 | 6 | 8 | 10) {
            s.push('-');
        }
        s.push(char::from(b"0123456789abcdef"[usize::from(x >> 4)]));
        s.push(char::from(b"0123456789abcdef"[usize::from(x & 15)]));
    }
    s
}

/// `Math.random()`: uniform in [0, 1).
pub fn random() -> f64 {
    rand::random::<f64>()
}

#[cfg(test)]
mod tests {
    /// `req_<8-4-4-4-12 lowercase hex>`, version 7, variant `10`.
    fn assert_v7(id: &str) -> u64 {
        let u = id.strip_prefix("req_").expect("req_ prefix");
        assert_eq!(u.len(), 36, "{id}");
        for (i, c) in u.char_indices() {
            if matches!(i, 8 | 13 | 18 | 23) {
                assert_eq!(c, '-', "{id}");
            } else {
                assert!(matches!(c, '0'..='9' | 'a'..='f'), "{id}");
            }
        }
        assert_eq!(&u[14..15], "7", "version 7: {id}");
        assert!(
            matches!(&u[19..20], "8" | "9" | "a" | "b"),
            "variant 10: {id}"
        );
        let hex: String = u.replace('-', "");
        u64::from_str_radix(&hex[..12], 16).expect("timestamp")
    }

    #[test]
    fn request_ids_are_uuid_v7_stamped_with_now() {
        let id = super::request_id();
        let ms = assert_v7(&id);
        let now = u64::try_from(super::now_ms()).expect("now");
        assert!(ms.abs_diff(now) <= 1000, "{ms} vs {now}");
    }

    #[test]
    fn request_ids_are_strictly_increasing_in_a_tight_loop() {
        let ids: Vec<String> = (0..100_000).map(|_| super::request_id()).collect();
        for w in ids.windows(2) {
            assert!(w[0] < w[1], "{} !< {}", w[0], w[1]);
        }
        for id in ids.iter().step_by(997) {
            assert_v7(id);
        }
    }

    #[test]
    fn request_ids_across_threads_are_sorted_per_thread_and_unique() {
        let threads: Vec<_> = (0..8)
            .map(|_| {
                std::thread::spawn(|| (0..20_000).map(|_| super::request_id()).collect::<Vec<_>>())
            })
            .collect();
        let mut all = std::collections::HashSet::new();
        for t in threads {
            let ids = t.join().expect("thread");
            for w in ids.windows(2) {
                assert!(w[0] < w[1], "{} !< {}", w[0], w[1]);
            }
            for id in ids {
                assert!(all.insert(id), "duplicate");
            }
        }
        assert_eq!(all.len(), 160_000);
    }

    #[test]
    fn uuids_have_the_v4_shape() {
        let u = super::uuid_v4();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
        assert!(matches!(&u[19..20], "8" | "9" | "a" | "b"));
    }
}
