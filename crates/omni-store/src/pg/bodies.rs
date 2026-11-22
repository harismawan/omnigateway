//! Body artifacts on Postgres: the
//! same encrypted envelope the SQLite store writes to a file, in a `bytea`
//! column beside its row.
//!
//! The envelope: `OGBA`, version 1, codec, the claimed
//! plaintext length (u32 BE) — ten bytes that are also the GCM additional
//! data — then a 12-byte IV and the AES-256-GCM ciphertext with its 16-byte
//! tag, under the credential field key. Codec 0 (raw) is written; codec 1
//! (gzip) and the legacy `enc:v1:` hex text are read. `sha256` is over the
//! whole stored envelope, so truncation is detectable without the key.
//!
//! [`PgStore::put_body_artifact`] masks/bounds before persistence; the lower
//! level [`PgStore::put_body`] accepts already prepared JSON for cross-reading.

use super::PgStore;
use crate::error::StoreError;
use aes_gcm::aead::{Aead as _, KeyInit as _, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use omni_crypto::field::FieldKey;
use rand::Rng as _;
use sha2::{Digest as _, Sha256};

/// `MAX_ARTIFACT_BYTES`.
pub const MAX_ARTIFACT_BYTES: usize = 512 * 1024;
/// `MAX_ENVELOPE_BYTES`: a legacy envelope around one full budget.
pub const MAX_ENVELOPE_BYTES: usize = 2 * MAX_ARTIFACT_BYTES + 65;
const MAGIC: &[u8; 4] = b"OGBA";
const VERSION: u8 = 1;
const HEADER: usize = 10;
const IV: usize = 12;
const TAG: usize = 16;
const OVERHEAD: usize = HEADER + IV + TAG;
const CODEC_RAW: u8 = 0;
const CODEC_GZIP: u8 = 1;
const GZIP_FRAME_BYTES: usize = 18;

/// The recorded state of a stored body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetailState {
    None,
    Ready,
    Missing,
    Corrupt,
}

impl DetailState {
    /// Anything unrecognised reads as `none`.
    pub fn parse(s: &str) -> Self {
        match s {
            "ready" => Self::Ready,
            "missing" => Self::Missing,
            "corrupt" => Self::Corrupt,
            _ => Self::None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Ready => "ready",
            Self::Missing => "missing",
            Self::Corrupt => "corrupt",
        }
    }
}

/// One stored body's metadata row.
#[derive(Debug, Clone, PartialEq)]
pub struct BodyRow {
    pub request_id: String,
    pub at: i64,
    pub rel_path: Option<String>,
    pub size_bytes: i64,
    pub sha256: Option<String>,
    pub detail_state: DetailState,
    pub truncated: bool,
}

/// The row, and the artifact when it read back.
#[derive(Debug, Clone, PartialEq)]
pub struct BodyRead {
    pub row: BodyReadRow,
    pub artifact: Option<omni_ir::jsjson::JsValue>,
}

/// Read-side metadata has JavaScript values, not the writer's integer contract.
#[derive(Debug, Clone, PartialEq)]
pub struct BodyReadRow {
    pub request_id: omni_ir::jsjson::JsValue,
    pub at: omni_ir::jsjson::JsValue,
    pub rel_path: Option<String>,
    pub size_bytes: omni_ir::jsjson::JsValue,
    pub sha256: Option<String>,
    pub detail_state: DetailState,
    pub truncated: bool,
}
impl From<BodyRow> for BodyReadRow {
    fn from(row: BodyRow) -> Self {
        use omni_ir::jsjson::JsValue;
        Self {
            request_id: JsValue::String(row.request_id.encode_utf16().collect()),
            at: JsValue::Number(row.at as f64),
            rel_path: row.rel_path,
            size_bytes: JsValue::Number(row.size_bytes as f64),
            sha256: row.sha256,
            detail_state: row.detail_state,
            truncated: row.truncated,
        }
    }
}

/// The sealed envelope and its digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sealed {
    pub bytes: Vec<u8>,
    pub sha256: String,
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            write!(s, "{b:02x}").ok();
            s
        })
}

fn cipher(key: &FieldKey) -> Aes256Gcm {
    Aes256Gcm::new(key.bytes().into())
}

/// The binary envelope, codec raw.
pub fn seal(key: &FieldKey, json: &str) -> Result<Sealed, StoreError> {
    let plain = json.as_bytes();
    if plain.is_empty() || plain.len() > MAX_ARTIFACT_BYTES {
        return Err(StoreError::Corrupt(
            "artifact plaintext is outside the binary envelope's bounds".into(),
        ));
    }
    let claimed = u32::try_from(plain.len()).expect("bounded above");
    let mut header = [0u8; HEADER];
    header[..4].copy_from_slice(MAGIC);
    header[4] = VERSION;
    header[5] = CODEC_RAW;
    header[6..].copy_from_slice(&claimed.to_be_bytes());
    let mut iv = [0u8; IV];
    rand::rng().fill_bytes(&mut iv);
    let sealed = cipher(key)
        .encrypt(
            &Nonce::from(iv),
            Payload {
                msg: plain,
                aad: &header,
            },
        )
        .map_err(|_| StoreError::Corrupt("artifact encryption failed".into()))?;
    let mut bytes = Vec::with_capacity(OVERHEAD + plain.len());
    bytes.extend_from_slice(&header);
    bytes.extend_from_slice(&iv);
    bytes.extend_from_slice(&sealed);
    let sha256 = hex(&Sha256::digest(&bytes));
    Ok(Sealed { bytes, sha256 })
}

/// `YYYY/MM/DD/<requestId>.json.enc`, in UTC.
pub fn rel_path_for(request_id: &str, at: i64) -> String {
    let days = at.div_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}/{m:02}/{d:02}/{request_id}.json.enc")
}

/// Howard Hinnant's `civil_from_days`.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = u32::try_from(doy - (153 * mp + 2) / 5 + 1).unwrap_or(1);
    let m = u32::try_from(if mp < 10 { mp + 3 } else { mp - 9 }).unwrap_or(1);
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 1..=128 bytes of ASCII alphanumerics, `_` or `-`.
pub fn is_safe_request_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn gunzip(payload: &[u8], claimed: usize) -> Option<Vec<u8>> {
    use std::io::Read as _;
    // Concatenated members decode as one stream; a zero byte after a member
    // is padding to zlib, which `consumed` then stops short of.
    let mut decoder = flate2::bufread::MultiGzDecoder::new(payload);
    let mut out = Vec::new();
    (&mut decoder)
        .take(u64::try_from(MAX_ARTIFACT_BYTES).ok()? + 1)
        .read_to_end(&mut out)
        .ok()?;
    if out.len() > MAX_ARTIFACT_BYTES || out.len() != claimed {
        return None;
    }
    let rest = decoder.into_inner();
    rest.is_empty().then_some(out)
}

/// Format, bounds, digest, decryption, then the object
/// check. Every failure is `corrupt`.
pub fn decode(
    key: &FieldKey,
    bytes: &[u8],
    expected_sha256: Option<&str>,
) -> Option<omni_ir::jsjson::JsValue> {
    let plain = decode_plaintext(key, bytes, expected_sha256)?;
    match omni_ir::jsjson::parse_js(plain.strip_prefix('\u{feff}').unwrap_or(&plain)).ok()? {
        v @ omni_ir::jsjson::JsValue::Object(_) => Some(v),
        _ => None,
    }
}

/// Authenticated, bounded plaintext, before JSON.parse. Exposed for byte-exact
/// cross-reader verification; client reads must use `decode`'s object check.
pub fn decode_plaintext(
    key: &FieldKey,
    bytes: &[u8],
    expected_sha256: Option<&str>,
) -> Option<String> {
    if bytes.len() > MAX_ENVELOPE_BYTES {
        return None;
    }
    let digest_ok = || expected_sha256.is_none_or(|want| hex(&Sha256::digest(bytes)) == want);
    let plain: String = if bytes.starts_with(MAGIC) {
        if bytes.len() < OVERHEAD || bytes.len() > MAX_ARTIFACT_BYTES + OVERHEAD {
            return None;
        }
        let (version, codec) = (bytes[4], bytes[5]);
        let claimed = u32::from_be_bytes([bytes[6], bytes[7], bytes[8], bytes[9]]) as usize;
        if version != VERSION || !(1..=MAX_ARTIFACT_BYTES).contains(&claimed) {
            return None;
        }
        let payload_len = bytes.len() - OVERHEAD;
        let fits = match codec {
            CODEC_RAW => payload_len == claimed,
            CODEC_GZIP => payload_len >= GZIP_FRAME_BYTES,
            _ => false,
        };
        if !fits || !digest_ok() {
            return None;
        }
        let nonce = Nonce::try_from(&bytes[HEADER..HEADER + IV]).ok()?;
        let opened = cipher(key)
            .decrypt(
                &nonce,
                Payload {
                    msg: &bytes[HEADER + IV..],
                    aad: &bytes[..HEADER],
                },
            )
            .ok()?;
        let expanded = if codec == CODEC_GZIP {
            gunzip(&opened, claimed)?
        } else {
            opened
        };
        String::from_utf8(expanded).ok()?
    } else if bytes.starts_with(b"enc:v1:") {
        let text = std::str::from_utf8(bytes).ok()?;
        if !legacy_shape(text) || !digest_ok() {
            return None;
        }
        omni_crypto::field::decrypt(key, text).ok()?
    } else {
        return None;
    };
    Some(plain)
}

/// Whether the text is the legacy `enc:` secret shape.
fn legacy_shape(text: &str) -> bool {
    let parts: Vec<&str> = text.split(':').collect();
    let lower_hex = |s: &str| {
        s.len().is_multiple_of(2)
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    parts.len() == 5
        && parts[0] == "enc"
        && parts[1] == "v1"
        && parts[2].len() == 24
        && parts[4].len() == 32
        && lower_hex(parts[2])
        && lower_hex(parts[3])
        && lower_hex(parts[4])
}

const META: &str = "request_id, at, rel_path, size_bytes, sha256, detail_state, truncated";

fn to_row(r: &tokio_postgres::Row) -> Result<BodyRow, StoreError> {
    Ok(BodyRow {
        request_id: r.try_get("request_id")?,
        at: r.try_get("at")?,
        rel_path: r.try_get("rel_path")?,
        size_bytes: r.try_get("size_bytes")?,
        sha256: r.try_get("sha256")?,
        detail_state: DetailState::parse(r.try_get("detail_state")?),
        truncated: r.try_get("truncated")?,
    })
}

impl PgStore {
    /// Full artifact put: preparation is shared with SQLite; bytes and row are
    /// committed together on PG rather than file-before-row.
    pub async fn put_body_artifact(
        &self,
        key: &FieldKey,
        input: &omni_ir::jsjson::JsValue,
    ) -> Result<BodyRow, StoreError> {
        let (id, at, json, truncated) = crate::bodies::prepare_put(input)?;
        self.put_body(key, &id, at, &json, truncated).await
    }
    /// Put for an artifact already prepared: seal `json`, and
    /// upsert its row and bytes in one statement.
    pub async fn put_body(
        &self,
        key: &FieldKey,
        request_id: &str,
        at: i64,
        json: &str,
        truncated: bool,
    ) -> Result<BodyRow, StoreError> {
        if !is_safe_request_id(request_id) {
            return Err(StoreError::Corrupt(
                "request id is not safe to use as an artifact path segment".into(),
            ));
        }
        let sealed = seal(key, json)?;
        let row = BodyRow {
            request_id: request_id.to_owned(),
            at,
            rel_path: Some(rel_path_for(request_id, at)),
            size_bytes: i64::try_from(sealed.bytes.len()).unwrap_or(i64::MAX),
            sha256: Some(sealed.sha256),
            detail_state: DetailState::Ready,
            truncated,
        };
        let c = self.client().await?;
        let stmt = c
            .prepare_cached(
                "INSERT INTO request_bodies
                   (request_id, at, rel_path, size_bytes, sha256, detail_state, truncated, bytes)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                 ON CONFLICT (request_id) DO UPDATE SET
                   at = EXCLUDED.at,
                   rel_path = EXCLUDED.rel_path,
                   size_bytes = EXCLUDED.size_bytes,
                   sha256 = EXCLUDED.sha256,
                   detail_state = EXCLUDED.detail_state,
                   truncated = EXCLUDED.truncated,
                   bytes = EXCLUDED.bytes",
            )
            .await?;
        c.execute(
            &stmt,
            &[
                &row.request_id,
                &row.at,
                &row.rel_path,
                &row.size_bytes,
                &row.sha256,
                &row.detail_state.as_str(),
                &row.truncated,
                &sealed.bytes,
            ],
        )
        .await?;
        Ok(row)
    }

    /// Bytes over the ceiling never leave the server; a
    /// state that changed on reading is recorded.
    pub async fn get_body(
        &self,
        key: &FieldKey,
        request_id: &str,
    ) -> Result<Option<BodyRead>, StoreError> {
        let c = self.client().await?;
        let ceiling = i32::try_from(MAX_ENVELOPE_BYTES).unwrap_or(i32::MAX);
        let stmt = c
            .prepare_cached(&format!(
                "SELECT {META},
                   CASE WHEN octet_length(bytes) <= $2 THEN bytes ELSE NULL END AS bytes,
                   octet_length(bytes) AS encoded_size
                 FROM request_bodies WHERE request_id = $1"
            ))
            .await?;
        let Some(found) = c.query_opt(&stmt, &[&request_id, &ceiling]).await? else {
            return Ok(None);
        };
        let row: BodyReadRow = to_row(&found)?.into();
        if row.rel_path.is_none() || row.detail_state == DetailState::None {
            return Ok(Some(BodyRead {
                row,
                artifact: None,
            }));
        }
        let size: Option<i32> = found.try_get("encoded_size")?;
        let bytes: Option<Vec<u8>> = found.try_get("bytes")?;
        let read = match (size, bytes) {
            (None, _) => Err(DetailState::Missing),
            (Some(_), None) => Err(DetailState::Corrupt),
            (Some(_), Some(b)) => {
                decode(key, &b, row.sha256.as_deref()).ok_or(DetailState::Corrupt)
            }
        };
        let record = |state: DetailState| async move {
            let stmt = c
                .prepare_cached("UPDATE request_bodies SET detail_state = $1 WHERE request_id = $2")
                .await?;
            c.execute(&stmt, &[&state.as_str(), &request_id]).await?;
            Ok::<(), StoreError>(())
        };
        Ok(Some(match read {
            Ok(artifact) => {
                if row.detail_state != DetailState::Ready {
                    record(DetailState::Ready).await?;
                }
                BodyRead {
                    row: BodyReadRow {
                        detail_state: DetailState::Ready,
                        ..row
                    },
                    artifact: Some(artifact),
                }
            }
            Err(state) => {
                record(state).await?;
                BodyRead {
                    row: BodyReadRow {
                        detail_state: state,
                        ..row
                    },
                    artifact: None,
                }
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typed_pg_metadata_projects_as_js_numbers() {
        use omni_ir::jsjson::JsValue;
        let row: BodyReadRow = BodyRow {
            request_id: "r".into(),
            at: 9_007_199_254_740_993,
            rel_path: None,
            size_bytes: 9_007_199_254_740_993,
            sha256: None,
            detail_state: DetailState::Ready,
            truncated: true,
        }
        .into();
        assert_eq!(row.at, JsValue::Number(9_007_199_254_740_992.0));
        assert_eq!(row.size_bytes, row.at);
        assert!(row.truncated);
        assert_eq!(row.request_id, JsValue::String(vec![114]));
    }

    #[test]
    #[allow(clippy::unwrap_used)] // Fixture setup/assertions only.
    fn full_put_prepares_before_sealing_for_both_engines() {
        let input=omni_ir::jsjson::parse_js(r#"{"requestId":"r","at":0,"client":{"request":"Bearer secret","response":null},"attempts":[],"error":null}"#).unwrap();
        let (id, at, json, truncated) = crate::bodies::prepare_put(&input).unwrap();
        assert_eq!((id.as_str(), at, truncated), ("r", 0, false));
        assert!(json.contains("Bearer [redacted]"));
        let key = omni_crypto::field::derive_key("s2");
        let sealed = seal(&key, &json).unwrap();
        assert_eq!(
            decode(&key, &sealed.bytes, None),
            Some(omni_ir::jsjson::parse_js(&json).unwrap())
        );
    }

    #[test]
    fn rel_paths_are_utc_dates() {
        assert_eq!(
            rel_path_for("req_a", 1_794_007_800_000),
            "2026/11/06/req_a.json.enc"
        );
        assert_eq!(rel_path_for("r", 0), "1970/01/01/r.json.enc");
        assert_eq!(rel_path_for("r", -1), "1969/12/31/r.json.enc");
        assert_eq!(rel_path_for("r", 951_782_400_000), "2000/02/29/r.json.enc");
    }

    #[test]
    fn a_sealed_envelope_opens_and_a_flipped_byte_does_not() {
        let key = omni_crypto::field::derive_key("k");
        let s = seal(&key, r#"{"a":1}"#).expect("seal");
        assert_eq!(&s.bytes[..4], b"OGBA");
        assert_eq!(s.bytes.len(), OVERHEAD + 7);
        assert_eq!(
            decode(&key, &s.bytes, Some(&s.sha256)),
            Some(omni_ir::jsjson::parse_js(r#"{"a":1}"#).expect("JSON"))
        );
        let mut bad = s.bytes.clone();
        bad[OVERHEAD] ^= 1;
        assert_eq!(decode(&key, &bad, None), None);
        assert_eq!(decode(&key, &s.bytes, Some("00")), None);
        assert!(seal(&key, "").is_err());
        assert!(is_safe_request_id("req_abc-1") && !is_safe_request_id("../x"));
    }
}
