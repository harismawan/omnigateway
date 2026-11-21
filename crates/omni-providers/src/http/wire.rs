//! The request bytes, exactly as `nodeHttpClient` puts them on the wire.
//!
//! `nodeHttpClient` copies the ordered header pairs into a plain JS object,
//! adds `Content-Length` for a non-empty body, except for Antigravity's explicit
//! `Transfer-Encoding: chunked`, and hands it to `node:http`,
//! which then adds `Host`, `Connection: keep-alive` and — for a bodiless
//! method that carries a body by default — `Content-Length: 0`. Each of those
//! steps has an observable quirk, and each is reproduced here (all measured
//! against bun 1.4.4, see `httpWire` in `conformance/vectors/vectors.json`):
//!
//! - **JS object keys.** Assigning the pairs to an object collapses exact
//!   duplicates (last value, first position) and enumerates array-index keys
//!   (`"2"`, `"10"`) first, ascending.
//! - **`setHeader`.** node then stores headers by lowercase name: a second
//!   casing of a name replaces the first's casing *and* value, at the first's
//!   position.
//! - **Trailing headers.** `Host` (unless given), then `Connection: keep-alive`
//!   (unless given), then `Content-Length: 0` or `Transfer-Encoding: chunked`
//!   when no framing header was given and the method has a body by default.
//! - **Values** are written as latin1 and validated as node does; a value with
//!   a character outside `\t`, `0x20–0x7e`, `0x80–0xff` is refused, as is a name
//!   that is not an HTTP token.

use omni_ir::jsjson::array_index;

use super::{HttpError, Scheme, Target};

/// What the writer decided that the response reader needs to know.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RequestFacts {
    /// The request asked for `Connection: close`, so the socket is not reused.
    pub close: bool,
    /// A `HEAD` response has no body whatever its headers say.
    pub head: bool,
}

/// Parses a URL the way `new URL(...)` plus `node:http` accept it.
pub(crate) fn parse_target(raw: &str) -> Result<Target, HttpError> {
    let url = url::Url::parse(raw).map_err(|_| HttpError::InvalidUrl(raw.into()))?;
    let scheme = match url.scheme() {
        "http" => Scheme::Http,
        "https" => Scheme::Https,
        _ => return Err(HttpError::InvalidUrl(raw.into())),
    };
    let host = url
        .host_str()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| HttpError::InvalidUrl(raw.into()))?;
    let default_port = match scheme {
        Scheme::Http => 80,
        Scheme::Https => 443,
    };
    // `url.port()` is `None` for the scheme's default, as WHATWG `url.port` is "".
    let port = url.port().unwrap_or(default_port);
    let host_header = if port == default_port {
        host.to_string()
    } else {
        format!("{host}:{port}")
    };
    // `${url.pathname}${url.search}`; `search` is "" for an empty query.
    let mut path = url.path().to_string();
    if let Some(q) = url.query().filter(|q| !q.is_empty()) {
        path.push('?');
        path.push_str(q);
    }
    let connect_host = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
        .to_string();
    Ok(Target {
        scheme,
        host: connect_host,
        port,
        host_header,
        path,
    })
}

fn is_token(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

/// A header value as the latin1 bytes node writes, or `None` where node's
/// `checkInvalidHeaderChar` refuses it.
fn latin1_value(value: &str, out: &mut Vec<u8>) -> bool {
    for c in value.chars() {
        let code = u32::from(c);
        let ok = code == 0x09 || (0x20..=0x7e).contains(&code) || (0x80..=0xff).contains(&code);
        if !ok {
            return false;
        }
        // In range 0..=0xff, so the narrowing is exact.
        out.push(u8::try_from(code).unwrap_or(b'?'));
    }
    true
}

/// `/(?:^|\W)token(?:$|\W)/i`, the regexes node matches framing values with.
fn has_token(value: &str, token: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    lower.match_indices(token).any(|(at, _)| {
        let before = at.checked_sub(1).map(|i| bytes[i]);
        let after = bytes.get(at + token.len()).copied();
        before.is_none_or(|b| !word(b)) && after.is_none_or(|b| !word(b))
    })
}

/// Encodes one request, head and body, or refuses it before anything is sent.
pub(crate) fn encode(
    provider: &str,
    method: &str,
    target: &Target,
    headers: &[(String, String)],
    body: &[u8],
) -> Result<(Vec<u8>, RequestFacts), HttpError> {
    let (mut head, facts, chunked) = encode_head(provider, method, target, headers, body.len())?;
    if chunked {
        if !body.is_empty() {
            head.extend_from_slice(format!("{:x}\r\n", body.len()).as_bytes());
            head.extend_from_slice(body);
            head.extend_from_slice(b"\r\n");
        }
        head.extend_from_slice(b"0\r\n\r\n");
    } else {
        head.extend_from_slice(body);
    }
    Ok((head, facts))
}

/// Reuse the compressed allocation rather than retaining two copies of it.
pub(crate) fn encode_owned(
    provider: &str,
    method: &str,
    target: &Target,
    headers: &[(String, String)],
    mut body: Vec<u8>,
) -> Result<(Vec<u8>, RequestFacts), HttpError> {
    let (mut head, facts, chunked) = encode_head(provider, method, target, headers, body.len())?;
    if chunked && !body.is_empty() {
        head.extend_from_slice(format!("{:x}\r\n", body.len()).as_bytes());
    }
    let len = body.len();
    body.resize(len + head.len(), 0);
    body.copy_within(..len, head.len());
    body[..head.len()].copy_from_slice(&head);
    if chunked {
        if len > 0 {
            body.extend_from_slice(b"\r\n");
        }
        body.extend_from_slice(b"0\r\n\r\n");
    }
    Ok((body, facts))
}

fn encode_head(
    provider: &str,
    method: &str,
    target: &Target,
    headers: &[(String, String)],
    body_len: usize,
) -> Result<(Vec<u8>, RequestFacts, bool), HttpError> {
    if !is_token(method) {
        return Err(HttpError::InvalidMethod(method.to_string()));
    }
    let has = |lower: &str| headers.iter().any(|(n, _)| n.eq_ignore_ascii_case(lower));

    // Step 1: `const headers = {}; for (const [n, v] of pairs) headers[n] = v;`
    let mut object: Vec<(&str, String)> = Vec::with_capacity(headers.len() + 1);
    for (name, value) in headers {
        match object.iter_mut().find(|(n, _)| *n == name.as_str()) {
            Some(slot) => slot.1.clone_from(value),
            None => object.push((name.as_str(), value.clone())),
        }
    }
    if body_len > 0
        && !has("content-length")
        && !(provider == "antigravity"
            && headers.iter().any(|(name, value)| {
                name.eq_ignore_ascii_case("transfer-encoding")
                    && value.eq_ignore_ascii_case("chunked")
            }))
    {
        object.push(("Content-Length", body_len.to_string()));
    }
    // Enumeration order: array-index keys ascending, then insertion order.
    let mut keys: Vec<usize> = (0..object.len()).collect();
    keys.sort_by_key(|&i| match array_index(object[i].0) {
        Some(index) => (0, index, i),
        None => (1, 0, i),
    });

    // Step 2: `setHeader` per key, stored by lowercase name.
    let mut out_headers: Vec<(String, &str, &str)> = Vec::with_capacity(object.len() + 3);
    for i in keys {
        let (name, value) = (&object[i].0, object[i].1.as_str());
        let lower = name.to_ascii_lowercase();
        match out_headers.iter_mut().find(|(l, _, _)| *l == lower) {
            Some(slot) => {
                slot.1 = name;
                slot.2 = value;
            }
            None => out_headers.push((lower, name, value)),
        }
    }
    // node adds Host after the caller's headers unless one was given.
    let host_value = target.host_header.as_str();
    if !has("host") {
        out_headers.push(("host".into(), "Host", host_value));
    }

    // Step 3: `_storeHeader`.
    let mut head = Vec::with_capacity(256);
    head.extend_from_slice(method.as_bytes());
    head.push(b' ');
    head.extend_from_slice(target.path.as_bytes());
    head.extend_from_slice(b" HTTP/1.1\r\n");
    let mut connection = false;
    let mut close = false;
    let mut content_length = false;
    let mut transfer_encoding = false;
    let mut chunked = false;
    let mut expect = false;
    for (lower, name, value) in &out_headers {
        if !is_token(name) {
            return Err(HttpError::InvalidHeader {
                name: (*name).to_string(),
            });
        }
        head.extend_from_slice(name.as_bytes());
        head.extend_from_slice(b": ");
        if !latin1_value(value, &mut head) {
            return Err(HttpError::InvalidHeader {
                name: (*name).to_string(),
            });
        }
        head.extend_from_slice(b"\r\n");
        match lower.as_str() {
            "connection" => {
                connection = true;
                close = has_token(value, "close");
            }
            "content-length" => content_length = true,
            "transfer-encoding" => {
                transfer_encoding = true;
                chunked = has_token(value, "chunked");
            }
            "expect" => expect = true,
            _ => {}
        }
    }
    if !connection {
        head.extend_from_slice(b"Connection: keep-alive\r\n");
    }
    let body_by_default = !matches!(
        method,
        "GET" | "HEAD" | "DELETE" | "OPTIONS" | "TRACE" | "CONNECT"
    );
    if !content_length && !transfer_encoding && body_by_default {
        if expect {
            // `Expect` makes node flush the head before `end()` knows the
            // length, so it falls back to chunked framing.
            head.extend_from_slice(b"Transfer-Encoding: chunked\r\n");
            chunked = true;
        } else {
            // Only reached with an empty body: a non-empty one was given a length.
            head.extend_from_slice(b"Content-Length: 0\r\n");
        }
    }
    head.extend_from_slice(b"\r\n");
    Ok((
        head,
        RequestFacts {
            close,
            head: method == "HEAD",
        },
        chunked,
    ))
}

#[cfg(test)]
mod tests {
    #[test]
    fn invalid_url_diagnostics_omit_credentials_and_query() {
        let error =
            super::parse_target("ftp://user:password@example.com/path?token=secret#fragment")
                .expect_err("unsupported scheme");
        for text in [
            format!("{error}"),
            format!("{error:?}"),
            format!("{error:#?}"),
        ] {
            assert!(text.contains("ftp://example.com"), "{text}");
            for secret in ["user", "password", "token", "secret", "fragment"] {
                assert!(!text.contains(secret), "{text}");
            }
        }
    }
    use super::*;

    #[test]
    fn explicit_chunked_framing_does_not_gain_content_length() {
        let target = parse_target("http://host.test/").expect("url");
        let headers = [("Transfer-Encoding".to_owned(), "chunked".to_owned())];
        let (wire, _) = encode("antigravity", "POST", &target, &headers, b"{}").expect("request");
        assert_eq!(
            wire,
            b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\nHost: host.test\r\nConnection: keep-alive\r\n\r\n2\r\n{}\r\n0\r\n\r\n"
        );
    }

    #[test]
    fn token_match_is_word_bounded_and_case_insensitive() {
        assert!(has_token("close", "close"));
        assert!(has_token("Keep-Alive, CLOSE", "close"));
        assert!(!has_token("closed", "close"));
        assert!(!has_token("enclose", "close"));
        assert!(has_token("gzip, chunked", "chunked"));
        assert!(!has_token("gzip", "chunked"));
    }

    #[test]
    fn urls_follow_whatwg_and_node_defaults() {
        let t = parse_target("https://Host.Test:443/a%20b/é?x=1#frag").expect("url");
        assert_eq!(t.host_header, "host.test");
        assert_eq!(t.port, 443);
        assert_eq!(t.path, "/a%20b/%C3%A9?x=1");
        let t = parse_target("http://[::1]:8080/?").expect("url");
        assert_eq!(t.host, "::1");
        assert_eq!(t.host_header, "[::1]:8080");
        assert_eq!(t.path, "/");
        for bad in ["not a url", "", "ftp://h/", "file:///etc/passwd", "/v1/x"] {
            assert!(parse_target(bad).is_err(), "{bad}");
        }
    }
}
