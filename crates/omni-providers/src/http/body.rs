//! One request/response exchange on a connection, and the response body.

use std::future::Future;
use std::sync::Arc;

use bytes::{Buf, Bytes, BytesMut};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::pool::{Conn, Key, Pool};
use super::wire::RequestFacts;
use super::{HttpError, HttpResponse};

/// node's default `maxHeaderSize`.
const MAX_HEAD_BYTES: usize = 16 * 1024;
const MAX_HEADERS: usize = 128;
const READ_CHUNK: usize = 16 * 1024;
/// A chunk-size or trailer line longer than this is not HTTP.
const MAX_LINE: usize = 8 * 1024;

/// Response headers with node's `IncomingMessage.headers` merge rules, read
/// back through a fetch `Headers` (`get` is case-insensitive and joins with
/// `", "`). Order does not matter on the response side.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Headers {
    /// Lowercase name and value; `set-cookie` may repeat, nothing else does.
    entries: Vec<(String, String)>,
}

/// Headers whose duplicates node discards, keeping the first.
const SINGLE: [&str; 18] = [
    "age",
    "authorization",
    "content-length",
    "content-type",
    "etag",
    "expires",
    "from",
    "host",
    "if-modified-since",
    "if-unmodified-since",
    "last-modified",
    "location",
    "max-forwards",
    "proxy-authorization",
    "referer",
    "retry-after",
    "server",
    "user-agent",
];

impl Headers {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds one received header the way node's `_addHeaderLine` does.
    pub fn append_received(&mut self, name: &str, value: &str) {
        let lower = name.to_ascii_lowercase();
        if lower == "set-cookie" {
            self.entries.push((lower, value.to_string()));
            return;
        }
        match self.entries.iter_mut().find(|(n, _)| *n == lower) {
            None => self.entries.push((lower, value.to_string())),
            Some(_) if SINGLE.contains(&lower.as_str()) => {}
            Some((_, existing)) => {
                existing.push_str(if lower == "cookie" { "; " } else { ", " });
                existing.push_str(value);
            }
        }
    }

    /// `headers.get(name)`.
    pub fn get(&self, name: &str) -> Option<String> {
        let lower = name.to_ascii_lowercase();
        let mut found = self.entries.iter().filter(|(n, _)| *n == lower);
        let first = found.next()?.1.clone();
        Some(found.fold(first, |mut acc, (_, v)| {
            acc.push_str(", ");
            acc.push_str(v);
            acc
        }))
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries.iter().map(|(n, v)| (n.as_str(), v.as_str()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Framing {
    Length(u64),
    /// Expecting a `size[;ext]\r\n` line.
    ChunkSize,
    /// Inside a chunk with this many bytes left.
    ChunkData(u64),
    /// The `\r\n` after a chunk's data.
    ChunkEnd,
    /// After the zero chunk: trailer lines until an empty one.
    Trailers,
    /// Read until the server closes.
    Close,
    /// A body made of given chunks (`from_chunks`), for fakes and tests.
    Given,
    Done,
}

/// The response body, readable chunk by chunk without buffering the whole.
///
/// Holds the connection. Read to its clean end, the connection returns to the
/// pool; dropped earlier, or after an error, it is closed.
#[derive(Debug)]
pub struct ResponseBody {
    conn: Option<Conn>,
    given: std::collections::VecDeque<Bytes>,
    buf: BytesMut,
    framing: Framing,
    reusable: bool,
    pool: Option<(Arc<Pool>, Key)>,
}

impl ResponseBody {
    /// A body that is already complete, for tests and fakes.
    pub fn from_bytes(bytes: impl Into<Bytes>) -> Self {
        let bytes: Bytes = bytes.into();
        Self::from_chunks(vec![bytes])
    }

    /// A body yielding exactly these chunks, in order, for fakes and tests.
    pub fn from_chunks(chunks: Vec<Bytes>) -> Self {
        ResponseBody {
            conn: None,
            given: chunks.into_iter().filter(|c| !c.is_empty()).collect(),
            framing: Framing::Given,
            buf: BytesMut::new(),
            reusable: false,
            pool: None,
        }
    }

    /// Stops reading. If the rest of the body is already in hand — the
    /// terminating chunk of a stream the decoder ended at `[DONE]`, say — the
    /// connection still goes back to the pool; otherwise it is closed. Never
    /// waits for the network.
    pub fn finish_if_ready(mut self) {
        /// More than this unread, and the connection is not worth saving.
        const DRAIN_LIMIT: usize = 64 * 1024;
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        let mut drained = 0;
        loop {
            let poll = {
                let next = std::pin::pin!(self.next_chunk());
                next.poll(&mut cx)
            };
            match poll {
                std::task::Poll::Ready(Some(Ok(chunk))) => {
                    drained += chunk.len();
                    if drained > DRAIN_LIMIT {
                        return;
                    }
                }
                // Ended cleanly (and was released by `next_chunk`), failed, or
                // would wait: in the last two cases dropping `self` closes it.
                _ => return,
            }
        }
    }

    /// The next piece of the body; `None` at its end.
    pub async fn next_chunk(&mut self) -> Option<Result<Bytes, HttpError>> {
        match self.read_next().await {
            Ok(Some(bytes)) => Some(Ok(bytes)),
            Ok(None) => {
                self.release();
                None
            }
            Err(e) => {
                self.conn = None;
                self.framing = Framing::Done;
                Some(Err(e))
            }
        }
    }

    /// The whole body as text, decoded as UTF-8 with replacement
    /// (`Buffer.toString("utf8")`).
    pub async fn text(mut self) -> Result<String, HttpError> {
        const LIMIT: usize = 1024 * 1024;
        let overflow = || HttpError::InvalidResponse("error body exceeds 1048576 bytes".into());
        if matches!(self.framing, Framing::Length(n) if n > LIMIT as u64) {
            return Err(overflow());
        }
        let mut all = Vec::new();
        while let Some(chunk) = self.next_chunk().await {
            let chunk = chunk?;
            if chunk.len() > LIMIT - all.len() {
                return Err(overflow());
            }
            all.extend_from_slice(&chunk);
        }
        Ok(String::from_utf8_lossy(&all).into_owned())
    }

    /// Back to the pool only when the framing ended cleanly with nothing
    /// unread behind it; otherwise the connection is dropped, which closes it.
    fn release(&mut self) {
        let conn = self.conn.take();
        if let (Some(conn), Some((pool, key))) = (conn, self.pool.take())
            && self.reusable
            && self.buf.is_empty()
        {
            Pool::checkin_owned(&pool, key, conn);
        }
    }

    /// Reads more bytes into `buf`; `Ok(0)` at EOF.
    async fn fill(&mut self) -> Result<usize, HttpError> {
        let Some(conn) = self.conn.as_mut() else {
            return Ok(0);
        };
        self.buf.reserve(READ_CHUNK);
        Ok(conn.read_buf(&mut self.buf).await?)
    }

    /// Like [`fill`](Self::fill), but EOF mid-framing is a truncated body.
    async fn fill_or_abort(&mut self) -> Result<(), HttpError> {
        if self.fill().await? == 0 {
            return Err(HttpError::BodyAborted);
        }
        Ok(())
    }

    /// One `\r\n`-terminated line from the buffer, reading as needed.
    async fn line(&mut self) -> Result<Bytes, HttpError> {
        let mut from = 0;
        loop {
            if let Some(at) = self.buf[from..].windows(2).position(|w| w == b"\r\n") {
                let line = self.buf.split_to(from + at).freeze();
                self.buf.advance(2);
                return Ok(line);
            }
            if self.buf.len() > MAX_LINE {
                return Err(HttpError::InvalidResponse("chunk line too long".into()));
            }
            from = self.buf.len().saturating_sub(1);
            self.fill_or_abort().await?;
        }
    }

    async fn read_next(&mut self) -> Result<Option<Bytes>, HttpError> {
        loop {
            match self.framing {
                Framing::Done => return Ok(None),
                Framing::Length(0) => self.framing = Framing::Done,
                Framing::Length(left) => {
                    if self.buf.is_empty() {
                        self.fill_or_abort().await?;
                    }
                    let take = clamp(left, self.buf.len());
                    self.framing = Framing::Length(left - take as u64);
                    return Ok(Some(self.buf.split_to(take).freeze()));
                }
                Framing::Given => {
                    return Ok(self.given.pop_front().or_else(|| {
                        self.framing = Framing::Done;
                        None
                    }));
                }
                Framing::Close => {
                    if self.buf.is_empty() && self.fill().await? == 0 {
                        self.framing = Framing::Done;
                        return Ok(None);
                    }
                    return Ok(Some(self.buf.split().freeze()));
                }
                Framing::ChunkSize => {
                    let line = self.line().await?;
                    let size = parse_chunk_size(&line)?;
                    self.framing = if size == 0 {
                        Framing::Trailers
                    } else {
                        Framing::ChunkData(size)
                    };
                }
                Framing::ChunkData(left) => {
                    if self.buf.is_empty() {
                        self.fill_or_abort().await?;
                    }
                    let take = clamp(left, self.buf.len());
                    let rest = left - take as u64;
                    self.framing = if rest == 0 {
                        Framing::ChunkEnd
                    } else {
                        Framing::ChunkData(rest)
                    };
                    return Ok(Some(self.buf.split_to(take).freeze()));
                }
                Framing::ChunkEnd => {
                    if !self.line().await?.is_empty() {
                        return Err(HttpError::InvalidResponse("chunk not terminated".into()));
                    }
                    self.framing = Framing::ChunkSize;
                }
                Framing::Trailers => {
                    if self.line().await?.is_empty() {
                        self.framing = Framing::Done;
                    }
                }
            }
        }
    }
}

fn clamp(left: u64, available: usize) -> usize {
    usize::try_from(left).map_or(available, |l| l.min(available))
}

fn parse_chunk_size(line: &[u8]) -> Result<u64, HttpError> {
    let digits = line.split(|&b| b == b';').next().unwrap_or_default();
    let digits = std::str::from_utf8(digits)
        .map(|s| s.trim_matches(|c| c == ' ' || c == '\t'))
        .map_err(|_| HttpError::InvalidResponse("chunk size".into()))?;
    if digits.is_empty() || digits.len() > 16 {
        return Err(HttpError::InvalidResponse("chunk size".into()));
    }
    u64::from_str_radix(digits, 16).map_err(|_| HttpError::InvalidResponse("chunk size".into()))
}

/// Why an exchange failed.
///
/// **The replay rule.** A request is replayed — once, on a fresh connection —
/// only when it provably never left: the connection was a pooled one and the
/// very first write of the request was refused, so the kernel (or TLS layer)
/// accepted **zero** bytes of it. That is node's reused-socket "socket hang
/// up" before any write: the peer had already closed the idle socket. Once any
/// byte has been accepted — a prefix of a large body, or the whole request
/// with only the flush failing — the server may have started acting on it, so
/// the failure is surfaced unchanged (`is_network()`, so the adapter's
/// classification lets dispatch fail over before its commit point) and never
/// replayed here. A hang-up after the write is likewise surfaced, never
/// replayed.
pub(crate) enum Failure {
    /// A reused connection that accepted no byte of the request.
    Stale,
    Fatal(HttpError),
}

/// Writes the request and reads the response head.
///
/// `conn` is moved in and either ends up inside the returned body or is
/// dropped — closed — on every other path, including this future being
/// dropped mid-flight.
pub(crate) async fn roundtrip(
    mut conn: Conn,
    reused: bool,
    request: &[u8],
    facts: RequestFacts,
    pool: &Arc<Pool>,
    key: Key,
) -> Result<HttpResponse, Failure> {
    match write(&mut conn, request).await {
        Ok(()) => {}
        Err((0, _)) if reused => return Err(Failure::Stale),
        Err((_, e)) => return Err(Failure::Fatal(HttpError::Io(e))),
    }
    let mut buf = BytesMut::with_capacity(READ_CHUNK);
    loop {
        // The cap applies to what has been read before a parse (an
        // unterminated head) and to a parsed head's own length (a complete
        // one whose terminating CRLF arrived in the read that crossed it).
        if buf.len() > MAX_HEAD_BYTES && find_head_end(&buf).is_none_or(|end| end > MAX_HEAD_BYTES)
        {
            return Err(overflow());
        }
        let parsed = parse_head(&buf).map_err(Failure::Fatal)?;
        if let Some(head) = parsed {
            if head.len > MAX_HEAD_BYTES {
                return Err(overflow());
            }
            // 1xx (other than 101) are interim; node skips them.
            if (100..200).contains(&head.status) && head.status != 101 {
                buf.advance(head.len);
                continue;
            }
            buf.advance(head.len);
            return Ok(finish_head(head, conn, buf, facts, pool, key));
        }
        buf.reserve(READ_CHUNK);
        match conn.read_buf(&mut buf).await {
            // Not retried, even on a reused socket: the request went out and
            // the server may have acted on it. node reports "socket hang up"
            // here too, and dispatch decides (NETWORK is retryable).
            Ok(0) => return Err(Failure::Fatal(HttpError::ConnectionClosed)),
            Ok(_) => {}
            Err(e) => return Err(Failure::Fatal(HttpError::Io(e))),
        }
    }
}

fn overflow() -> Failure {
    Failure::Fatal(HttpError::InvalidResponse("header overflow".into()))
}

/// Where the first head in `buf` ends (after its blank line), if it has.
fn find_head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|at| at + 4)
}

/// Writes the whole request. On failure, how many bytes the connection had
/// accepted before it: zero is the only count [`Failure::Stale`] allows.
async fn write(conn: &mut Conn, request: &[u8]) -> Result<(), (usize, std::io::Error)> {
    let mut written = 0;
    while written < request.len() {
        match conn.write(&request[written..]).await {
            Ok(0) => {
                return Err((written, std::io::ErrorKind::WriteZero.into()));
            }
            Ok(n) => written += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err((written, e)),
        }
    }
    // A flush failure comes after every byte was accepted: never replayable.
    conn.flush().await.map_err(|e| (written.max(1), e))
}

struct Head {
    status: u16,
    len: usize,
    headers: Headers,
    /// HTTP/1.0 response: not kept alive unless it says so.
    http10: bool,
    connection: Option<String>,
    chunked: bool,
    content_length: Option<u64>,
}

fn parse_head(buf: &[u8]) -> Result<Option<Head>, HttpError> {
    let mut storage = [httparse::EMPTY_HEADER; MAX_HEADERS];
    let mut res = httparse::Response::new(&mut storage);
    let len = match res.parse(buf) {
        Ok(httparse::Status::Complete(len)) => len,
        Ok(httparse::Status::Partial) => return Ok(None),
        Err(e) => return Err(HttpError::InvalidResponse(e.to_string())),
    };
    let status = res.code.unwrap_or(0);
    let mut headers = Headers::new();
    let mut connection = None;
    let mut chunked = false;
    let mut content_length = None;
    for h in res.headers.iter() {
        // node decodes header bytes as latin1.
        let value: String = h.value.iter().map(|&b| char::from(b)).collect();
        let value = value.trim_matches(|c| c == ' ' || c == '\t');
        if h.name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value
                .rsplit(',')
                .next()
                .is_some_and(|last| last.trim().eq_ignore_ascii_case("chunked"));
        } else if h.name.eq_ignore_ascii_case("content-length") {
            let parsed = value
                .parse::<u64>()
                .map_err(|_| HttpError::InvalidResponse("content-length".into()))?;
            if content_length.is_some_and(|prev| prev != parsed) {
                return Err(HttpError::InvalidResponse(
                    "conflicting content-length".into(),
                ));
            }
            content_length = Some(parsed);
        } else if h.name.eq_ignore_ascii_case("connection") {
            connection = Some(value.to_ascii_lowercase());
        }
        headers.append_received(h.name, value);
    }
    Ok(Some(Head {
        status,
        len,
        headers,
        http10: res.version == Some(0),
        connection,
        chunked,
        content_length,
    }))
}

fn finish_head(
    head: Head,
    conn: Conn,
    buf: BytesMut,
    facts: RequestFacts,
    pool: &Arc<Pool>,
    key: Key,
) -> HttpResponse {
    let no_body = facts.head || head.status == 204 || head.status == 304;
    let framing = if no_body {
        Framing::Done
    } else if head.chunked {
        Framing::ChunkSize
    } else if let Some(length) = head.content_length {
        Framing::Length(length)
    } else {
        Framing::Close
    };
    let server_close = head
        .connection
        .as_deref()
        .is_some_and(|c| c.split(',').any(|t| t.trim() == "close"));
    let server_keep = head
        .connection
        .as_deref()
        .is_some_and(|c| c.split(',').any(|t| t.trim() == "keep-alive"));
    let reusable =
        !facts.close && !server_close && (!head.http10 || server_keep) && framing != Framing::Close;
    let mut body = ResponseBody {
        conn: Some(conn),
        given: std::collections::VecDeque::new(),
        buf,
        framing,
        reusable,
        pool: Some((pool.clone(), key)),
    };
    if framing == Framing::Done {
        body.release();
    }
    HttpResponse {
        status: head.status,
        headers: head.headers,
        body,
    }
}
