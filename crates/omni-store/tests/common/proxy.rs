//! A Postgres wire-protocol TCP proxy that can fault the next COMMIT in one
//! of four ways ([`Fault`]), and refuse new connections.
//!
//! Plain `NoTls` connections only: the client's first packet is the startup
//! message (an `SSLRequest`, if one comes, is forwarded as any other
//! untyped startup packet), then typed messages `type:u8 len:u32 body`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};

/// What happens to the next simple-query `COMMIT` any connection sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Fault {
    /// Forward it; swallow the server's answer (so it committed); close.
    LoseAck = 1,
    /// Forward it; swallow the server's answer; send the client a
    /// `FATAL 57P01` ErrorResponse (as a server shutting down sends), close.
    FatalAfterCommit = 2,
    /// Do not forward it; close both sides. The server sees the session end
    /// inside the transaction and rolls it back.
    DropBeforeCommit = 3,
    /// Forward it; swallow the server's answer (so it committed); send the
    /// client an `ERROR 40003` (statement completion unknown)
    /// ErrorResponse, close.
    CompletionUnknownAfterCommit = 4,
}

#[derive(Debug, Default)]
struct State {
    armed: AtomicU8,
    fired: AtomicU64,
    /// Once a fault fires, refuse (accept and close) new connections.
    refuse_after_fire: AtomicBool,
}

/// The running proxy; dropped, it stops accepting.
pub struct Proxy {
    pub port: u16,
    state: Arc<State>,
    accept: tokio::task::JoinHandle<()>,
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

impl Proxy {
    /// Listens on an ephemeral local port and forwards to `upstream`
    /// (`host:port`).
    pub async fn start(upstream: String) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let state = Arc::new(State::default());
        let s = Arc::clone(&state);
        let accept = tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                if s.refuse_after_fire.load(Ordering::SeqCst) && s.fired.load(Ordering::SeqCst) > 0
                {
                    drop(client);
                    continue;
                }
                let upstream = upstream.clone();
                let s = Arc::clone(&s);
                tokio::spawn(async move {
                    if let Ok(server) = TcpStream::connect(&upstream).await {
                        pump(client, server, s).await;
                    }
                });
            }
        });
        Self {
            port,
            state,
            accept,
        }
    }

    /// Faults the next COMMIT any connection sends.
    pub fn arm(&self, fault: Fault) {
        self.state.armed.store(fault as u8, Ordering::SeqCst);
    }

    /// Loses the acknowledgement of the next COMMIT.
    pub fn arm_commit_loss(&self) {
        self.arm(Fault::LoseAck);
    }

    /// After the armed fault fires, refuse every new connection.
    pub fn refuse_after_fire(&self) {
        self.state.refuse_after_fire.store(true, Ordering::SeqCst);
    }

    /// How many faults fired so far.
    pub fn fired(&self) -> u64 {
        self.state.fired.load(Ordering::SeqCst)
    }

    /// `url` (a `postgres://…@127.0.0.1:<port>/…` URL) pointed at the proxy.
    pub fn url(&self, url: &str) -> String {
        let (head, rest) = url.split_once('@').expect("url with credentials");
        let (_, tail) = rest.split_once('/').expect("url with a database");
        format!("{head}@127.0.0.1:{}/{tail}", self.port)
    }
}

async fn read_exact_or_eof(r: &mut tokio::net::tcp::OwnedReadHalf, buf: &mut [u8]) -> bool {
    r.read_exact(buf).await.is_ok()
}

/// An `ErrorResponse` with this severity (`S` and `V`), SQLSTATE, message.
fn error_response(severity: &str, code: &str, message: &str) -> Vec<u8> {
    let mut fields = Vec::new();
    for (t, v) in [
        (b'S', severity),
        (b'V', severity),
        (b'C', code),
        (b'M', message),
    ] {
        fields.push(t);
        fields.extend_from_slice(v.as_bytes());
        fields.push(0);
    }
    fields.push(0);
    let mut out = vec![b'E'];
    out.extend_from_slice(&u32::try_from(fields.len() + 4).expect("len").to_be_bytes());
    out.extend_from_slice(&fields);
    out
}

async fn pump(client: TcpStream, server: TcpStream, state: Arc<State>) {
    let (mut cr, cw) = client.into_split();
    let (mut sr, mut sw) = server.into_split();
    // The fault this connection took on (0: none), set before the COMMIT is
    // forwarded (or withheld).
    let fault = Arc::new(AtomicU8::new(0));
    let cw = Arc::new(tokio::sync::Mutex::new(cw));

    let to_server = {
        let fault = Arc::clone(&fault);
        let state = Arc::clone(&state);
        let cw = Arc::clone(&cw);
        tokio::spawn(async move {
            // Startup packets: `len:u32 body`, until the startup message
            // itself (anything but an SSLRequest, code 80877103).
            loop {
                let mut len = [0u8; 4];
                if !read_exact_or_eof(&mut cr, &mut len).await {
                    return;
                }
                let n = u32::from_be_bytes(len) as usize;
                let mut body = vec![0u8; n.saturating_sub(4)];
                if !read_exact_or_eof(&mut cr, &mut body).await {
                    return;
                }
                if sw.write_all(&len).await.is_err() || sw.write_all(&body).await.is_err() {
                    return;
                }
                let code = body
                    .get(..4)
                    .map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]]));
                if code != Some(80_877_103) {
                    break;
                }
            }
            loop {
                let mut head = [0u8; 5];
                if !read_exact_or_eof(&mut cr, &mut head).await {
                    return;
                }
                let n = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
                let mut body = vec![0u8; n.saturating_sub(4)];
                if !read_exact_or_eof(&mut cr, &mut body).await {
                    return;
                }
                if head[0] == b'Q' && body.strip_suffix(&[0]) == Some(b"COMMIT".as_slice()) {
                    let armed = state.armed.swap(0, Ordering::SeqCst);
                    if armed == Fault::DropBeforeCommit as u8 {
                        state.fired.fetch_add(1, Ordering::SeqCst);
                        // Close both sides without forwarding the COMMIT.
                        sw.shutdown().await.ok();
                        cw.lock().await.shutdown().await.ok();
                        return;
                    }
                    fault.store(armed, Ordering::SeqCst);
                }
                if sw.write_all(&head).await.is_err() || sw.write_all(&body).await.is_err() {
                    return;
                }
            }
        })
    };

    let mut buf = vec![0u8; 64 * 1024];
    while let Ok(n) = sr.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let f = fault.load(Ordering::SeqCst);
        if f != 0 {
            // The server has answered the COMMIT: it committed (or said why
            // not). The client never hears which.
            state.fired.fetch_add(1, Ordering::SeqCst);
            let answer = if f == Fault::FatalAfterCommit as u8 {
                Some(error_response(
                    "FATAL",
                    "57P01",
                    "terminating connection due to administrator command",
                ))
            } else if f == Fault::CompletionUnknownAfterCommit as u8 {
                Some(error_response(
                    "ERROR",
                    "40003",
                    "statement completion unknown",
                ))
            } else {
                None
            };
            if let Some(answer) = answer {
                cw.lock().await.write_all(&answer).await.ok();
            }
            break;
        }
        if cw.lock().await.write_all(&buf[..n]).await.is_err() {
            break;
        }
    }
    to_server.abort();
    cw.lock().await.shutdown().await.ok();
}
