//! A writer with no room must cost the request path nothing but a counter.
//!
//! `WriterHandle::send` returning `false` means the event was dropped and
//! counted in `dropped`; the writer task reports those drops in one warning
//! per `drop_warn_interval` ("metric + rate-limited warn"). In the bench the
//! request path also wrote one WARN line per dropped event — ~25k lines/s,
//! 311 MB in ten minutes — from the worker threads, under stdout's lock.

mod common;

use std::sync::{Arc, Mutex};

use common::*;
use futures_util::StreamExt as _;
use omni_gateway::dispatch::{Request, dispatch};
use omni_gateway::finish::Finisher;
use omni_gateway::logging::TsFormat;
use tracing::Level;
use tracing_subscriber::layer::SubscriberExt as _;

fn capture() -> (Arc<Mutex<Vec<String>>>, tracing::subscriber::DefaultGuard) {
    let lines = Arc::new(Mutex::new(Vec::new()));
    let seen = lines.clone();
    let layer = TsFormat::with_sink(Level::DEBUG, move |l| {
        seen.lock().expect("lines").push(l.to_owned());
    });
    let guard = tracing::subscriber::set_default(tracing_subscriber::registry().with(layer));
    (lines, guard)
}

fn req(id: &str) -> Request {
    Request {
        request: chat("m1", true),
        request_id: id.to_owned(),
        api_key_id: Some("k1".into()),
        route_started_at: 1000,
    }
}

#[tokio::test(flavor = "current_thread")]
async fn dropped_log_events_write_no_line_per_request() {
    let f = fixture(&["c0"]);
    let replies = (0..50).map(|_| sse_ok(1)).collect();
    let h = harness(&f, replies);
    let handle = h.deps.writer.clone();
    // A closed writer refuses every event, as a full one does.
    h.writer.close().await.expect("close");

    let (lines, _guard) = capture();
    for i in 0..50 {
        let mut d = dispatch(h.deps.clone(), req(&format!("req_{i}")));
        while d.events.next().await.is_some() {}
        let mut fin = Finisher::new(
            handle.clone(),
            format!("req_{i}"),
            1000,
            "openai",
            omni_gateway::clock::now_ms,
        );
        fin.complete(false, None);
    }

    // Every Begin and every Finish was refused and counted...
    assert_eq!(handle.dropped(), 100);
    // ...and none of them wrote a line of its own.
    let lines = lines.lock().expect("lines");
    let per_event: Vec<&String> = lines
        .iter()
        .filter(|l| l.contains("writer full") || l.contains("health write dropped"))
        .collect();
    assert!(
        per_event.is_empty(),
        "{} per-event lines, e.g. {:?}",
        per_event.len(),
        per_event.first()
    );
}
