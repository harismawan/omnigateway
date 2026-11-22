//! Exact queue overlap for a diagnostic build, not a production queue.
//!
//! The probe serializes channel publication and removal against its shadow
//! state. Never hold the lock across an await, SQL work, or result delivery.

use std::collections::{HashMap, VecDeque};

#[derive(Debug, Default, Clone, Copy)]
pub struct QueueProbeStats {
    pub finishes: u64,
    pub finishes_with_queued_optional: u64,
    pub queued_optional: u64,
    /// Same epoch and no intervening seed/fence/barrier. An upper bound:
    /// a batch-size boundary could still put a pending row in an earlier commit.
    pub same_epoch_queued_optional: u64,
    pub shed_optional_with_finish: u64,
    pub shed_optional_unmatched: u64,
    pub shed_tracking_overflow: u64,
    pub accepted_optional: u64,
}

#[derive(Debug)]
pub(super) struct Probe {
    capacity: usize,
    entered_segment: u64,
    queued: HashMap<String, VecDeque<(u64, u64)>>,
    shed: HashMap<String, u64>,
    totals: QueueProbeStats,
}

impl Probe {
    pub(super) fn new(capacity: usize) -> Self {
        Self {
            capacity,
            entered_segment: 0,
            queued: HashMap::new(),
            shed: HashMap::new(),
            totals: QueueProbeStats::default(),
        }
    }

    pub(super) fn boundary(&mut self) {
        self.entered_segment += 1;
    }

    pub(super) fn optional(&mut self, id: String, epoch: u64, accepted: bool) {
        if accepted {
            self.queued
                .entry(id)
                .or_default()
                .push_back((epoch, self.entered_segment));
            self.totals.accepted_optional += 1;
        } else if let Some(n) = self.shed.get_mut(&id) {
            *n += 1;
            self.totals.shed_optional_unmatched += 1;
        } else if self.shed.len() < self.capacity {
            self.shed.insert(id, 1);
            self.totals.shed_optional_unmatched += 1;
        } else {
            self.totals.shed_tracking_overflow += 1;
        }
    }

    pub(super) fn finish(&mut self, id: &str, epoch: u64) {
        let t = &mut self.totals;
        t.finishes += 1;
        if let Some(events) = self.queued.get(id) {
            t.finishes_with_queued_optional += 1;
            t.queued_optional += events.len() as u64;
            t.same_epoch_queued_optional += events
                .iter()
                .filter(|&&pair| pair == (epoch, self.entered_segment))
                .count() as u64;
        }
        if let Some(n) = self.shed.remove(id) {
            t.shed_optional_unmatched -= n;
            t.shed_optional_with_finish += n;
        }
    }

    pub(super) fn dequeue_optional(&mut self, id: &str) {
        let events = self.queued.get_mut(id).expect("published optional event");
        events.pop_front().expect("queued optional event");
        if events.is_empty() {
            self.queued.remove(id);
        }
    }

    pub(super) fn totals(&self) -> QueueProbeStats {
        self.totals
    }
}
