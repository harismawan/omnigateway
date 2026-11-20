//! Best-effort committed identity notifications. A bounded queue keeps store
//! reads off request tasks; the version poll repairs any missed notification.
use omni_coord::Coord;
pub(crate) use omni_gateway_core::snapshot::RoutingChange;
use omni_gateway_core::snapshot::SnapshotHolder;
use std::sync::Arc;
use tokio::sync::mpsc;

const TOPIC: &str = "routing";

#[derive(serde::Serialize, serde::Deserialize)]
struct Envelope {
    from: String,
    change: RoutingChange,
}

#[derive(Clone)]
pub(crate) struct Routing(mpsc::Sender<(bool, RoutingChange)>);

impl Routing {
    pub(crate) fn committed(&self, change: RoutingChange) {
        self.queue(true, change);
    }

    fn queue(&self, local: bool, change: RoutingChange) {
        if self.0.try_send((local, change)).is_err() {
            tracing::debug!("routing queue unavailable; version poll will catch up");
        }
    }

    pub(crate) fn start(
        coord: Arc<dyn Coord>,
        node: String,
        store: Arc<omni_store::Store>,
        holder: Arc<SnapshotHolder>,
    ) -> (Self, omni_coord::Subscription, tokio::task::JoinHandle<()>) {
        let (tx, mut rx) = mpsc::channel(512);
        let routing = Self(tx);
        let sub = coord.subscribe(
            TOPIC,
            Arc::new({
                let routing = routing.clone();
                let node = node.clone();
                move |_, raw| {
                    if let Ok(message) = serde_json::from_str::<Envelope>(raw)
                        && message.from != node
                    {
                        routing.queue(false, message.change);
                    }
                }
            }),
        );
        let task = tokio::spawn(async move {
            while let Some((local, change)) = rx.recv().await {
                if local
                    && let Ok(wire) = serde_json::to_string(&Envelope {
                        from: node.clone(),
                        change: change.clone(),
                    })
                {
                    coord.publish(TOPIC, &wire).await;
                }
                if holder
                    .apply_postgres_change(store.clone(), change)
                    .await
                    .is_err()
                {
                    tracing::warn!("routing patch failed; version poll will retry");
                }
            }
        });
        (routing, sub, task)
    }
}
