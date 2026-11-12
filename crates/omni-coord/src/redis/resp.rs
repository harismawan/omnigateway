//! RESP2 replies, parsed incrementally from the command connection's read
//! buffer. Requests are encoded by `redis::Cmd` / `redis::Pipeline`; only
//! replies are parsed here, into `redis::Value` so the reply readers in
//! `mod.rs` are unchanged.
//!
//! The connection speaks RESP2 (no `HELLO`), so the RESP3 types never arrive
//! and are a protocol error.

use redis::Value;

/// A server error reply. Only the code is kept (`NOSCRIPT`, `BUSY`, `ERR`…):
/// a script error's text can carry argument values, and the code is what a
/// fault is classified and logged by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServerError {
    pub(crate) code: String,
}

pub(crate) type Reply = Result<Value, ServerError>;

/// The largest single reply accepted. Nothing this crate sends can produce
/// one near it; a larger length is a corrupt stream, and the connection is
/// retired rather than buffering it.
const MAX_BULK: usize = 64 * 1024 * 1024;
const MAX_DEPTH: usize = 32;

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ProtocolError;

/// One complete reply at the head of `buf` and the bytes it used, `None`
/// when more bytes are needed.
pub(crate) fn parse(buf: &[u8]) -> Result<Option<(Reply, usize)>, ProtocolError> {
    let mut pos = 0;
    match value(buf, &mut pos, 0)? {
        None => Ok(None),
        Some(reply) => Ok(Some((reply, pos))),
    }
}

fn line<'a>(buf: &'a [u8], pos: &mut usize) -> Option<&'a [u8]> {
    let rest = buf.get(*pos..)?;
    let end = rest.windows(2).position(|w| w == b"\r\n")?;
    *pos += end + 2;
    Some(&rest[..end])
}

fn int(bytes: &[u8]) -> Result<i64, ProtocolError> {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|s| s.parse().ok())
        .ok_or(ProtocolError)
}

fn value(buf: &[u8], pos: &mut usize, depth: usize) -> Result<Option<Reply>, ProtocolError> {
    if depth > MAX_DEPTH {
        return Err(ProtocolError);
    }
    let Some(&tag) = buf.get(*pos) else {
        return Ok(None);
    };
    *pos += 1;
    let Some(head) = line(buf, pos) else {
        return Ok(None);
    };
    Ok(Some(match tag {
        b'+' => Ok(if head == b"OK" {
            Value::Okay
        } else {
            Value::SimpleString(String::from_utf8_lossy(head).into_owned())
        }),
        b'-' => {
            let text = String::from_utf8_lossy(head);
            Err(ServerError {
                code: text.split(' ').next().unwrap_or_default().to_owned(),
            })
        }
        b':' => Ok(Value::Int(int(head)?)),
        b'$' => {
            let len = int(head)?;
            if len < 0 {
                return Ok(Some(Ok(Value::Nil)));
            }
            let len = usize::try_from(len).map_err(|_| ProtocolError)?;
            if len > MAX_BULK {
                return Err(ProtocolError);
            }
            let Some(body) = buf.get(*pos..*pos + len + 2) else {
                return Ok(None);
            };
            if &body[len..] != b"\r\n" {
                return Err(ProtocolError);
            }
            *pos += len + 2;
            Ok(Value::BulkString(body[..len].to_vec()))
        }
        b'*' => {
            let n = int(head)?;
            if n < 0 {
                return Ok(Some(Ok(Value::Nil)));
            }
            let n = usize::try_from(n).map_err(|_| ProtocolError)?;
            if n > MAX_BULK {
                return Err(ProtocolError);
            }
            let mut items = Vec::with_capacity(n.min(1_024));
            let mut error = None;
            for _ in 0..n {
                match value(buf, pos, depth + 1)? {
                    None => return Ok(None),
                    Some(Ok(item)) => items.push(item),
                    // An error inside an array (a pipeline under MULTI, a
                    // script returning an error table) fails the whole reply.
                    Some(Err(e)) => error = error.or(Some(e)),
                }
            }
            match error {
                Some(e) => Err(e),
                None => Ok(Value::Array(items)),
            }
        }
        _ => return Err(ProtocolError),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn whole(bytes: &[u8]) -> Reply {
        let (reply, used) = parse(bytes).expect("valid").expect("complete");
        assert_eq!(used, bytes.len());
        reply
    }

    #[test]
    fn parses_every_resp2_type() {
        assert_eq!(whole(b"+OK\r\n"), Ok(Value::Okay));
        assert_eq!(whole(b"+PONG\r\n"), Ok(Value::SimpleString("PONG".into())));
        assert_eq!(
            whole(b"-NOSCRIPT No matching script\r\n"),
            Err(ServerError {
                code: "NOSCRIPT".into()
            })
        );
        assert_eq!(whole(b":-3\r\n"), Ok(Value::Int(-3)));
        assert_eq!(whole(b"$-1\r\n"), Ok(Value::Nil));
        assert_eq!(whole(b"$0\r\n\r\n"), Ok(Value::BulkString(vec![])));
        assert_eq!(
            whole(b"*3\r\n:1\r\n$2\r\na\r\r\n*-1\r\n"),
            Ok(Value::Array(vec![
                Value::Int(1),
                Value::BulkString(b"a\r".to_vec()),
                Value::Nil
            ]))
        );
    }

    #[test]
    fn a_partial_reply_waits_for_more_bytes_at_every_cut() {
        let full = b"*2\r\n$5\r\nhello\r\n:42\r\n";
        for cut in 0..full.len() {
            assert_eq!(parse(&full[..cut]), Ok(None), "cut at {cut}");
        }
        assert!(parse(full).expect("valid").is_some());
    }

    #[test]
    fn two_replies_are_read_one_at_a_time() {
        let buf = b":1\r\n:2\r\n";
        let (first, used) = parse(buf).expect("valid").expect("complete");
        assert_eq!((first, used), (Ok(Value::Int(1)), 4));
        assert_eq!(whole(&buf[used..]), Ok(Value::Int(2)));
    }

    #[test]
    fn garbage_is_a_protocol_error() {
        assert_eq!(parse(b"?x\r\n"), Err(ProtocolError));
        assert_eq!(parse(b":x\r\n"), Err(ProtocolError));
        assert_eq!(parse(b"$3\r\nabcde\r\n"), Err(ProtocolError));
        assert_eq!(parse(b"$99999999999\r\n"), Err(ProtocolError));
    }
}
