use omni_control::config::process_env;
use omni_ir::js::trim;
use std::{
    collections::HashMap,
    io::{self, Read, Write},
    net::{TcpStream, ToSocketAddrs},
    time::{Duration, Instant},
};

pub fn run(flags: &HashMap<String, String>) -> Result<String, String> {
    let env = crate::context::resolve(flags).map_or_else(|_| process_env(), |ctx| ctx.env);
    let (host, port) = address(&env)?;
    probe(host, port, Duration::from_secs(2)).map_err(|e| format!("health check failed: {e}"))?;
    Ok("healthy".into())
}

fn address(env: &HashMap<String, String>) -> Result<(&str, u16), String> {
    let host = env.get("OMNI_HOST").map_or("", |s| trim(s));
    let host = match host {
        "" | "0.0.0.0" => "127.0.0.1",
        "::" | "[::]" => "::1",
        host => host
            .strip_prefix('[')
            .and_then(|s| s.strip_suffix(']'))
            .unwrap_or(host),
    };
    let raw = env.get("OMNI_PORT").map_or("9000", String::as_str);
    let port = raw
        .parse::<u16>()
        .ok()
        .filter(|&p| p != 0 && raw.bytes().all(|b| b.is_ascii_digit()))
        .ok_or("OMNI_PORT must be an integer between 1 and 65535")?;
    Ok((host, port))
}

fn remaining(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "probe timed out"))
}

fn probe(host: &str, port: u16, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    let mut connection = Err(io::Error::other("no address found for OMNI_HOST"));
    // Hostname resolution uses the OS resolver; the socket operations share one deadline.
    for addr in (host, port).to_socket_addrs()? {
        connection = TcpStream::connect_timeout(&addr, remaining(deadline)?);
        if connection.is_ok() {
            break;
        }
    }
    let mut stream = connection?;
    // Format the numeric destination as an HTTP authority (including IPv6 brackets).
    let authority = stream.peer_addr()?;
    stream.set_write_timeout(Some(remaining(deadline)?))?;
    write!(
        stream,
        "GET /health HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n"
    )?;

    // Only the status line matters. Cap its length and do not wait for a body/EOF.
    let mut buf = [0; 1024];
    let mut end = 0;
    while end < buf.len() {
        stream.set_read_timeout(Some(remaining(deadline)?))?;
        let read = stream.read(&mut buf[end..])?;
        if read == 0 {
            break;
        }
        end += read;
        if let Some(newline) = buf[..end].iter().position(|&b| b == b'\n') {
            return check_status(&buf[..=newline]);
        }
    }
    Err(io::Error::other("invalid HTTP status line"))
}

fn check_status(line: &[u8]) -> io::Result<()> {
    if let Some([a, b, c, b' ', reason @ ..]) = line
        .strip_prefix(b"HTTP/1.1 ")
        .or_else(|| line.strip_prefix(b"HTTP/1.0 "))
        .and_then(|rest| rest.strip_suffix(b"\r\n"))
        && [a, b, c].into_iter().all(u8::is_ascii_digit)
        && reason
            .iter()
            .all(|&b| b == b'\t' || (b >= b' ' && b != 127))
    {
        if *a == b'2' {
            return Ok(());
        }
        return Err(io::Error::other(format!(
            "HTTP status {}{}{}",
            char::from(*a),
            char::from(*b),
            char::from(*c)
        )));
    }
    Err(io::Error::other("invalid HTTP status line"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpListener, sync::mpsc, thread};

    fn response(bytes: &'static [u8]) -> io::Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let server = thread::spawn(move || -> io::Result<()> {
            let (mut socket, _) = listener.accept()?;
            let mut request = Vec::new();
            socket.set_read_timeout(Some(Duration::from_secs(1)))?;
            let mut reader = io::BufReader::new(&mut socket);
            while !request.ends_with(b"\r\n\r\n")
                && io::BufRead::read_until(&mut reader, b'\n', &mut request)? != 0
            {}
            socket.write_all(bytes)
        });
        let result = probe("127.0.0.1", port, Duration::from_secs(1));
        server.join().expect("server thread")?;
        result
    }

    #[test]
    fn rejects_unavailable_and_malformed_responses() {
        assert_eq!(
            response(b"HTTP/1.1 503 Service Unavailable\r\n")
                .expect_err("503 must fail")
                .to_string(),
            "HTTP status 503"
        );
        assert_eq!(
            response(b"not HTTP\r\n")
                .expect_err("garbage must fail")
                .to_string(),
            "invalid HTTP status line"
        );
    }

    #[test]
    fn rejects_a_closed_port() -> io::Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        drop(listener);
        assert_eq!(
            probe("127.0.0.1", port, Duration::from_secs(1))
                .expect_err("closed port must fail")
                .kind(),
            io::ErrorKind::ConnectionRefused
        );
        Ok(())
    }

    #[test]
    fn times_out_when_the_server_does_not_respond() -> io::Result<()> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let (done, wait) = mpsc::channel();
        let server = thread::spawn(move || -> io::Result<()> {
            let (_socket, _) = listener.accept()?;
            let _completion = wait.recv_timeout(Duration::from_secs(1));
            Ok(())
        });
        let started = Instant::now();
        let error = probe("127.0.0.1", port, Duration::from_millis(40));
        let elapsed = started.elapsed();
        let _completion = done.send(());
        server.join().expect("server thread")?;
        let error = error.expect_err("silent listener must fail");
        assert!(matches!(
            error.kind(),
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
        ));
        assert!(elapsed < Duration::from_secs(1), "took {elapsed:?}");
        Ok(())
    }

    #[test]
    fn uses_loopback_for_unspecified_hosts_and_checks_ports() {
        assert_eq!(
            address(&HashMap::new()).expect("default address"),
            ("127.0.0.1", 9000)
        );
        for (host, expected) in [("0.0.0.0", "127.0.0.1"), ("::", "::1"), ("[::]", "::1")] {
            let env = HashMap::from([
                ("OMNI_HOST".into(), host.into()),
                ("OMNI_PORT".into(), "12345".into()),
            ]);
            assert_eq!(address(&env).expect("mapped address"), (expected, 12345));
        }
        for port in ["", "0", "65536", "abc"] {
            assert!(address(&HashMap::from([("OMNI_PORT".into(), port.into())])).is_err());
        }
    }
}
