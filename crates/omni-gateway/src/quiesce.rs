//! Admission belongs to the response lifetime, including streaming and cancellation.
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default)]
struct State {
    closed: bool,
    active: usize,
}
#[derive(Default)]
pub struct Quiesce {
    state: Mutex<State>,
    idle: tokio::sync::Notify,
}
pub struct Admission(Arc<Quiesce>);

impl Drop for Admission {
    fn drop(&mut self) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.active -= 1;
        if state.active == 0 {
            self.0.idle.notify_waiters();
        }
    }
}

impl Quiesce {
    pub fn enter(self: &Arc<Self>) -> Option<Admission> {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.closed {
            return None;
        }
        state.active += 1;
        Some(Admission(self.clone()))
    }
    pub fn is_closed(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .closed
    }
    pub fn open(&self) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .closed = false;
    }
    pub async fn close(&self, deadline: Duration) -> (bool, usize) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .closed = true;
        let drain = async {
            loop {
                let idle = self.idle.notified();
                tokio::pin!(idle);
                idle.as_mut().enable();
                if self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .active
                    == 0
                {
                    return;
                }
                idle.await;
            }
        };
        let _drained = tokio::time::timeout(deadline, drain).await.is_ok();
        let active = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .active;
        (active == 0, active)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn drain_deadline_and_resume() {
        let latch = Arc::new(Quiesce::default());
        let request = latch.enter().expect("admitted");
        assert_eq!(latch.close(Duration::ZERO).await, (false, 1));
        assert!(latch.enter().is_none());
        drop(request);
        assert_eq!(latch.close(Duration::from_secs(1)).await, (true, 0));
        latch.open();
        let request = latch.enter().expect("resumed");
        let closing = tokio::spawn({
            let latch = latch.clone();
            async move { latch.close(Duration::from_secs(1)).await }
        });
        tokio::task::yield_now().await;
        assert!(latch.is_closed());
        assert!(!closing.is_finished());
        drop(request);
        assert_eq!(closing.await.expect("drain"), (true, 0));
    }
}
