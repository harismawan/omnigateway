mod common;

#[tokio::test]
async fn dispatch_state_machine_size() {
    let f = common::fixture(&["c0"]);
    let h = common::harness(&f, vec![]);
    let d = omni_gateway::dispatch::dispatch(
        h.deps.clone(),
        omni_gateway::dispatch::Request {
            request: common::chat("m1", true),
            request_id: "size".into(),
            api_key_id: Some("k1".into()),
            route_started_at: 1000,
        },
    );
    let bytes = std::mem::size_of_val(d.events.as_ref().get_ref());
    eprintln!("dispatch concrete state machine bytes={bytes}");
    // x86_64 regression ceiling: baseline 5304, unboxed OAuth/dual-send 5776.
    #[cfg(target_arch = "x86_64")]
    assert!(
        bytes <= 5500,
        "dispatch state machine grew to {bytes} bytes"
    );
    drop(d);
    h.writer.close().await.expect("close");
}
