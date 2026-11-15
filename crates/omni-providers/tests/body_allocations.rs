//! Without the preload this test measures nothing.
//! Run with the malloc-count preload documented in the drain report. The
//! external probe avoids weakening the workspace's Rust unsafe-code ban.
use omni_providers::http::{Client, HttpRequest};
use std::io::{Read, Write};

#[tokio::test]
async fn streaming_body_allocation_count() {
    let n: usize = std::env::var("BODY_CHUNKS")
        .unwrap_or("1000".into())
        .parse()
        .expect("chunks");
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr");
    let (go, wait) = std::sync::mpsc::channel();
    let server = std::thread::spawn(move || {
        let (mut s, _) = listener.accept().expect("accept");
        let mut req = [0; 8192];
        assert!(s.read(&mut req).expect("request") > 0);
        // One backing allocation, held alive by the body throughout measurement.
        let payload = "1\r\nx\r\n".repeat(n + 1);
        s.write_all(
            format!("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{payload}").as_bytes(),
        )
        .expect("write");
        wait.recv().expect("done");
    });
    let c = Client::new();
    let mut r = c
        .send(HttpRequest {
            provider: "test".into(),
            url: format!("http://{addr}/"),
            method: "GET".into(),
            headers: vec![],
            body: String::new(),
            body_encoding: None,
            request_id: None,
        })
        .await
        .expect("send");
    // Warm BytesMut's shared storage; retain the first chunk so splits share it.
    let first = r.body.next_chunk().await.expect("chunk").expect("body");
    // Probe toggles counting when this thread opens these sentinel paths.
    drop(std::fs::File::open("/tmp/opencode/diag/drain/alloc-start"));
    for _ in 0..n {
        assert_eq!(
            r.body
                .next_chunk()
                .await
                .expect("chunk")
                .expect("body")
                .as_ref(),
            b"x"
        );
    }
    drop(std::fs::File::open("/tmp/opencode/diag/drain/alloc-stop"));
    drop(first);
    drop(r);
    go.send(()).expect("signal");
    server.join().expect("server");
}
