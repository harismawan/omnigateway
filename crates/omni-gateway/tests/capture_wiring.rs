#![allow(clippy::unwrap_used)]
use std::sync::Arc;
mod common;

use omni_gateway::body_capture::Collector;
use omni_providers::http::{
    Headers, HttpClient, HttpError, HttpRequest, HttpResponse, ResponseBody,
};

struct Script;

// A scripted HTTP peer emits a complete terminal stream but withholds EOF.
// Dispatch completion (or dropping dispatch) must close it, not await its tail.
#[tokio::test]
async fn dispatch_termination_releases_held_capture_and_writer() {
    use futures_util::StreamExt;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    for mode in ["delayed-tail", "nonclosing", "shutdown", "abandon"] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let peer = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = vec![0; 8192];
            assert!(socket.read(&mut request).await.unwrap() > 0);
            let common::Reply::Http(_, _, chunks) = common::sse_ok(1) else {
                unreachable!()
            };
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
            socket.write_all(chunks.concat().as_bytes()).await.unwrap();
            let mut byte = [0];
            if mode == "delayed-tail" {
                tokio::select! {
                    _ = socket.read(&mut byte) => {},
                    () = tokio::time::sleep(Duration::from_secs(1)) => {
                        socket.write_all(b"TAIL_AFTER_TERMINAL\n\n").await.ok();
                    }
                }
            } else {
                assert_eq!(socket.read(&mut byte).await.unwrap(), 0);
            }
        });
        let f = common::fixture(&["c0"]);
        let h = common::harness(&f, vec![]);
        struct Redirect(std::net::SocketAddr, omni_providers::http::Client);
        impl HttpClient for Redirect {
            fn send(
                &self,
                mut req: HttpRequest,
            ) -> std::pin::Pin<
                Box<dyn std::future::Future<Output = Result<HttpResponse, HttpError>> + Send + '_>,
            > {
                req.url = format!("http://{}/", self.0);
                Box::pin(self.1.send(req))
            }
        }
        let collector = Collector::new(true);
        let deps = h.deps.with_http(collector.wrap(Arc::new(Redirect(
            addr,
            omni_providers::http::Client::new(),
        ))));
        let mut d = omni_gateway::dispatch::dispatch(
            deps,
            omni_gateway::dispatch::Request {
                request: common::chat("m1", true),
                request_id: mode.into(),
                api_key_id: None,
                route_started_at: 0,
            },
        );
        if mode == "abandon" {
            d.events.next().await.unwrap().unwrap();
            drop(d);
        } else {
            while d.events.next().await.is_some() {}
            drop(d);
        }
        tokio::time::timeout(Duration::from_millis(500), collector.settle())
            .await
            .expect("capture persists without provider EOF");
        let artifact = collector.artifact(mode, 0, None);
        let text = omni_ir::jsjson::stringify(&artifact).unwrap();
        assert!(text.contains("\"truncated\":true"), "{mode}: {text}");
        assert!(!text.contains("TAIL_AFTER_TERMINAL"));
        tokio::time::timeout(Duration::from_millis(500), h.writer.close())
            .await
            .expect("shutdown bounded by dispatch termination")
            .unwrap();
        tokio::time::timeout(Duration::from_millis(500), peer)
            .await
            .expect("socket released")
            .unwrap();
    }
}
impl HttpClient for Script {
    fn send(
        &self,
        _: HttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<HttpResponse, HttpError>> + Send + '_>,
    > {
        Box::pin(async {
            Ok(HttpResponse {
                status: 200,
                headers: Headers::new(),
                body: ResponseBody::from_chunks(vec!["data: hello\n\n".into(), "tail".into()]),
            })
        })
    }
}

// Real HTTP ingress, scripted provider transport, actual encrypted repository.

#[tokio::test]
async fn abandoned_adapter_branch_is_drained_before_settle() {
    let collector = Collector::new(true);
    let http = collector.wrap_for(Arc::new(Script), "parent".into());
    // A screened request's classifier finishes first but must not abort the
    // parent transport, just as its calls are excluded from the artifact.
    drop(http.dispatch_scope("classifier"));
    let mut response = http
        .send(HttpRequest {
            provider: "custom".into(),
            url: "http://localhost/".into(),
            method: "POST".into(),
            headers: vec![],
            body: "{}".into(),
            body_encoding: None,
            request_id: Some("parent".into()),
        })
        .await
        .unwrap();
    response.body.start_stream();
    drop(response);
    collector.settle().await;
    let artifact = collector.artifact("req_test", 0, None);
    let text = omni_ir::jsjson::stringify(&artifact).unwrap();
    assert!(text.contains("data: hello\\n\\ntail"), "{text}");
}
