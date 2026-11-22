//! SQLite body artifacts. File first, then the row; no rename/temporary file.
use super::{node_join, prepare_put};
use crate::{
    SqliteStore, StoreError,
    operator_cell::Cell,
    pg::bodies::{
        BodyRead, BodyReadRow, BodyRow, DetailState, MAX_ENVELOPE_BYTES, decode, rel_path_for, seal,
    },
};
use omni_crypto::field::FieldKey;
use omni_ir::jsjson::JsValue;
use rusqlite::{Connection, OptionalExtension, params};
use std::{io::Read, path::Path};

fn io_error(e: std::io::Error) -> StoreError {
    StoreError::Refused(e.to_string())
}

/// `dir` is the request_bodies directory beside the database.
pub fn put(
    c: &Connection,
    key: &FieldKey,
    dir: &Path,
    input: &JsValue,
) -> Result<BodyRow, StoreError> {
    let (id, at, json, truncated) = prepare_put(input)?;
    let sealed = seal(key, &json)?;
    let rel = rel_path_for(&id, at);
    let path = node_join(&dir.to_string_lossy(), &rel);
    std::fs::create_dir_all(path.parent().expect("shard parent")).map_err(io_error)?;
    std::fs::write(path, &sealed.bytes).map_err(io_error)?;
    let row = BodyRow {
        request_id: id,
        at,
        rel_path: Some(rel),
        size_bytes: sealed.bytes.len() as i64,
        sha256: Some(sealed.sha256),
        detail_state: DetailState::Ready,
        truncated,
    };
    c.execute("INSERT INTO request_bodies (request_id,at,rel_path,size_bytes,sha256,detail_state,truncated) VALUES (?,?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET at=excluded.at,rel_path=excluded.rel_path,size_bytes=excluded.size_bytes,sha256=excluded.sha256,detail_state=excluded.detail_state,truncated=excluded.truncated",params![row.request_id,row.at,row.rel_path,row.size_bytes,row.sha256,row.detail_state.as_str(),i64::from(row.truncated)])?;
    Ok(row)
}

pub fn get(
    c: &Connection,
    key: &FieldKey,
    dir: &Path,
    id: &str,
) -> Result<Option<BodyRead>, StoreError> {
    let found = c.query_row("SELECT request_id,at,rel_path,size_bytes,sha256,detail_state,truncated FROM request_bodies WHERE request_id=?", [id], |r| {
        (0..7).map(|i| Ok(Cell::read(r.get_ref(i)?))).collect::<Result<Vec<_>, rusqlite::Error>>()
    }).optional()?;
    let Some(cells) = found else {
        return Ok(None);
    };
    let state = match &cells[5] {
        Cell::String(s) => DetailState::parse(s),
        _ => DetailState::None,
    };
    // Only null short-circuits path validation. `path.join` throws for every
    // other non-string, outside the artifact fetch's catch.
    let rel_path = match &cells[2] {
        Cell::String(s) => Some(s.clone()),
        Cell::Null => None,
        _ if state == DetailState::None => None,
        _ => return Err(StoreError::Refused("artifact path must be a string".into())),
    };
    let mut row = BodyReadRow {
        request_id: cells[0].json(),
        at: cells[1].json(),
        rel_path,
        size_bytes: cells[3].json(),
        sha256: match &cells[4] {
            Cell::String(s) => Some(s.clone()),
            _ => None,
        },
        detail_state: state,
        truncated: matches!(cells[6], Cell::Number(n) if n == 1.0),
    };
    let Some(rel) = &row.rel_path else {
        return Ok(Some(BodyRead {
            row,
            artifact: None,
        }));
    };
    if row.detail_state == DetailState::None {
        return Ok(Some(BodyRead {
            row,
            artifact: None,
        }));
    }
    let path = node_join(&dir.to_string_lossy(), rel);
    let read = (|| {
        let file = std::fs::File::open(path).map_err(|_| DetailState::Missing)?;
        let size = file.metadata().map_err(|_| DetailState::Missing)?.len();
        if size > MAX_ENVELOPE_BYTES as u64 {
            return Err(DetailState::Corrupt);
        }
        let mut bytes = Vec::new();
        file.take(size + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| DetailState::Missing)?;
        if bytes.len() as u64 > size {
            return Err(DetailState::Corrupt);
        }
        // Strict digest equality: a non-null non-string can never equal hex.
        let digest = match &cells[4] {
            Cell::Null => None,
            Cell::String(s) => Some(s.as_str()),
            _ => return Err(DetailState::Corrupt),
        };
        decode(key, &bytes, digest).ok_or(DetailState::Corrupt)
    })();
    let (state, artifact) = match read {
        Ok(a) => (DetailState::Ready, Some(a)),
        Err(s) => (s, None),
    };
    if state != DetailState::Ready || row.detail_state != state {
        c.execute(
            "UPDATE request_bodies SET detail_state=? WHERE request_id=?",
            params![state.as_str(), id],
        )?;
    }
    row.detail_state = state;
    Ok(Some(BodyRead { row, artifact }))
}

impl SqliteStore {
    pub fn put_body(&self, key: &FieldKey, input: &JsValue) -> Result<BodyRow, StoreError> {
        put(
            &self.conn,
            key,
            &self
                .path
                .parent()
                .unwrap_or(Path::new("."))
                .join("request_bodies"),
            input,
        )
    }
    pub fn get_body(&self, key: &FieldKey, id: &str) -> Result<Option<BodyRead>, StoreError> {
        get(
            &self.conn,
            key,
            &self
                .path
                .parent()
                .unwrap_or(Path::new("."))
                .join("request_bodies"),
            id,
        )
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)] // Fixture setup/assertions only.
mod tests {
    use super::*;

    #[test]
    fn file_precedes_sql_and_file_failure_leaves_no_row() {
        let root = tempfile::tempdir().unwrap();
        let store = SqliteStore::open(root.path().join("omni.db"), 0).unwrap();
        let key = omni_crypto::field::derive_key("s2");
        let input = omni_ir::jsjson::parse_js(r#"{"requestId":"r","at":0,"client":{"request":null,"response":null},"attempts":[],"error":null}"#).unwrap();
        store.conn.execute_batch("CREATE TRIGGER refuse_body BEFORE INSERT ON request_bodies BEGIN SELECT RAISE(ABORT,'refused'); END;").unwrap();
        assert!(store.put_body(&key, &input).is_err());
        let path = root.path().join("request_bodies/1970/01/01/r.json.enc");
        assert!(path.is_file());
        assert!(store.get_body(&key, "r").unwrap().is_none());
        store
            .conn
            .execute_batch("DROP TRIGGER refuse_body")
            .unwrap();
        let blocked = root.path().join("blocked");
        std::fs::write(&blocked, "not a directory").unwrap();
        assert!(put(&store.conn, &key, &blocked, &input).is_err());
        assert!(store.get_body(&key, "r").unwrap().is_none());
    }

    #[test]
    fn null_path_unknown_state_and_oversized_file() {
        let root = tempfile::tempdir().unwrap();
        let store = SqliteStore::open(root.path().join("omni.db"), 0).unwrap();
        let key = omni_crypto::field::derive_key("s2");
        store
            .conn
            .execute(
                "INSERT INTO request_bodies(request_id,at,detail_state) VALUES ('r',0,'ready')",
                [],
            )
            .unwrap();
        let read = store.get_body(&key, "r").unwrap().unwrap();
        assert_eq!(read.row.detail_state, DetailState::Ready);
        assert!(read.artifact.is_none());
        store
            .conn
            .execute(
                "UPDATE request_bodies SET rel_path='r',detail_state='unknown',truncated=2",
                [],
            )
            .unwrap();
        let read = store.get_body(&key, "r").unwrap().unwrap();
        assert_eq!(read.row.detail_state, DetailState::None);
        assert!(!read.row.truncated);
        std::fs::create_dir(root.path().join("request_bodies")).unwrap();
        let file = std::fs::File::create(root.path().join("request_bodies/r")).unwrap();
        file.set_len(MAX_ENVELOPE_BYTES as u64 + 1).unwrap();
        store
            .conn
            .execute("UPDATE request_bodies SET detail_state='ready'", [])
            .unwrap();
        assert_eq!(
            store.get_body(&key, "r").unwrap().unwrap().row.detail_state,
            DetailState::Corrupt
        );
    }
}
