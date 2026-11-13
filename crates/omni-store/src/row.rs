//! Typed cell reads that name the table and column when a row holds something
//! the TS reader could not have used either.

use crate::error::StoreError;
use crate::js;
use rusqlite::Row;
use rusqlite::types::ValueRef;

fn corrupt(table: &str, column: &str, wanted: &str, got: ValueRef<'_>) -> StoreError {
    StoreError::Corrupt(format!(
        "{table}.{column}: expected {wanted}, found {}",
        got.data_type()
    ))
}

pub(crate) fn text(row: &Row<'_>, table: &str, column: &str) -> Result<String, StoreError> {
    opt_text(row, table, column)?
        .ok_or_else(|| StoreError::Corrupt(format!("{table}.{column}: expected text, found null")))
}

pub(crate) fn opt_text(
    row: &Row<'_>,
    table: &str,
    column: &str,
) -> Result<Option<String>, StoreError> {
    match row.get_ref(column)? {
        ValueRef::Null => Ok(None),
        ValueRef::Text(t) => Ok(Some(String::from_utf8_lossy(t).into_owned())),
        other => Err(corrupt(table, column, "text", other)),
    }
}

/// A JS number, as `bun:sqlite` returns INTEGER and REAL alike.
pub(crate) fn number(row: &Row<'_>, table: &str, column: &str) -> Result<f64, StoreError> {
    let cell = row.get_ref(column)?;
    js::number(cell).ok_or_else(|| corrupt(table, column, "a number", cell))
}

/// An epoch-ms instant or a count. A REAL holding a whole number is accepted,
/// since TS would read the same value; a fraction is not an instant.
pub(crate) fn integer(row: &Row<'_>, table: &str, column: &str) -> Result<i64, StoreError> {
    opt_integer(row, table, column)?.ok_or_else(|| {
        StoreError::Corrupt(format!("{table}.{column}: expected an integer, found null"))
    })
}

pub(crate) fn opt_integer(
    row: &Row<'_>,
    table: &str,
    column: &str,
) -> Result<Option<i64>, StoreError> {
    match row.get_ref(column)? {
        ValueRef::Null => Ok(None),
        ValueRef::Integer(v) => Ok(Some(v)),
        #[allow(clippy::cast_possible_truncation)]
        ValueRef::Real(v) if js::is_safe_integer(v) => Ok(Some(v as i64)),
        other => Err(corrupt(table, column, "an integer", other)),
    }
}

/// `row.<column> === 1`.
pub(crate) fn flag(row: &Row<'_>, column: &str) -> Result<bool, StoreError> {
    Ok(js::is_one(row.get_ref(column)?))
}
