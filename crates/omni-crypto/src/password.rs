//! Console passwords (`packages/control/src/adminAuth.ts`, `Bun.password`).
//!
//! New hashes are argon2id with the OWASP baseline TS writes — m=19456 KiB,
//! t=2, p=1, a 32-byte salt and a 32-byte output — as a PHC string
//! (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`, unpadded standard
//! base64), which `Bun.password.verify` reads back.
//!
//! [`verify`] reads any argon2 PHC string (`argon2id`, `argon2i`, `argon2d`,
//! with the parameters it names), as `Bun.password.verify` does, so hashes
//! written by Bun and by the earlier `@node-rs/argon2` build (16-byte salts)
//! both verify. Anything else is "no", as TS's `passwordMatches` reads a
//! verify that throws.
//!
//! # Known differences from `Bun.password.verify`
//!
//! - A bcrypt hash (`$2b$…`) is "no" here; Bun verifies it. Nothing in this
//!   gateway has ever written one: only a hand edit of `settings` could.
//! - A hash naming more than [`MAX_MEMORY_KIB`] of memory is "no" rather than
//!   attempted: allocation failure aborts a Rust process, where Bun throws
//!   (also "no"). Again only a hand edit could write one.

use argon2::{
    Algorithm, Argon2, Params, PasswordHash, PasswordHasher as _, PasswordVerifier as _, Version,
};
use rand::Rng as _;

/// `ARGON2.memoryCost` (KiB).
pub const MEMORY_KIB: u32 = 19_456;
/// `ARGON2.timeCost`.
pub const TIME_COST: u32 = 2;
/// Bun's parallelism (fixed at 1).
pub const PARALLELISM: u32 = 1;
/// Bun's salt length in bytes.
pub const SALT_BYTES: usize = 32;
/// Bun's output length in bytes.
pub const OUTPUT_BYTES: usize = 32;
/// The largest memory cost [`verify`] will attempt (1 GiB).
pub const MAX_MEMORY_KIB: u32 = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum PasswordError {
    /// `Bun.password.hash("")` throws this; the length rule makes it
    /// unreachable from the routes.
    #[error("password must not be empty")]
    Empty,
    #[error("password hashing failed: {0}")]
    Hash(String),
}

fn hasher() -> Result<Argon2<'static>, PasswordError> {
    let params = Params::new(MEMORY_KIB, TIME_COST, PARALLELISM, Some(OUTPUT_BYTES))
        .map_err(|e| PasswordError::Hash(e.to_string()))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// `Bun.password.hash(password, ARGON2)`: a fresh PHC string. CPU- and
/// memory-heavy (~19 MiB, tens of ms): call it off the async runtime.
pub fn hash(password: &str) -> Result<String, PasswordError> {
    if password.is_empty() {
        return Err(PasswordError::Empty);
    }
    let mut salt = [0u8; SALT_BYTES];
    rand::rng().fill_bytes(&mut salt);
    Ok(hasher()?
        .hash_password_with_salt(password.as_bytes(), &salt)
        .map_err(|e| PasswordError::Hash(e.to_string()))?
        .to_string())
}

/// `passwordMatches(stored, password)`: false for an absent hash, a hash
/// that does not parse, and a wrong password. The comparison of outputs is
/// constant-time (`password_hash::Output`'s equality). As heavy as [`hash`].
pub fn verify(stored: Option<&str>, password: &str) -> bool {
    let Some(stored) = stored else {
        return false;
    };
    let Ok(parsed) = PasswordHash::new(stored) else {
        return false;
    };
    if Algorithm::try_from(parsed.algorithm.as_str()).is_err() {
        return false;
    }
    let Ok(params) = Params::try_from(&parsed) else {
        return false;
    };
    if params.m_cost() > MAX_MEMORY_KIB {
        return false;
    }
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `adminAuth.test.ts`: "verifies existing legacy hashes from @node-rs/argon2".
    const LEGACY: &str = "$argon2id$v=19$m=19456,t=2,p=1$l3SA90jOgwe6OXTFGCdu6Q$MlCWIoHV+Wa1DwZZkoJpnR4syDmJlkdiJdeDzjzHL9o";
    /// Written by `Bun.password.hash("hunter2hunter2", ARGON2)` (Bun 1.4.4).
    const BUN: &str = "$argon2id$v=19$m=19456,t=2,p=1$B6B5xf9ucRl7Z7ofsuZ0IDgFoSXxe8xqWUTD9F6VQrE$Pd/RIhT6ELx3h7ET31ABelOkbM2jeJpBLynHoqRuaG0";
    /// `Bun.password.hash("hunter2hunter2", {algorithm: "argon2i", ...})`.
    const BUN_I: &str = "$argon2i$v=19$m=19456,t=2,p=1$75mkeoyElYJP922T7Zpmu3ptDW4/JX+q6CTJMXAa0ug$4M0vQUlTMZwUs8vCMFe00TulwxfHhYcczuMn2C9IaY0";

    #[test]
    fn verifies_hashes_ts_wrote() {
        assert!(verify(Some(LEGACY), "testpassword123"));
        assert!(!verify(Some(LEGACY), "wrongpassword"));
        assert!(verify(Some(BUN), "hunter2hunter2"));
        assert!(!verify(Some(BUN), "hunter2hunter3"));
        assert!(!verify(Some(BUN), ""));
        assert!(verify(Some(BUN_I), "hunter2hunter2"));
    }

    #[test]
    fn absent_and_unparseable_hashes_are_no() {
        assert!(!verify(None, "hunter2hunter2"));
        assert!(!verify(Some(""), "hunter2hunter2"));
        assert!(!verify(Some("garbage"), "hunter2hunter2"));
        assert!(!verify(
            Some("$2b$10$Cegh8t9coHt0ehKqBgRDDOOyOd9h3VP3lyFn48YPce1q6MLtN3uUq"),
            "hunter2hunter2"
        ));
        assert!(!verify(
            Some(
                "$argon2id$v=19$m=2097152,t=2,p=1$l3SA90jOgwe6OXTFGCdu6Q$MlCWIoHV+Wa1DwZZkoJpnR4syDmJlkdiJdeDzjzHL9o"
            ),
            "testpassword123"
        ));
    }

    #[test]
    fn new_hashes_use_the_ts_format_and_verify() {
        let a = hash("correct-horse-battery").expect("hash");
        let b = hash("correct-horse-battery").expect("hash");
        assert_ne!(a, b, "fresh salt per hash");
        let parts: Vec<&str> = a.split('$').collect();
        assert_eq!(parts[..4], ["", "argon2id", "v=19", "m=19456,t=2,p=1"]);
        // 32 bytes unpadded base64 is 43 characters, salt and output alike.
        assert_eq!(parts[4].len(), 43);
        assert_eq!(parts[5].len(), 43);
        assert!(verify(Some(&a), "correct-horse-battery"));
        assert!(!verify(Some(&a), "correct-horse-batterz"));
    }

    #[test]
    fn empty_password_is_refused_like_bun() {
        assert!(matches!(hash(""), Err(PasswordError::Empty)));
    }
}
