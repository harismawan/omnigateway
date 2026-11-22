use omni_gateway::refresh::{CoordLock, RefreshLock};
use std::sync::Arc;

#[tokio::test]
async fn shared_refresh_guard_releases_only_its_own_lock_on_drop() {
    let coord = Arc::new(omni_coord::MemoryCoord::new(Arc::new(|| 1000.0)));
    let a = CoordLock::new(coord.clone());
    let b = CoordLock::new(coord);
    let held = a
        .acquire("refresh:credential".into())
        .await
        .expect("first holder");
    let waiter = tokio::spawn(async move { b.acquire("refresh:credential".into()).await });
    tokio::task::yield_now().await;
    assert!(
        !waiter.is_finished(),
        "cross-host refresh waits for held lock"
    );
    drop(held);
    let next = tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
        .await
        .expect("release observed")
        .expect("waiter");
    assert!(next.is_some());
}
