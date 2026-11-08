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

/// `req_${crypto.randomUUID()}`.
pub fn request_id() -> String {
    format!("req_{}", uuid_v4())
}

/// `Math.random()`: uniform in [0, 1).
pub fn random() -> f64 {
    rand::random::<f64>()
}

#[cfg(test)]
mod tests {
    #[test]
    fn uuids_have_the_v4_shape() {
        let u = super::uuid_v4();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
        assert!(matches!(&u[19..20], "8" | "9" | "a" | "b"));
        assert!(super::request_id().starts_with("req_"));
    }
}
