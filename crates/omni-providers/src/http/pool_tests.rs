//! Unit tests for `pool.rs`: connect attempts and retention bounds.

use super::*;
use std::sync::Mutex as StdMutex;

#[test]
fn interleaves_families_starting_with_the_first() {
    let v4 = |n: u8| SocketAddr::from(([10, 0, 0, n], 1));
    let v6 = |n: u16| SocketAddr::from(([0, 0, 0, 0, 0, 0, 0, n], 1));
    assert_eq!(
        interleave(vec![v6(1), v6(2), v4(1), v4(2), v4(3)]),
        vec![v6(1), v4(1), v6(2), v4(2), v4(3)]
    );
    assert_eq!(interleave(vec![v4(1), v6(1)]), vec![v4(1), v6(1)]);
    assert!(interleave(vec![]).is_empty());
}

fn v4(n: u8) -> SocketAddr {
    SocketAddr::from(([10, 0, 0, n], 443))
}
fn v6(n: u16) -> SocketAddr {
    SocketAddr::from(([0x2001, 0xdb8, 0, 0, 0, 0, 0, n], 443))
}

/// A connector scripted per address: `Ok` connects, `Err` refuses at
/// once, absent never completes. Records the order of attempts.
fn scripted(
    script: Vec<(SocketAddr, Result<u32, io::ErrorKind>)>,
    tried: Arc<StdMutex<Vec<SocketAddr>>>,
) -> impl FnMut(SocketAddr) -> Pin<Box<dyn Future<Output = io::Result<u32>> + Send>> {
    move |addr| {
        tried.lock().expect("lock").push(addr);
        let outcome = script.iter().find(|(a, _)| *a == addr).map(|(_, r)| *r);
        Box::pin(async move {
            match outcome {
                Some(Ok(id)) => Ok(id),
                Some(Err(kind)) => Err(io::Error::new(kind, "connect ECONNREFUSED")),
                None => std::future::pending().await,
            }
        })
    }
}

#[tokio::test(start_paused = true)]
async fn a_single_address_that_never_answers_is_bounded_at_3s() {
    let tried = Arc::default();
    let started = tokio::time::Instant::now();
    let err = connect_any(vec![v4(1)], scripted(vec![], Arc::clone(&tried)))
        .await
        .expect_err("never answers");
    assert_eq!(started.elapsed(), CONNECT_ATTEMPT_TIMEOUT);
    let HttpError::Connect(io) = &err else {
        panic!("{err:?}")
    };
    assert_eq!(io.kind(), io::ErrorKind::TimedOut);
    let text = io.to_string();
    assert!(
        text.contains("ETIMEDOUT") && text.contains("10.0.0.1:443"),
        "{text}"
    );
}

#[tokio::test(start_paused = true)]
async fn every_attempt_gets_its_own_3s_across_alternating_families() {
    let tried = Arc::new(StdMutex::new(Vec::new()));
    let addrs = interleave(vec![v6(1), v6(2), v4(1)]);
    let started = tokio::time::Instant::now();
    // v6(1) and v4(1) hang; v6(2) answers.
    let got = connect_any(addrs, scripted(vec![(v6(2), Ok(7))], Arc::clone(&tried)))
        .await
        .expect("connects");
    assert_eq!(got, 7);
    assert_eq!(*tried.lock().expect("lock"), vec![v6(1), v4(1), v6(2)]);
    assert_eq!(started.elapsed(), CONNECT_ATTEMPT_TIMEOUT * 2);
}

#[tokio::test(start_paused = true)]
async fn a_refusal_falls_through_immediately_to_the_next_address() {
    let tried = Arc::new(StdMutex::new(Vec::new()));
    let started = tokio::time::Instant::now();
    let got = connect_any(
        vec![v6(1), v4(1)],
        scripted(
            vec![
                (v6(1), Err(io::ErrorKind::ConnectionRefused)),
                (v4(1), Ok(2)),
            ],
            Arc::clone(&tried),
        ),
    )
    .await
    .expect("second connects");
    assert_eq!(got, 2);
    assert_eq!(started.elapsed(), Duration::ZERO);
    assert_eq!(*tried.lock().expect("lock"), vec![v6(1), v4(1)]);
}

#[tokio::test(start_paused = true)]
async fn the_error_names_every_attempt_and_its_cause() {
    let tried = Arc::default();
    let err = connect_any(
        vec![v6(1), v4(1)],
        scripted(
            vec![(v6(1), Err(io::ErrorKind::ConnectionRefused))],
            Arc::clone(&tried),
        ),
    )
    .await
    .expect_err("none connects");
    let text = err.to_string();
    assert!(
        text.contains("[2001:db8::1]:443") && text.contains("ECONNREFUSED"),
        "{text}"
    );
    assert!(
        text.contains("10.0.0.1:443") && text.contains("ETIMEDOUT"),
        "{text}"
    );
}

/// A connected loopback pair; the server half is kept alive by the caller.
async fn pair(listener: &tokio::net::TcpListener) -> (Conn, TcpStream) {
    let addr = listener.local_addr().expect("addr");
    let (client, server) = tokio::join!(TcpStream::connect(addr), listener.accept());
    (
        Conn::Plain(client.expect("connect")),
        server.expect("accept").0,
    )
}

fn key(port: u16) -> Key {
    Key {
        scheme: Scheme::Http,
        host: "127.0.0.1".into(),
        port,
    }
}

fn limits(total: usize, per: usize) -> PoolLimits {
    PoolLimits {
        max_idle: total,
        max_idle_per_destination: per,
        idle_timeout: Duration::from_secs(90),
    }
}

#[tokio::test]
async fn the_default_limits_are_node_like() {
    let d = PoolLimits::default();
    assert_eq!(d.max_idle, 256);
    assert_eq!(d.max_idle_per_destination, 256);
    assert_eq!(d.idle_timeout, Duration::from_secs(90));
}

#[tokio::test]
async fn idle_connections_are_capped_across_destinations() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let pool = Pool::new(None, limits(3, 2));
    let mut servers = Vec::new();
    // Five destinations, one idle connection each: only the newest three stay.
    for port in 1..=5 {
        let (conn, server) = pair(&listener).await;
        servers.push(server);
        pool.checkin(key(port), conn);
    }
    assert_eq!(pool.idle_count(), 3);
    assert_eq!(pool.destinations(), 3);
    assert!(pool.checkout(&key(1)).is_none(), "oldest evicted");
    assert!(pool.checkout(&key(2)).is_none(), "oldest evicted");
    assert!(pool.checkout(&key(5)).is_some());
}

#[tokio::test]
async fn the_per_destination_cap_still_applies() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let pool = Pool::new(None, limits(10, 2));
    let mut servers = Vec::new();
    for _ in 0..4 {
        let (conn, server) = pair(&listener).await;
        servers.push(server);
        pool.checkin(key(1), conn);
    }
    assert_eq!(pool.idle_count(), 2);
}

#[tokio::test]
async fn an_emptied_destination_entry_is_removed() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let pool = Pool::new(None, limits(10, 10));
    let (conn, _server) = pair(&listener).await;
    pool.checkin(key(1), conn);
    assert_eq!(pool.destinations(), 1);
    assert!(pool.checkout(&key(1)).is_some());
    assert_eq!(pool.destinations(), 0);
    // A destination whose only connection died is removed on checkout too.
    let (conn, server) = pair(&listener).await;
    pool.checkin(key(2), conn);
    drop(server);
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(pool.checkout(&key(2)).is_none());
    assert_eq!(pool.destinations(), 0);
}

#[tokio::test(start_paused = true)]
async fn idle_connections_expire_without_their_origin_being_revisited() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let pool = Arc::new(Pool::new(None, limits(10, 10)));
    let (conn, _server) = pair(&listener).await;
    Pool::checkin_owned(&pool, key(1), conn);
    tokio::time::sleep(Duration::from_secs(89)).await;
    assert_eq!(pool.idle_count(), 1);
    // Nothing touches the pool; the reaper alone closes it.
    tokio::time::sleep(Duration::from_secs(60)).await;
    assert_eq!(pool.idle_count(), 0);
    assert_eq!(pool.destinations(), 0);
}

#[tokio::test(start_paused = true)]
async fn a_return_to_one_origin_sweeps_expired_connections_of_others() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let pool = Pool::new(None, limits(10, 10));
    let (old, _s1) = pair(&listener).await;
    pool.checkin(key(1), old);
    tokio::time::sleep(Duration::from_secs(91)).await;
    let (fresh, _s2) = pair(&listener).await;
    pool.checkin(key(2), fresh);
    assert_eq!(pool.idle_count(), 1);
    assert_eq!(pool.destinations(), 1);
}

#[tokio::test(start_paused = true)]
async fn the_reaper_stops_when_the_pool_is_dropped() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let pool = Arc::new(Pool::new(None, limits(10, 10)));
    let (conn, _server) = pair(&listener).await;
    Pool::checkin_owned(&pool, key(1), conn);
    let reaper = pool.reaper_handle().expect("spawned on first return");
    drop(pool);
    tokio::task::yield_now().await;
    assert!(reaper.is_finished());
}
