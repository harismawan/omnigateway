//! A bound on what the server may send, enforced on the socket *below* the
//! `redis` crate's decoder.
//!
//! The crate decodes replies (incrementally, with partial state; values are
//! built by it, not here). What it does not do is bound them: a header line
//! with no CRLF is buffered forever, an array may declare 2^63 elements,
//! nesting is capped only at depth 100, and `$-2` / `*-2` are read as nil.
//! [`Guarded`] wraps the socket's read half and runs every byte the crate
//! will see through [`Framer`], a single-pass RESP2 *framing* state machine
//! (lengths and nesting only — it builds no values). The first violation
//! fails the read with an error, which the crate treats as a dead connection:
//! its pending requests fail and the link replaces the connection.
//!
//! Bounds (`Limits`): one header line, one reply's total bytes, one reply's
//! element count, nesting depth, and declared lengths (`-1` or `0..=max`).
//! Each byte is examined once: the state is a small stack, never a re-parse.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// Per-reply limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Limits {
    /// Bytes in one reply, framing included.
    pub(crate) reply_bytes: usize,
    /// Elements (scalars and aggregates) in one reply.
    pub(crate) reply_nodes: usize,
    /// Nesting depth of one reply.
    pub(crate) depth: usize,
    /// Bytes in one header line (`+…`, `-…`, `:…`, `$n`, `*n`).
    pub(crate) line: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    /// Expecting a type byte.
    Type,
    /// Inside a header line of `kind`; `len` bytes so far.
    Line { kind: u8, len: usize, cr: bool },
    /// Inside a bulk body: `left` bytes then CRLF.
    Body { left: usize },
    /// The CRLF after a bulk body; `got` of 2 so far.
    BodyEnd { got: u8 },
}

/// A single-pass RESP2 framing checker. Feed it every byte the decoder
/// will see, in order.
#[derive(Debug)]
pub(crate) struct Framer {
    limits: Limits,
    step: Step,
    /// Elements still owed by each open array, innermost last.
    open: Vec<u64>,
    /// The header line's numeric part, while in a `$`/`*` line.
    number: Vec<u8>,
    reply_bytes: usize,
    reply_nodes: usize,
}

/// Why a reply was refused. Its text is the crate-facing I/O error message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Violation {
    LineTooLong,
    ReplyTooLarge,
    TooManyElements,
    TooDeep,
    BadLength,
    BadType,
    BadFraming,
}

impl Violation {
    fn text(self) -> &'static str {
        match self {
            Self::LineTooLong => "reply header line too long",
            Self::ReplyTooLarge => "reply too large",
            Self::TooManyElements => "reply has too many elements",
            Self::TooDeep => "reply nested too deeply",
            Self::BadLength => "invalid reply length",
            Self::BadType => "invalid reply type",
            Self::BadFraming => "invalid reply framing",
        }
    }
}

impl Framer {
    pub(crate) fn new(limits: Limits) -> Self {
        Self {
            limits,
            step: Step::Type,
            open: Vec::new(),
            number: Vec::new(),
            reply_bytes: 0,
            reply_nodes: 0,
        }
    }

    /// Checks `bytes`, the next ones on the stream.
    pub(crate) fn feed(&mut self, bytes: &[u8]) -> Result<(), Violation> {
        let mut i = 0;
        while i < bytes.len() {
            // A bulk body is skipped in one step, not byte by byte.
            if let Step::Body { left } = self.step {
                let take = left.min(bytes.len() - i);
                self.count_bytes(take)?;
                i += take;
                self.step = if take == left {
                    Step::BodyEnd { got: 0 }
                } else {
                    Step::Body { left: left - take }
                };
                continue;
            }
            let b = bytes[i];
            i += 1;
            self.count_bytes(1)?;
            self.byte(b)?;
        }
        Ok(())
    }

    fn count_bytes(&mut self, n: usize) -> Result<(), Violation> {
        self.reply_bytes = self.reply_bytes.saturating_add(n);
        if self.reply_bytes > self.limits.reply_bytes {
            return Err(Violation::ReplyTooLarge);
        }
        Ok(())
    }

    fn byte(&mut self, b: u8) -> Result<(), Violation> {
        match self.step {
            Step::Type => {
                if !matches!(b, b'+' | b'-' | b':' | b'$' | b'*') {
                    return Err(Violation::BadType);
                }
                self.reply_nodes += 1;
                if self.reply_nodes > self.limits.reply_nodes {
                    return Err(Violation::TooManyElements);
                }
                self.number.clear();
                self.step = Step::Line {
                    kind: b,
                    len: 0,
                    cr: false,
                };
            }
            Step::Line { kind, len, cr } => {
                if cr {
                    if b != b'\n' {
                        return Err(Violation::BadFraming);
                    }
                    return self.line_done(kind);
                }
                if b == b'\r' {
                    self.step = Step::Line {
                        kind,
                        len,
                        cr: true,
                    };
                    return Ok(());
                }
                if len + 1 > self.limits.line {
                    return Err(Violation::LineTooLong);
                }
                if matches!(kind, b'$' | b'*' | b':') {
                    self.number.push(b);
                }
                self.step = Step::Line {
                    kind,
                    len: len + 1,
                    cr: false,
                };
            }
            Step::BodyEnd { got } => {
                let want = if got == 0 { b'\r' } else { b'\n' };
                if b != want {
                    return Err(Violation::BadFraming);
                }
                if got == 0 {
                    self.step = Step::BodyEnd { got: 1 };
                } else {
                    self.value_done();
                }
            }
            Step::Body { .. } => return Err(Violation::BadFraming),
        }
        Ok(())
    }

    /// A header line ended. `$n` opens a body, `*n` an array; the rest are
    /// complete values.
    fn line_done(&mut self, kind: u8) -> Result<(), Violation> {
        match kind {
            b':' => {
                parse_int(&self.number).ok_or(Violation::BadLength)?;
                self.value_done();
            }
            b'$' => match parse_int(&self.number) {
                Some(-1) => self.value_done(),
                Some(n) if n >= 0 => {
                    let n = usize::try_from(n).map_err(|_| Violation::BadLength)?;
                    if n > self.limits.reply_bytes {
                        return Err(Violation::ReplyTooLarge);
                    }
                    self.step = if n == 0 {
                        Step::BodyEnd { got: 0 }
                    } else {
                        Step::Body { left: n }
                    };
                }
                _ => return Err(Violation::BadLength),
            },
            b'*' => match parse_int(&self.number) {
                Some(-1) | Some(0) => self.value_done(),
                Some(n) if n > 0 => {
                    let n = u64::try_from(n).map_err(|_| Violation::BadLength)?;
                    // Every element is at least one node: refuse a
                    // declaration the node budget could never cover.
                    let budget = self.limits.reply_nodes.saturating_sub(self.reply_nodes) as u64;
                    if n > budget {
                        return Err(Violation::TooManyElements);
                    }
                    if self.open.len() + 1 > self.limits.depth {
                        return Err(Violation::TooDeep);
                    }
                    self.open.push(n);
                    self.step = Step::Type;
                }
                _ => return Err(Violation::BadLength),
            },
            _ => self.value_done(),
        }
        Ok(())
    }

    /// A value ended: it counts toward its array; a closed array is itself a
    /// value of the one around it; at the top a reply ends.
    fn value_done(&mut self) {
        self.step = Step::Type;
        while let Some(left) = self.open.last_mut() {
            *left -= 1;
            if *left > 0 {
                return;
            }
            self.open.pop();
        }
        self.reply_bytes = 0;
        self.reply_nodes = 0;
    }
}

/// A strict RESP2 integer: optional `-`, digits, fits i64.
fn parse_int(digits: &[u8]) -> Option<i64> {
    let s = std::str::from_utf8(digits).ok()?;
    let body = s.strip_prefix('-').unwrap_or(s);
    if body.is_empty() || !body.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

/// A stream whose reads pass through a [`Framer`].
pub(crate) struct Guarded<S> {
    inner: S,
    framer: Framer,
    failed: Option<Violation>,
}

impl<S> Guarded<S> {
    pub(crate) fn new(inner: S, limits: Limits) -> Self {
        Self {
            inner,
            framer: Framer::new(limits),
            failed: None,
        }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Guarded<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if let Some(v) = self.failed {
            return Poll::Ready(Err(io::Error::new(io::ErrorKind::InvalidData, v.text())));
        }
        let before = buf.filled().len();
        let me = &mut *self;
        match Pin::new(&mut me.inner).poll_read(cx, buf) {
            Poll::Ready(Ok(())) => {
                let fresh = &buf.filled()[before..];
                if let Err(v) = me.framer.feed(fresh) {
                    me.failed = Some(v);
                    // Hide the offending bytes from the decoder.
                    buf.set_filled(before);
                    return Poll::Ready(Err(io::Error::new(io::ErrorKind::InvalidData, v.text())));
                }
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Guarded<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write_vectored(cx, bufs)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIMITS: Limits = Limits {
        reply_bytes: 1_024,
        reply_nodes: 64,
        depth: 8,
        line: 32,
    };

    fn check(bytes: &[u8]) -> Result<(), Violation> {
        Framer::new(LIMITS).feed(bytes)
    }

    /// Fed one byte at a time, the same answer as fed whole.
    fn check_split(bytes: &[u8]) -> Result<(), Violation> {
        let mut f = Framer::new(LIMITS);
        for b in bytes {
            f.feed(std::slice::from_ref(b))?;
        }
        Ok(())
    }

    #[test]
    fn valid_resp2_passes_whole_and_byte_by_byte() {
        let frames: &[&[u8]] = &[
            b"+OK\r\n",
            b"-NOSCRIPT No matching script\r\n",
            b":-42\r\n",
            b"$-1\r\n",
            b"$0\r\n\r\n",
            b"$5\r\nhe\r\no\r\n",
            b"*-1\r\n",
            b"*0\r\n",
            b"*3\r\n:1\r\n*2\r\n$1\r\na\r\n$-1\r\n+x\r\n",
            b"+a\r\n:1\r\n*1\r\n*1\r\n:2\r\n",
        ];
        for f in frames {
            assert_eq!(check(f), Ok(()), "{:?}", String::from_utf8_lossy(f));
            assert_eq!(check_split(f), Ok(()), "{:?}", String::from_utf8_lossy(f));
        }
    }

    #[test]
    fn lengths_below_minus_one_and_garbage_numbers_are_refused() {
        for f in [
            &b"$-2\r\n"[..],
            b"*-2\r\n",
            b"$-9223372036854775808\r\n",
            b"$99999999999999999999999\r\n",
            b"$+3\r\nabc\r\n",
            b"$ 3\r\nabc\r\n",
            b"$\r\n",
            b":12a\r\n",
        ] {
            assert_eq!(
                check(f),
                Err(Violation::BadLength),
                "{:?}",
                String::from_utf8_lossy(f)
            );
        }
    }

    #[test]
    fn an_unterminated_header_line_is_refused_at_the_line_limit() {
        let mut f = Framer::new(LIMITS);
        assert_eq!(f.feed(b"+"), Ok(()));
        assert_eq!(f.feed(&[b'a'; 32]), Ok(()));
        assert_eq!(f.feed(b"a"), Err(Violation::LineTooLong));
    }

    #[test]
    fn aggregate_size_nodes_and_depth_are_bounded() {
        // A bulk longer than a reply may be, by declaration alone.
        assert_eq!(check(b"$2000\r\n"), Err(Violation::ReplyTooLarge));
        // Many small bulks adding up.
        let mut many = b"*60\r\n".to_vec();
        many.extend(b"$30\r\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n".repeat(60));
        assert_eq!(check(&many), Err(Violation::ReplyTooLarge));
        // A declared array the node budget cannot cover.
        assert_eq!(check(b"*67108864\r\n"), Err(Violation::TooManyElements));
        // Nils count as nodes.
        let mut nils = b"*60\r\n".to_vec();
        nils.extend(b"$-1\r\n".repeat(60));
        assert_eq!(check(&nils), Ok(()));
        let mut over = b"*64\r\n".to_vec();
        over.extend(b"$-1\r\n".repeat(64));
        assert_eq!(check(&over), Err(Violation::TooManyElements));
        // Depth.
        assert_eq!(check(&b"*1\r\n".repeat(8)), Ok(()));
        assert_eq!(check(&b"*1\r\n".repeat(9)), Err(Violation::TooDeep));
    }

    #[test]
    fn budgets_reset_per_reply() {
        // Each reply is 1 007 bytes, under the 1 024 limit; ten of them in a
        // row are 10 070 bytes and all pass, because the budget is per reply.
        let mut f = Framer::new(LIMITS);
        for _ in 0..10 {
            assert_eq!(f.feed(b"$1000\r\n"), Ok(()));
            assert_eq!(f.feed(&[b'x'; 1000]), Ok(()));
            assert_eq!(f.feed(b"\r\n"), Ok(()));
        }
        // And one over the limit inside a single reply is refused.
        assert_eq!(f.feed(b"$1020\r\n"), Ok(()));
        assert_eq!(f.feed(&[b'x'; 1020]), Err(Violation::ReplyTooLarge));
    }

    #[test]
    fn framing_errors_are_refused() {
        assert_eq!(check(b"?x\r\n"), Err(Violation::BadType));
        assert_eq!(check(b"+a\rb"), Err(Violation::BadFraming));
        assert_eq!(check(b"$3\r\nabcd\r\n"), Err(Violation::BadFraming));
    }

    #[test]
    fn work_is_linear_in_bytes() {
        let limits = Limits {
            reply_bytes: 64 * 1024 * 1024,
            reply_nodes: 4_000_000,
            depth: 8,
            line: 64,
        };
        let mut frame = b"*1000000\r\n".to_vec();
        frame.extend(b":1\r\n".repeat(1_000_000));
        let started = std::time::Instant::now();
        let mut f = Framer::new(limits);
        for chunk in frame.chunks(3) {
            f.feed(chunk).expect("valid");
        }
        // ~4 MB in 3-byte chunks; a re-parsing checker would be quadratic.
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }
}
