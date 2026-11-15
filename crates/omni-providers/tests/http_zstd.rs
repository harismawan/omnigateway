use omni_providers::http::{BodyEncoding, Client, HttpRequest};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

type Error = Box<dyn std::error::Error + Send + Sync>;

async fn capture(mut req: HttpRequest) -> Result<Vec<u8>, Error> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await?;
        let mut bytes = Vec::new();
        loop {
            let mut buf = [0; 8192];
            let n = socket.read(&mut buf).await?;
            if n == 0 {
                return Err("premature EOF".into());
            }
            bytes.extend_from_slice(&buf[..n]);
            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = std::str::from_utf8(&bytes[..end])?;
                let length = head
                    .lines()
                    .find_map(|l| l.strip_prefix("Content-Length: "))
                    .ok_or("missing length")?
                    .parse::<usize>()?;
                if bytes.len() == end + 4 + length {
                    socket
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                        .await?;
                    return Ok::<_, Box<dyn std::error::Error + Send + Sync>>(bytes);
                }
            }
        }
    });
    req.url = format!("http://{address}/");
    Client::new().send(req).await?;
    server.await?
}

fn request(source: String) -> HttpRequest {
    HttpRequest {
        provider: "openai".into(),
        url: "invalid URL (validation must precede parsing)".into(),
        method: "POST".into(),
        headers: vec![
            ("X-First".into(), "one".into()),
            ("content-encoding".into(), "zstd".into()),
            ("X-Last".into(), "two".into()),
            ("Host".into(), "fixture".into()),
        ],
        body: source,
        body_encoding: Some(BodyEncoding::Zstd),
        request_id: None,
    }
}

fn split(bytes: &[u8]) -> Result<(&[u8], &[u8]), Error> {
    let end = bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("missing head")?;
    Ok((&bytes[..end], &bytes[end + 4..]))
}

fn frozen(req: &HttpRequest) -> Result<Vec<u8>, Error> {
    use std::io::Write as _;
    use std::process::{Command, Stdio};
    let mut child = Command::new("bun")
        .arg("tests/http-zstd-reference.ts")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .ok_or("stdin")?
        .write_all(&serde_json::to_vec(
            &serde_json::json!({"body": req.body, "headers": req.headers}),
        )?)?;
    let output = child.wait_with_output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let row: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let hex = row["hex"].as_str().ok_or("hex")?;
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).map_err(Into::into))
        .collect()
}

async fn compare(req: HttpRequest) -> Result<(), Error> {
    let reference = frozen(&req)?;
    let source = req.body.clone();
    let bytes = capture(req).await?;
    let (head, body) = split(&bytes)?;
    let (reference_head, reference_body) = split(&reference)?;
    assert_eq!(head, reference_head);
    let length = std::str::from_utf8(head)?
        .lines()
        .find_map(|l| l.strip_prefix("Content-Length: "))
        .ok_or("length")?
        .parse::<usize>()?;
    assert_eq!(length, body.len());
    assert_eq!(zstd::stream::decode_all(body)?, source.as_bytes());
    assert_eq!(zstd::stream::decode_all(reference_body)?, source.as_bytes());
    eprintln!(
        "frozen wire source={} compressed={} identical={}",
        source.len(),
        body.len(),
        body == reference_body
    );
    Ok(())
}

#[tokio::test]
async fn compressed_request_wire() -> Result<(), Error> {
    for size in [17, 131_073, 3_145_729] {
        let source = format!("{{\"message\":\"é{}\"}}", "abcdefg".repeat(size / 7 + 1));
        compare(request(source)).await?;
    }
    Ok(())
}

#[tokio::test]
async fn refuses_invalid_framing_before_network() -> Result<(), Error> {
    use omni_providers::http::HttpError;
    let base = request("{}".into());
    let mut cases = Vec::new();
    let mut length = base.clone();
    length.headers.push(("CoNtEnT-LeNgTh".into(), "2".into()));
    cases.push(length);
    for values in [vec![], vec!["gzip"], vec!["zstd", "zstd"]] {
        let mut req = base.clone();
        req.headers.retain(|(n, _)| n != "content-encoding");
        req.headers.extend(
            values
                .into_iter()
                .map(|v| ("Content-Encoding".into(), v.into())),
        );
        cases.push(req);
    }
    for req in cases {
        let error = Client::new().send(req).await.expect_err("invalid framing");
        assert!(matches!(error, HttpError::InvalidEncodedRequest(_)));
        assert_eq!(
            error.to_string(),
            "openai codec buildRequest did not return a usable request"
        );
    }
    let mut valid = base;
    valid.headers[1].1 = " ZsTd ".into();
    compare(valid).await?;
    Ok(())
}

#[tokio::test]
async fn empty_frozen_chunked_rust_refused() -> Result<(), Error> {
    let req = request(String::new());
    let reference = frozen(&req)?;
    let (head, body) = split(&reference)?;
    assert_eq!(
        std::str::from_utf8(head)?,
        "POST / HTTP/1.1\r\nX-First: one\r\ncontent-encoding: zstd\r\nX-Last: two\r\nHost: fixture\r\nConnection: keep-alive\r\nTransfer-Encoding: chunked"
    );
    assert_eq!(
        body,
        b"9\r\n\x28\xb5\x2f\xfd\x00\x58\x01\x00\x00\r\n0\r\n\r\n"
    );
    assert!(zstd::stream::decode_all(&body[3..12])?.is_empty());
    let error = Client::new().send(req).await.expect_err("empty refused");
    assert!(matches!(
        error,
        omni_providers::http::HttpError::EmptyEncodedBody
    ));
    Ok(())
}

#[tokio::test]
async fn oauth_codec_end_to_end() -> Result<(), Error> {
    use omni_providers::codec::{CodecInput, Credentials, ProviderCodec};
    use omni_providers::openai::OpenAiCodec;
    let request_ir = serde_json::from_value(
        serde_json::json!({"model":"gpt-6-astra", "messages":[], "stream":true}),
    )?;
    let credentials = Credentials {
        access_token: Some("oauth-token".into()),
        api_key: None,
        provider_data: Default::default(),
    };
    let built = OpenAiCodec.build_request(&CodecInput {
        request: &request_ir,
        model: "gpt-6-astra",
        credentials: &credentials,
        request_id: Some("req"),
        request_started_at: Some(123.0),
        auto_cache_enabled: None,
        max_output_tokens: None,
    })?;
    let mut req = request(built.request.body);
    req.headers = built.request.headers;
    req.body_encoding = built.request.body_encoding;
    compare(req).await?;
    Ok(())
}
