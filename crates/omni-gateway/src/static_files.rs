//! The dashboard catch-all (`app.ts`, `.get("/*")`) and the path handling it
//! and the router share with Bun.
//!
//! - [`normalize_path`] is `new URL(request.url).pathname` for the
//!   request-targets hyper accepts: dot segments (`.`, `..`, `%2e` forms)
//!   resolved, `\` read as `/`, and the WHATWG path percent-encode set
//!   applied (`"`, `{`, `}`, `^` and the rest; `%` sequences kept as sent).
//! - [`decode_uri_component`] is `decodeURIComponent`: `None` where JS throws.
//! - [`content_type`] is `Bun.file(path).type` for the frozen runtime (the
//!   generated `data/static-mime.tsv`), plus whether Bun's server attaches a
//!   `content-disposition: filename=` for that type.
//!
//! Serving reads the directory from disk per request, as `app.ts` does, on
//! the catch-all only. Implemented routes (`/v1/*` POSTs, `GET /v1/models`,
//! exact `/health`, `/metrics` when a token is set) are matched first and
//! never touch it. The catch-all refuses `/api` and `/v1` paths before any
//! filesystem work, as TS's two-prefix guard does; everything else is a
//! dashboard path, so `/metrics` with no token, `/metrics/x` and `/health/x`
//! are stat'ed under the root and can get the SPA index (TS parity, ruled).

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;

use bytes::Bytes;
use http_body_util::{BodyExt as _, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::HeaderValue;
use hyper::{Method, Request, Response, StatusCode};

use crate::server::{Body, full, not_found_get};

/// [`normalize_path`] without allocating when nothing would change: no dot
/// segment, escape, backslash or byte the path encode set rewrites.
pub fn pathname(path: &str) -> std::borrow::Cow<'_, str> {
    let plain = !path.bytes().any(|b| {
        matches!(
            b,
            b'.' | b'%' | b'\\' | b'"' | b'{' | b'}' | b'^' | b'?' | b'#' | b'<' | b'>' | b'`'
        ) || b <= 0x20
            || b >= 0x7f
    });
    if plain && path.starts_with('/') {
        std::borrow::Cow::Borrowed(path)
    } else {
        std::borrow::Cow::Owned(normalize_path(path))
    }
}

/// `new URL("http://h" + target).pathname`, for an origin-form target.
pub fn normalize_path(target: &str) -> String {
    let path = target.split(['?', '#']).next().unwrap_or("");
    let path = path.replace('\\', "/");
    let mut out: Vec<String> = Vec::new();
    let mut segments = path.split('/').skip(1).peekable();
    // A path always starts with an empty first segment (the leading `/`).
    while let Some(seg) = segments.next() {
        let last = segments.peek().is_none();
        let lower = seg.to_ascii_lowercase();
        let single = matches!(lower.as_str(), "." | "%2e");
        let double = matches!(lower.as_str(), ".." | ".%2e" | "%2e." | "%2e%2e");
        if double {
            out.pop();
            if last {
                out.push(String::new());
            }
        } else if single {
            if last {
                out.push(String::new());
            }
        } else {
            out.push(encode_segment(seg));
        }
    }
    let mut s = String::with_capacity(path.len() + 1);
    for seg in &out {
        s.push('/');
        s.push_str(seg);
    }
    if s.is_empty() {
        s.push('/');
    }
    s
}

/// The WHATWG path percent-encode set over one segment.
fn encode_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for b in seg.bytes() {
        let encode = b <= 0x20
            || b >= 0x7f
            || matches!(
                b,
                b'"' | b'#' | b'<' | b'>' | b'?' | b'`' | b'{' | b'}' | b'^'
            );
        if encode {
            out.push_str(&format!("%{b:02X}"));
        } else {
            out.push(char::from(b));
        }
    }
    out
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `decodeURIComponent(s)`, or `None` where it throws `URIError`: a `%` not
/// followed by two hex digits, or escapes that are not well-formed UTF-8
/// (overlong forms, surrogates and code points past U+10FFFF included).
pub fn decode_uri_component(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'%' {
            out.push(b[i]);
            i += 1;
            continue;
        }
        let byte = |at: usize| -> Option<u8> {
            if b.get(at) != Some(&b'%') {
                return None;
            }
            Some(hex(*b.get(at + 1)?)? << 4 | hex(*b.get(at + 2)?)?)
        };
        let first = byte(i)?;
        let len = match first {
            0x00..=0x7f => 1,
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => return None,
        };
        let mut seq = vec![first];
        for k in 1..len {
            seq.push(byte(i + 3 * k)?);
        }
        // `from_utf8` refuses overlongs, surrogates and > U+10FFFF, as JS does.
        std::str::from_utf8(&seq).ok()?;
        out.extend_from_slice(&seq);
        i += 3 * len;
    }
    String::from_utf8(out).ok()
}

struct Mime {
    unknown: &'static str,
    by_ext: HashMap<&'static str, &'static str>,
    disposition: HashMap<&'static str, bool>,
}

fn mime() -> &'static Mime {
    static TABLE: OnceLock<Mime> = OnceLock::new();
    TABLE.get_or_init(|| {
        let text: &'static str = include_str!("../data/static-mime.tsv");
        let mut m = Mime {
            unknown: "application/octet-stream",
            by_ext: HashMap::new(),
            disposition: HashMap::new(),
        };
        for line in text.lines().filter(|l| !l.starts_with('#')) {
            let f: Vec<&'static str> = line.split('\t').collect();
            match f.as_slice() {
                ["unknown", t] => m.unknown = t,
                ["type", t, d] => {
                    m.disposition.insert(t, *d == "1");
                }
                ["ext", e, t] => {
                    m.by_ext.insert(e, t);
                }
                _ => {}
            }
        }
        m
    })
}

/// `bun_paths::extension` without the dot: after the last `.` of the
/// basename, unless that dot starts the basename.
fn extension(path: &str) -> &str {
    let base = path.rsplit('/').next().unwrap_or(path);
    match base.rfind('.') {
        Some(dot) if dot > 0 => &base[dot + 1..],
        _ => "",
    }
}

/// `Bun.file(path).type`, and whether Bun adds `content-disposition:
/// filename="<basename>"` for a file answered with that type.
pub fn content_type(path: &str) -> (&'static str, bool) {
    let m = mime();
    let ext = extension(path).to_ascii_lowercase();
    let ty = m.by_ext.get(ext.as_str()).copied().unwrap_or(m.unknown);
    (ty, m.disposition.get(ty).copied().unwrap_or(true))
}

/// `realpath` of the configured directory, once at boot; `None` when it does
/// not resolve (an absent bundle answers every dashboard request 404).
pub fn resolve_root(dir: &str) -> Option<PathBuf> {
    let absolute = absolute(Path::new(dir));
    std::fs::canonicalize(absolute).ok()
}

/// `path.resolve` of one path against the working directory, lexically.
fn absolute(p: &Path) -> PathBuf {
    let joined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    };
    lexical(&joined)
}

fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(s) => out.push(s),
            _ => {}
        }
    }
    out
}

/// What the catch-all decided for a GET or HEAD.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// TS's `{"error":{"code":"NOT_FOUND",...}}` 404.
    NotFound,
    /// A regular file: its real path, cache-control, content type and
    /// whether Bun names it in `content-disposition`.
    File {
        path: PathBuf,
        cache_control: &'static str,
        content_type: &'static str,
        disposition: bool,
    },
    /// The path resolved to a directory: Bun's 500 (`EISDIR`).
    Directory,
}

/// The `/*` handler's decision, before any bytes are read.
///
/// `raw_path` is the request's pathname as `new URL` gives it (normalized),
/// `accept` the request's `accept` header.
pub fn decide(root: Option<&Path>, raw_path: &str, accept: Option<&str>) -> Decision {
    let Some(root) = root else {
        return Decision::NotFound;
    };
    let lower = raw_path.to_ascii_lowercase();
    if lower.contains("%2f") || lower.contains("%5c") {
        return Decision::NotFound;
    }
    let Some(decoded) = decode_uri_component(raw_path) else {
        return Decision::NotFound;
    };
    let protected = ["/api", "/v1"]
        .iter()
        .any(|p| decoded == *p || decoded.starts_with(&format!("{p}/")));
    if protected {
        return Decision::NotFound;
    }
    let requested = if decoded == "/" {
        "/index.html"
    } else {
        decoded.as_str()
    };
    // `resolve(staticRoot, "." + requested)`: lexical, never above `/`.
    let file_path = lexical(&root.join(format!(".{requested}")));
    if file_path != root && !file_path.starts_with(root) {
        return Decision::NotFound;
    }
    let real = std::fs::canonicalize(&file_path).ok();
    if let Some(real) = &real
        && real != root
        && !real.starts_with(root)
    {
        return Decision::NotFound;
    }
    // `Bun.file(real).size > 0`: a directory's size is its stat size, which
    // is never 0 on the filesystems served from, so it falls through to
    // serving and Bun answers 500.
    if let Some(real) = real {
        let meta = std::fs::metadata(&real).ok();
        let size = meta.as_ref().map_or(0, std::fs::Metadata::len);
        if size > 0 {
            if meta.is_some_and(|m| m.is_dir()) {
                return Decision::Directory;
            }
            let shown = real.to_string_lossy().into_owned();
            // `resolvedFilePath.endsWith(".html") ? "text/html" : file.type`.
            let (content_type, disposition) = if shown.ends_with(".html") {
                (
                    "text/html",
                    mime()
                        .disposition
                        .get("text/html")
                        .copied()
                        .unwrap_or(false),
                )
            } else {
                content_type(&shown)
            };
            return Decision::File {
                path: real,
                cache_control: if decoded.starts_with("/assets/") {
                    "public, max-age=31536000, immutable"
                } else {
                    "no-cache"
                },
                content_type,
                disposition,
            };
        }
    }
    let navigation = accept.is_some_and(|a| a.contains("text/html"));
    if decoded.starts_with("/assets/") || !navigation {
        return Decision::NotFound;
    }
    // **Security divergence from TS** (A2 review I1): `app.ts` serves
    // `resolve(staticRoot, "index.html")` without the realpath check every
    // other file gets, so an `index.html` linking outside the root is served
    // for any navigation route. Here it is canonicalized and contained like
    // a requested file; an escaping index answers 404, as TS answers a
    // request for `/index.html` itself.
    let Ok(index) = std::fs::canonicalize(root.join("index.html")) else {
        return Decision::NotFound;
    };
    if index == root || !index.starts_with(root) {
        return Decision::NotFound;
    }
    // `Bun.file(index).size`: 0 when missing.
    let size = std::fs::metadata(&index).map_or(0, |m| m.len());
    if size == 0 {
        return Decision::NotFound;
    }
    if std::fs::metadata(&index).is_ok_and(|m| m.is_dir()) {
        return Decision::Directory;
    }
    Decision::File {
        path: index,
        cache_control: "no-cache",
        content_type: "text/html",
        disposition: mime()
            .disposition
            .get("text/html")
            .copied()
            .unwrap_or(false),
    }
}

/// Bun's `Range: bytes=...` for a whole-file 200 (`RangeRequest.rs`):
/// one range only; multi-range and malformed headers serve the whole body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Range {
    None,
    /// Inclusive `start..=end`.
    Satisfiable(u64, u64),
    Unsatisfiable,
}

fn trim_sp(s: &[u8]) -> &[u8] {
    let start = s
        .iter()
        .position(|c| !matches!(c, b' ' | b'\t'))
        .unwrap_or(s.len());
    let end = s
        .iter()
        .rposition(|c| !matches!(c, b' ' | b'\t'))
        .map_or(start, |e| e + 1);
    &s[start..end.max(start)]
}

fn pos(s: &[u8]) -> Option<u64> {
    if s.is_empty() || !s.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(s).ok()?.parse().ok()
}

/// `RangeRequest::parse(header, total)`.
pub fn parse_range(header: &[u8], total: u64) -> Range {
    if header.len() < 5 || !header[..5].eq_ignore_ascii_case(b"bytes") {
        return Range::None;
    }
    let rest = trim_sp(&header[5..]);
    let Some(rest) = rest.strip_prefix(b"=") else {
        return Range::None;
    };
    if rest.contains(&b',') {
        return Range::None;
    }
    let Some(dash) = rest.iter().position(|c| *c == b'-') else {
        return Range::None;
    };
    let start_s = trim_sp(&rest[..dash]);
    let end_s = trim_sp(&rest[dash + 1..]);
    if start_s.is_empty() {
        let Some(n) = pos(end_s) else {
            return Range::None;
        };
        if n == 0 {
            return Range::Unsatisfiable;
        }
        if total == 0 {
            return Range::None;
        }
        return Range::Satisfiable(total.saturating_sub(n), total - 1);
    }
    let Some(start) = pos(start_s) else {
        return Range::None;
    };
    let end = if end_s.is_empty() {
        None
    } else {
        match pos(end_s) {
            Some(v) => Some(v),
            None => return Range::None,
        }
    };
    if start >= total {
        return Range::Unsatisfiable;
    }
    let end = end.unwrap_or(total - 1);
    if end < start {
        return Range::None;
    }
    Range::Satisfiable(start, end.min(total - 1))
}

// ------------------------------------------------------------ serving

const CHUNK: usize = 64 * 1024;

/// Bun's `content-disposition` value for a file, when it writes one: the
/// basename, cut to 992 bytes, refused if it holds CR, LF, NUL or `"`.
fn disposition_value(path: &Path) -> Option<HeaderValue> {
    use std::os::unix::ffi::OsStrExt as _;
    let base = path.file_name()?.as_bytes();
    let base = &base[..base.len().min(1024 - 32)];
    if base.is_empty() || base.iter().any(|b| matches!(b, b'\r' | b'\n' | 0 | b'"')) {
        return None;
    }
    let mut v = b"filename=\"".to_vec();
    v.extend_from_slice(base);
    v.push(b'"');
    HeaderValue::from_bytes(&v).ok()
}

/// A file body read on blocking threads, `len` bytes from `start`.
fn file_body(path: PathBuf, start: u64, len: u64) -> Body {
    let stream = async_stream::stream! {
        let opened = tokio::task::spawn_blocking(move || {
            use std::io::{Seek as _, SeekFrom};
            let mut f = std::fs::File::open(&path)?;
            f.seek(SeekFrom::Start(start))?;
            Ok::<_, std::io::Error>(f)
        })
        .await
        .map_err(std::io::Error::other)
        .and_then(|r| r);
        let mut file = match opened {
            Ok(f) => f,
            Err(e) => {
                yield Err(e);
                return;
            }
        };
        let mut left = len;
        while left > 0 {
            #[allow(clippy::cast_possible_truncation)]
            let want = left.min(CHUNK as u64) as usize;
            let read = tokio::task::spawn_blocking(move || {
                use std::io::Read as _;
                let mut buf = vec![0u8; want];
                let n = file.read(&mut buf)?;
                buf.truncate(n);
                Ok::<_, std::io::Error>((file, buf))
            })
            .await
            .map_err(std::io::Error::other)
            .and_then(|r| r);
            match read {
                Ok((f, buf)) if !buf.is_empty() => {
                    file = f;
                    left -= buf.len() as u64;
                    yield Ok(Frame::data(Bytes::from(buf)));
                }
                Ok(_) => {
                    yield Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof));
                    return;
                }
                Err(e) => {
                    yield Err(e);
                    return;
                }
            }
        }
    };
    StreamBody::new(stream).boxed_unsync()
}

/// Bun's answer for a file response that turned out to be a directory, in
/// production mode (`Cannot stream a directory as a response body`).
fn directory_error() -> Response<Body> {
    let mut res = Response::new(full("Something went wrong!"));
    *res.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
    res.headers_mut()
        .insert("content-type", HeaderValue::from_static("text/plain"));
    res
}

/// The `/*` catch-all for GET and HEAD: the dashboard bundle, the SPA
/// fallback, or TS's 404. `path` is the normalized pathname.
pub async fn serve(root: Option<&Path>, path: &str, req: &Request<Incoming>) -> Response<Body> {
    let Some(root) = root else {
        return not_found_get(path);
    };
    // `request.headers.get("accept")`: every value, joined with ", ".
    let accept = {
        let all: Vec<String> = req
            .headers()
            .get_all("accept")
            .iter()
            .map(|v| {
                v.as_bytes()
                    .iter()
                    .map(|&b| char::from(b))
                    .collect::<String>()
            })
            .map(|v| v.trim_matches(|c| matches!(c, ' ' | '\t')).to_owned())
            .collect();
        (!all.is_empty()).then(|| all.join(", "))
    };
    let range = req.headers().get("range").map(|v| v.as_bytes().to_vec());
    let if_range = req.headers().contains_key("if-range");
    let is_get = req.method() == Method::GET;
    let (root_owned, path_owned) = (root.to_path_buf(), path.to_owned());
    let decided = tokio::task::spawn_blocking(move || {
        let d = decide(Some(&root_owned), &path_owned, accept.as_deref());
        let size = match &d {
            Decision::File { path, .. } => std::fs::metadata(path).map_or(0, |m| m.len()),
            _ => 0,
        };
        (d, size)
    })
    .await;
    let Ok((decision, size)) = decided else {
        return directory_error();
    };
    match decision {
        Decision::NotFound => not_found_get(path),
        Decision::Directory => directory_error(),
        Decision::File {
            path: file,
            cache_control,
            content_type,
            disposition,
        } => {
            // Bun resolves `Range` for a whole-file GET; a request carrying
            // `If-Range` never matches (the response has no validators).
            let resolved = match (&range, is_get && !if_range) {
                (Some(h), true) => parse_range(h, size),
                _ => Range::None,
            };
            let (status, start, len) = match resolved {
                Range::None => (StatusCode::OK, 0, size),
                Range::Satisfiable(s, e) => (StatusCode::PARTIAL_CONTENT, s, e - s + 1),
                Range::Unsatisfiable => (StatusCode::RANGE_NOT_SATISFIABLE, 0, 0),
            };
            let body = if is_get && len > 0 {
                file_body(file.clone(), start, len)
            } else {
                full(Bytes::new())
            };
            let mut res = Response::new(body);
            *res.status_mut() = status;
            let h = res.headers_mut();
            h.insert("cache-control", HeaderValue::from_static(cache_control));
            h.insert("content-type", HeaderValue::from_static(content_type));
            // Bun names the file on a GET it streams; never on HEAD or 416.
            if disposition
                && is_get
                && status != StatusCode::RANGE_NOT_SATISFIABLE
                && let Some(v) = disposition_value(&file)
            {
                h.insert("content-disposition", v);
            }
            h.insert("content-length", HeaderValue::from(len));
            match resolved {
                Range::Satisfiable(s, e) => {
                    if let Ok(v) = HeaderValue::from_str(&format!("bytes {s}-{e}/{size}")) {
                        h.insert("content-range", v);
                    }
                    h.insert("accept-ranges", HeaderValue::from_static("bytes"));
                }
                Range::Unsatisfiable => {
                    if let Ok(v) = HeaderValue::from_str(&format!("bytes */{size}")) {
                        h.insert("content-range", v);
                    }
                    h.insert("accept-ranges", HeaderValue::from_static("bytes"));
                }
                Range::None => {}
            }
            res
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bun 1.4.4 answers, probed against the frozen TS binary.
    #[test]
    fn ranges_as_bun() {
        let cases: &[(&str, Range)] = &[
            ("bytes=0-0", Range::Satisfiable(0, 0)),
            ("bytes=1-", Range::Satisfiable(1, 2)),
            ("bytes=-1", Range::Satisfiable(2, 2)),
            ("bytes=5-10", Range::Unsatisfiable),
            ("bytes=0-0,2-2", Range::None),
            ("bytes=abc", Range::None),
            ("items=0-1", Range::None),
            ("bytes=2-1", Range::None),
            ("bytes=0-100", Range::Satisfiable(0, 2)),
            ("bytes=3-", Range::Unsatisfiable),
            ("bytes=-0", Range::Unsatisfiable),
            ("bytes=-5", Range::Satisfiable(0, 2)),
            ("bytes= 0-1", Range::Satisfiable(0, 1)),
            ("Bytes=0-1", Range::Satisfiable(0, 1)),
            ("bytes=0-1,", Range::None),
            ("bytes=0 -1", Range::Satisfiable(0, 1)),
            ("bytes=-", Range::None),
            ("bytes=", Range::None),
            ("bytes=00-01", Range::Satisfiable(0, 1)),
            ("bytes=+0-1", Range::None),
            ("bytes=0-1x", Range::None),
            ("bytes=0-18446744073709551616", Range::None),
            ("bytes =0-1", Range::Satisfiable(0, 1)),
            ("bytes=0x1-2", Range::None),
        ];
        for (h, want) in cases {
            assert_eq!(parse_range(h.as_bytes(), 3), *want, "{h}");
        }
    }
}
