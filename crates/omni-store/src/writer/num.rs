//! SQLite's numeric arithmetic, so a batch can fold a rollup row in memory and
//! land on the very value the TS per-request `x = x + excluded.x` upserts reach.
//!
//! Folding in memory and writing the result once is what keeps a hot key's row
//! to one write per batch. Adding the batch's *sum* instead would not be the
//! same number: IEEE addition is not associative, so `cost + (a + b)` and
//! `(cost + a) + b` differ in the last bit, and `cost_usd` is a REAL.

use crate::error::StoreError;
use crate::js;
use rusqlite::types::{Value as SqlValue, ValueRef};

/// A numeric cell: what SQLite holds in an INTEGER or REAL column.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Num {
    Int(i64),
    Real(f64),
}

impl Num {
    /// SQLite `+`: integer when both are and it does not overflow, else REAL.
    pub(crate) fn add(self, other: Self) -> Self {
        match (self, other) {
            (Self::Int(a), Self::Int(b)) => a
                .checked_add(b)
                .map_or_else(|| Self::Real(to_f64(a) + to_f64(b)), Self::Int),
            (a, b) => Self::Real(a.as_f64() + b.as_f64()),
        }
    }

    fn as_f64(self) -> f64 {
        match self {
            Self::Int(v) => to_f64(v),
            Self::Real(v) => v,
        }
    }

    /// INTEGER column affinity: a REAL that converts losslessly is stored as
    /// an integer (`sqlite3VdbeIntegerAffinity`).
    pub(crate) fn integer_affinity(self) -> Self {
        match self {
            Self::Real(r)
                if r.fract() == 0.0
                    && r > -9.223_372_036_854_775e18
                    && r < 9.223_372_036_854_775e18 =>
            {
                #[allow(clippy::cast_possible_truncation)]
                Self::Int(r as i64)
            }
            other => other,
        }
    }

    /// REAL column affinity.
    pub(crate) fn real_affinity(self) -> Self {
        Self::Real(self.as_f64())
    }

    /// A JS number bound by `bun:sqlite`.
    pub(crate) fn bound(v: f64) -> Self {
        match js::bind_number(v) {
            SqlValue::Integer(i) => Self::Int(i),
            _ => Self::Real(v),
        }
    }

    /// A stored cell, which must be numeric.
    pub(crate) fn read(cell: ValueRef<'_>, what: &str) -> Result<Self, StoreError> {
        match cell {
            ValueRef::Integer(v) => Ok(Self::Int(v)),
            ValueRef::Real(v) => Ok(Self::Real(v)),
            _ => Err(StoreError::Corrupt(format!("{what} is not a number"))),
        }
    }

    pub(crate) fn value(self) -> SqlValue {
        match self {
            Self::Int(v) => SqlValue::Integer(v),
            Self::Real(v) => SqlValue::Real(v),
        }
    }
}

#[allow(clippy::cast_precision_loss)]
fn to_f64(v: i64) -> f64 {
    v as f64
}

#[cfg(test)]
mod tests {
    use super::Num;

    #[test]
    fn adds_as_sqlite_adds() {
        assert_eq!(Num::Int(2).add(Num::Int(3)), Num::Int(5));
        assert_eq!(
            Num::Int(i64::MAX).add(Num::Int(1)),
            Num::Real(9.223_372_036_854_776e18)
        );
        assert_eq!(Num::Int(1).add(Num::Real(0.5)), Num::Real(1.5));
        assert_eq!(Num::Real(2.0).integer_affinity(), Num::Int(2));
        assert_eq!(Num::Real(-0.0).integer_affinity(), Num::Int(0));
        assert_eq!(Num::Real(2.5).integer_affinity(), Num::Real(2.5));
        assert_eq!(Num::Int(3).real_affinity(), Num::Real(3.0));
        assert_eq!(Num::bound(-0.0), Num::Real(-0.0));
        assert_eq!(Num::bound(4.0), Num::Int(4));
    }
}
