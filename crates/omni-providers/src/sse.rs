//! The incremental SSE parser, ported from `packages/providers/src/sse.ts`.
//!
//! Byte-for-byte the TS semantics, including the parts that are TextDecoder's
//! rather than the parser's:
//!
//! - UTF-8 is decoded with replacement (WHATWG maximal-subpart, which is what
//!   `String::from_utf8_lossy` does too), a sequence split across chunks is
//!   carried, and one leading BOM is stripped. An incomplete sequence at end of
//!   stream is dropped, because `parseSse` never flushes its decoder.
//! - A record ends at a blank line in any of `\n\n`, `\n\r\n` (which also covers
//!   `\r\n\r\n`); a trailing `\r` is stripped per line; a bare `\r` is data.
//! - [`MAX_RECORD_CHARS`] is counted in UTF-16 code units, as JS counts
//!   `string.length`, and checked at the same two points TS checks it.
//!
//! Linear in the input: the buffer is appended to, scanned from where the last
//! scan stopped, and compacted once per chunk.

use omni_ir::error::{ErrorCode, GatewayError};
use omni_ir::js::utf16_len;

/// The largest single SSE record assembled, in UTF-16 code units (10 MiB).
pub const MAX_RECORD_CHARS: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseMessage {
    pub event: String,
    pub data: String,
}

/// Incremental parser state. Feed bytes with [`push`](Self::push), then call
/// [`finish`](Self::finish) at end of stream.
#[derive(Debug, Default)]
pub struct SseParser {
    /// Decoded text not yet consumed; starts at the current record.
    buf: String,
    /// The UTF-16 length of `buf[..counted]`. Counted only once `buf` holds
    /// more than [`MAX_RECORD_CHARS`] bytes: a UTF-16 length never exceeds
    /// the UTF-8 length, so a shorter buffer cannot be over the cap.
    counted_units: usize,
    /// How far into `buf` `counted_units` reaches.
    counted: usize,
    /// Byte offset in `buf` from which to resume looking for `\n`.
    scan_from: usize,
    /// Bytes of a UTF-8 sequence split across chunks (at most three).
    carry: Vec<u8>,
    /// Whether the first character has been decoded (BOM handling).
    started: bool,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Consumes one body chunk, appending every completed message to `out`.
    ///
    /// On an oversized record the messages completed before it are already in
    /// `out`, and the error is returned; the parser must not be used again.
    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<SseMessage>) -> Result<(), GatewayError> {
        self.decode(chunk);
        // Start of the record in progress, and where the next `\n` search begins.
        let mut consumed = 0;
        let mut at = self.scan_from;
        let resume = loop {
            let bytes = self.buf.as_bytes();
            let Some(off) = memchr(b'\n', &bytes[at..]) else {
                break bytes.len();
            };
            let nl = at + off;
            let end = match (bytes.get(nl + 1), bytes.get(nl + 2)) {
                (Some(b'\n'), _) => nl + 2,
                (Some(b'\r'), Some(b'\n')) => nl + 3,
                // Undecidable until the next chunk supplies what follows.
                (None, _) | (Some(b'\r'), None) => break nl,
                _ => {
                    at = nl + 1;
                    continue;
                }
            };
            let record = &self.buf[consumed..nl];
            // Checked before parsing, so an oversized record arriving whole is
            // refused rather than assembled. Units never exceed bytes, so
            // only a record longer than the cap in bytes needs counting.
            if record.len() > MAX_RECORD_CHARS && utf16_len(record) > MAX_RECORD_CHARS {
                return Err(oversized());
            }
            if let Some(msg) = parse_record(record) {
                out.push(msg);
            }
            consumed = end;
            at = end;
        };
        if consumed > 0 {
            self.buf.drain(..consumed);
            self.counted = 0;
            self.counted_units = 0;
        }
        self.scan_from = resume - consumed;
        if self.buf_units_over_cap() {
            return Err(oversized());
        }
        Ok(())
    }

    /// Whether the unconsumed text is over [`MAX_RECORD_CHARS`] UTF-16 units.
    /// Linear over a stream: the count resumes where it stopped while the
    /// same record keeps growing, and restarts only after a record ends.
    fn buf_units_over_cap(&mut self) -> bool {
        if self.buf.len() <= MAX_RECORD_CHARS {
            return false;
        }
        self.counted_units += utf16_len(&self.buf[self.counted..]);
        self.counted = self.buf.len();
        self.counted_units > MAX_RECORD_CHARS
    }

    /// End of stream: a record without a final blank line is still a message.
    pub fn finish(self) -> Option<SseMessage> {
        parse_record(&self.buf)
    }

    fn decode(&mut self, chunk: &[u8]) {
        let before = self.buf.len();
        if self.carry.is_empty() {
            decode_into(chunk, &mut self.buf, &mut self.carry);
        } else {
            let mut joined = std::mem::take(&mut self.carry);
            joined.extend_from_slice(chunk);
            decode_into(&joined, &mut self.buf, &mut self.carry);
        }
        let appended = &self.buf[before..];
        if !self.started && !appended.is_empty() {
            self.started = true;
            if let Some(rest) = appended.strip_prefix('\u{feff}') {
                let skip = appended.len() - rest.len();
                self.buf.drain(before..before + skip);
            }
        }
    }
}

/// Lossy streaming UTF-8 decode: complete text to `out`, an incomplete
/// trailing sequence to `carry`.
fn decode_into(mut bytes: &[u8], out: &mut String, carry: &mut Vec<u8>) {
    loop {
        match std::str::from_utf8(bytes) {
            Ok(s) => {
                out.push_str(s);
                return;
            }
            Err(e) => {
                let (valid, rest) = bytes.split_at(e.valid_up_to());
                // `valid` was just checked by `from_utf8`.
                out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                match e.error_len() {
                    Some(len) => {
                        out.push('\u{fffd}');
                        bytes = &rest[len..];
                    }
                    None => {
                        carry.extend_from_slice(rest);
                        return;
                    }
                }
            }
        }
    }
}

fn memchr(needle: u8, haystack: &[u8]) -> Option<usize> {
    memchr::memchr(needle, haystack)
}

/// A record past the cap. Gateway-authored: one integer and a literal.
fn oversized() -> GatewayError {
    GatewayError::new(
        ErrorCode::Upstream,
        format!("upstream SSE record exceeded {MAX_RECORD_CHARS} characters"),
    )
    .gateway_authored()
}

fn parse_record(record: &str) -> Option<SseMessage> {
    let mut event: Option<&str> = None;
    let mut data: Option<String> = None;
    for raw in record.split('\n') {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        let (field, value) = match line.find(':') {
            Some(colon) => (&line[..colon], &line[colon + 1..]),
            None => (line, ""),
        };
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => event = Some(value),
            "data" => match &mut data {
                Some(d) => {
                    d.push('\n');
                    d.push_str(value);
                }
                None => data = Some(value.to_string()),
            },
            _ => {}
        }
    }
    data.map(|data| SseMessage {
        event: event.unwrap_or("message").to_string(),
        data,
    })
}
