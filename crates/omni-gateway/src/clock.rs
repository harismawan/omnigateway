//! The wall clock as TS reads it (`Date.now()`: integer epoch ms) and the
//! random ids the gateway mints.

use rand::{Rng, SeedableRng};

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
///
/// # Panics
/// If called before `init_request_ids` succeeds (normally done by `start`).
pub fn request_id() -> String {
    format!("req_{}", format_uuid(&uuid_v7()))
}

struct RequestIds {
    last: (u64, u128),
    rng: rand::rngs::StdRng,
}

static REQUEST_IDS: std::sync::Mutex<Option<RequestIds>> = std::sync::Mutex::new(None);

/// Seed the actual request-ID CSPRNG before serving; never use an implicitly
/// initialized thread RNG on this path. Repeated boots retain process ordering.
pub fn init_request_ids() -> Result<(), String> {
    init_request_ids_with(&REQUEST_IDS, || {
        rand::rngs::StdRng::try_from_os_rng().map_err(|e| e.to_string())
    })
}

fn init_request_ids_with(
    state: &std::sync::Mutex<Option<RequestIds>>,
    seed: impl FnOnce() -> Result<rand::rngs::StdRng, String>,
) -> Result<(), String> {
    let mut state = state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if state.is_none() {
        let rng =
            seed().map_err(|e| format!("request-ID OS entropy initialization failed: {e}"))?;
        *state = Some(RequestIds { last: (0, 0), rng });
    }
    Ok(())
}

/// The 74 bits after the version and variant: `rand_a` (12) then `rand_b` (62).
const SUB_MS_BITS: u32 = 74;
/// Largest random step within a millisecond: 2^56. At most 2^18 (262 144)
/// steps fit in a millisecond after the largest start (2^73) before the
/// field would overflow; the gateway mints ~50 per ms. A fresh millisecond
/// starts at a random value below 2^73, keeping that headroom.
const STEP_BITS: u32 = 56;

/// The next `(ms, rand_a‖rand_b)` after `last` at clock `now`, from two
/// random draws: `fresh` for a new millisecond's start, `step` for the
/// increment within one.
fn v7_next(last: (u64, u128), now: u64, fresh: u128, step: u128) -> (u64, u128) {
    let start = |r: u128| r & ((1 << (SUB_MS_BITS - 1)) - 1);
    let (last_ms, last_sub) = last;
    if now > last_ms {
        return (now, start(fresh));
    }
    let step = (step & ((1 << STEP_BITS) - 1)) + 1;
    match last_sub
        .checked_add(step)
        .filter(|v| *v < (1 << SUB_MS_BITS))
    {
        Some(v) => (last_ms, v),
        // Rollover: the next millisecond, started afresh.
        None => (last_ms + 1, start(fresh)),
    }
}

/// An RFC 9562 UUIDv7 that sorts after every one minted before it here.
///
/// **Monotonicity: RFC 9562 §6.2 method 3, monotonic random.** The 74 bits
/// of `rand_a` and `rand_b` are one counter:
/// - in a millisecond later than the last id's, it starts at a fresh random
///   value below 2^73;
/// - within the same millisecond (or if the clock steps back, in which case
///   the last id's millisecond is kept), it is the last value plus a random
///   step in `1..=2^56`.
///
/// Random steps hide exact intervening counts, but permit statistical rate
/// estimates. Method 1's counter in `rand_a` stepped by exactly 1.
///
/// **Rollover:** if a step would overflow the 74 bits, the millisecond is
/// bumped by one and the counter starts afresh. The timestamp may then run
/// ahead of the clock by a millisecond per rollover, and is kept until the
/// clock passes it (the RFC allows this). With the bounds above that needs
/// over 262 144 ids in one millisecond.
///
/// One short lock per id keeps the order across threads. Randomness comes
/// from the process CSPRNG fallibly seeded from OS entropy at boot.
/// The 48-bit timestamp representation ends in year 10889: masking/truncation
/// at that boundary cannot preserve timestamp accuracy or monotonic ordering.
fn uuid_v7() -> [u8; 16] {
    let now = u64::try_from(now_ms()).unwrap_or(0) & ((1 << 48) - 1);
    let (ms, sub) = {
        let mut state = REQUEST_IDS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let ids = state
            .as_mut()
            .expect("request-ID RNG must be initialized at boot");
        let next = v7_next(ids.last, now, ids.rng.random(), ids.rng.random());
        ids.last = next;
        next
    };
    let rand_a = u16::try_from(sub >> 62).unwrap_or(0);
    let rand_b = u64::try_from(sub & ((1 << 62) - 1)).unwrap_or(0);
    let mut b = [0u8; 16];
    b[..6].copy_from_slice(&ms.to_be_bytes()[2..]);
    // ver = 7, then rand_a's 12 bits.
    b[6..8].copy_from_slice(&(0x7000 | rand_a).to_be_bytes());
    // var = 0b10, then rand_b's 62 bits.
    b[8..].copy_from_slice(&((0b10 << 62) | rand_b).to_be_bytes());
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
    #[test]
    fn entropy_failure_leaves_request_ids_uninitialized_and_can_retry() {
        use rand::{Rng, SeedableRng};
        let state = std::sync::Mutex::new(None);
        let error = super::init_request_ids_with(&state, || Err("injected failure".into()))
            .expect_err("boot must fail");
        assert_eq!(
            error,
            "request-ID OS entropy initialization failed: injected failure"
        );
        assert!(state.lock().expect("lock").is_none());
        super::init_request_ids_with(&state, || Ok(rand::rngs::StdRng::from_seed([42; 32])))
            .expect("retry");
        let mut expected = rand::rngs::StdRng::from_seed([42; 32]);
        let mut guard = state.lock().expect("lock");
        let ids = guard.as_mut().expect("initialized");
        assert_eq!(ids.rng.random::<u128>(), expected.random::<u128>());
        ids.last = (123, 456);
        drop(guard);
        super::init_request_ids_with(&state, || panic!("must not reseed"))
            .expect("idempotent boot");
        assert_eq!(
            state.lock().expect("lock").as_ref().expect("ids").last,
            (123, 456)
        );
    }

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
        super::init_request_ids().expect("entropy");
        let id = super::request_id();
        let ms = assert_v7(&id);
        let now = u64::try_from(super::now_ms()).expect("now");
        assert!(ms.abs_diff(now) <= 1000, "{ms} vs {now}");
    }

    #[test]
    fn request_ids_are_strictly_increasing_in_a_tight_loop() {
        super::init_request_ids().expect("entropy");
        let ids: Vec<String> = (0..100_000).map(|_| super::request_id()).collect();
        for w in ids.windows(2) {
            assert!(w[0] < w[1], "{} !< {}", w[0], w[1]);
        }
        for id in ids.iter().step_by(997) {
            assert_v7(id);
        }
    }

    /// The ordered value after the timestamp: `rand_a` (12 bits) and `rand_b`
    /// (62), as one 74-bit number.
    fn sub_ms(id: &str) -> u128 {
        let hex: String = id["req_".len()..].replace('-', "");
        let v = u128::from_str_radix(&hex, 16).expect("hex");
        ((v >> 64) & 0xfff) << 62 | (v & ((1 << 62) - 1))
    }

    /// RFC 9562 method 3: within one millisecond the 74-bit `rand_a`‖`rand_b`
    /// value is a single counter that grows by a random step (≥ 1). Method 1
    /// kept a counter in `rand_a` alone: whenever a fresh random start did
    /// not exceed it, the next id's `rand_a` was the last one plus exactly 1,
    /// so a client could count the requests minted between two of its own.
    /// Here `rand_a` steps by 1 only on a carry out of `rand_b`, which a step
    /// of at most 2^56 makes about 1 in 128.
    #[test]
    fn same_millisecond_ids_step_by_a_random_amount() {
        super::init_request_ids().expect("entropy");
        let ids: Vec<String> = (0..50_000).map(|_| super::request_id()).collect();
        let mut same_ms = 0;
        let mut rand_a_plus_one = 0;
        let mut steps = std::collections::HashSet::new();
        for w in ids.windows(2) {
            if w[0][4..17] == w[1][4..17] {
                let (a, b) = (sub_ms(&w[0]), sub_ms(&w[1]));
                assert!(b > a, "{} !< {}", w[0], w[1]);
                same_ms += 1;
                steps.insert(b - a);
                if (b >> 62) == (a >> 62) + 1 {
                    rand_a_plus_one += 1;
                }
            }
        }
        assert!(same_ms > 1000, "only {same_ms} same-ms pairs");
        assert!(
            rand_a_plus_one * 20 < same_ms,
            "rand_a counts: {rand_a_plus_one} of {same_ms} same-ms steps are +1"
        );
        assert!(
            steps.len() > same_ms * 9 / 10,
            "steps repeat: {} distinct of {same_ms}",
            steps.len()
        );
    }

    /// Rollover: a step past the 74 bits moves to the next millisecond (ahead
    /// of a clock that has not moved), started below 2^73; a clock that went
    /// back keeps the last millisecond; ordering holds through both.
    #[test]
    fn a_sub_millisecond_overflow_bumps_the_timestamp() {
        let top = (1u128 << 74) - 1;
        let next = super::v7_next((1000, top - 5), 1000, u128::MAX, u128::MAX);
        assert_eq!(next.0, 1001, "bumped past the clock");
        assert!(next.1 < 1 << 73, "fresh start keeps headroom");
        assert!((next.0, next.1) > (1000, top - 5));
        // The clock still at 1000 (now behind): steps continue in 1001.
        let after = super::v7_next(next, 1000, 0, 0);
        assert_eq!((after.0, after.1), (1001, next.1 + 1));
        // The clock stepping back keeps order too.
        let back = super::v7_next((5000, 7), 4000, 0, 41);
        assert_eq!(back, (5000, 7 + 42));
        // Steps are 1..=2^56, never 0.
        assert_eq!(super::v7_next((9, 0), 9, 0, 0).1, 1);
        assert_eq!(super::v7_next((9, 0), 9, 0, u128::MAX).1, 1 << 56);
    }

    #[test]
    fn request_ids_across_threads_are_sorted_per_thread_and_unique() {
        super::init_request_ids().expect("entropy");
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
