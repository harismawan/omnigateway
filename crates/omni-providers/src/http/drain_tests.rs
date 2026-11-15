use super::{pool::*, *};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

async fn pair(pool: &Arc<Pool>) -> (ResponseBody, TcpStream) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let client = TcpStream::connect(addr).await.expect("connect");
    let (server, _) = listener.accept().await.expect("accept");
    let key = Key::of(&Target {
        scheme: Scheme::Http,
        host: "127.0.0.1".into(),
        port: addr.port(),
        host_header: "localhost".into(),
        path: "/".into(),
    });
    (
        ResponseBody::drain_test_body(client, pool.clone(), key),
        server,
    )
}
async fn closed(socket: &mut TcpStream) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut b = [0; 1024];
        loop {
            match socket.read(&mut b).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    })
    .await
    .expect("socket closed");
}
fn pool() -> Arc<Pool> {
    Arc::new(Pool::new(None, PoolLimits::default()))
}

#[tokio::test]
async fn drain_never_terminates() {
    let p = pool();
    let (b, mut s) = pair(&p).await;
    b.finish_if_ready();
    closed(&mut s).await;
    assert_eq!(p.idle_count(), 0);
}

#[tokio::test]
async fn drain_invalid_and_excess_wire() {
    for tail in [
        b"nope\r\n".to_vec(),
        b"0\r\n\r\nHTTP/1.1 200 POISON\r\n\r\n".to_vec(),
        format!("10001\r\n{}\r\n0\r\n\r\n", "x".repeat(65537)).into_bytes(),
        "1\r\nx\r\n".repeat(12000).into_bytes(),
    ] {
        let p = pool();
        let (b, mut s) = pair(&p).await;
        b.finish_if_ready();
        let _write_result = s.write_all(&tail).await;
        closed(&mut s).await;
        assert_eq!(p.idle_count(), 0);
    }
}

#[tokio::test]
async fn drain_eof() {
    let p = pool();
    let (b, mut s) = pair(&p).await;
    b.finish_if_ready();
    s.shutdown().await.expect("shutdown");
    closed(&mut s).await;
    assert_eq!(p.idle_count(), 0);
}

#[tokio::test]
async fn drain_survives_body_handoff() {
    let p = pool();
    let (b, mut s) = pair(&p).await;
    b.finish_if_ready();
    s.write_all(b"0\r\n\r\n").await.expect("terminator");
    tokio::time::timeout(Duration::from_secs(5), async {
        while p.idle_count() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("returned");
}

#[tokio::test]
async fn drain_capacity_and_pool_shutdown() {
    let p = pool();
    let mut peers = Vec::new();
    let mut bodies = Vec::new();
    for _ in 0..40 {
        let (b, s) = pair(&p).await;
        bodies.push(b);
        peers.push(s);
    }
    // No awaits during handoff: all slots are occupied before tasks can run.
    for b in bodies {
        b.finish_if_ready();
    }
    assert_eq!(p.drain_test_count(), 32);
    for s in &mut peers[32..] {
        closed(s).await;
    }
    let weak = Arc::downgrade(&p);
    drop(p);
    assert!(weak.upgrade().is_none());
    for s in &mut peers[..32] {
        closed(s).await;
    }
}

#[tokio::test]
async fn pool_shutdown_tasks_joined() {
    let client = Client::new();
    let count = client.pool.active_drains.clone();
    let (body, mut peer) = pair(&client.pool).await;
    body.finish_if_ready();
    assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
    drop(client);
    tokio::time::timeout(Duration::from_secs(5), async {
        while count.load(std::sync::atomic::Ordering::SeqCst) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("task future destroyed");
    closed(&mut peer).await;
}

#[test]
fn finish_without_runtime_closes() {
    let runtime = tokio::runtime::Runtime::new().expect("runtime");
    let p = pool();
    let (body, mut peer) = runtime.block_on(pair(&p));
    body.finish_if_ready();
    assert_eq!(p.drain_test_count(), 0);
    runtime.block_on(closed(&mut peer));
}
