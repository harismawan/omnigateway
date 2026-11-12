//! A Postgres wire-protocol TCP proxy that can lose one COMMIT
//! acknowledgement: armed, it forwards the next simple-query `COMMIT` to the
//! server, swallows the server's answer (so the commit has happened), and
//! closes the client's connection before the client hears of it.
//!
//! Plain `NoTls` connections only: the client's first packet is the startup
//! message (an `SSLRequest`, if one comes, is forwarded as any other
//! untyped startup packet), then typed messages `type:u8 len:u32 body`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, TcpStream};

#[derive(Debug, Default)]
struct State {
    armed: AtomicBool,
    fired: AtomicU64,
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

    /// Loses the acknowledgement of the next COMMIT any connection sends.
    pub fn arm_commit_loss(&self) {
        self.state.armed.store(true, Ordering::SeqCst);
    }

    /// How many acknowledgements were lost so far.
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

async fn pump(client: TcpStream, server: TcpStream, state: Arc<State>) {
    let (mut cr, mut cw) = client.into_split();
    let (mut sr, mut sw) = server.into_split();
    // Set (before the COMMIT is forwarded) when this connection is to lose
    // the answer to it.
    let losing = Arc::new(AtomicBool::new(false));

    let to_server = {
        let losing = Arc::clone(&losing);
        let state = Arc::clone(&state);
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
                if head[0] == b'Q'
                    && body.strip_suffix(&[0]) == Some(b"COMMIT".as_slice())
                    && state.armed.swap(false, Ordering::SeqCst)
                {
                    losing.store(true, Ordering::SeqCst);
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
        if losing.load(Ordering::SeqCst) {
            // The server has answered the COMMIT, so it committed (or said
            // why not): the client never hears which.
            state.fired.fetch_add(1, Ordering::SeqCst);
            break;
        }
        if cw.write_all(&buf[..n]).await.is_err() {
            break;
        }
    }
    to_server.abort();
    cw.shutdown().await.ok();
}
