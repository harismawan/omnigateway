//! Barrier accounting without locks: which events a barrier's prefix holds,
//! and how many of them were dropped, decided by an epoch.
//!
//! **Producers take no blocking lock.** An event's producer:
//! 1. `e = epoch.load()`;
//! 2. `started[e].fetch_add(1)`;
//! 3. `epoch.load()` again: if it is no longer `e`, a barrier bumped it in
//!    between, so it undoes step 2 (`started[e].fetch_sub(1)`) and starts over
//!    with the new epoch. It has published nothing yet, so undoing is free.
//!    This is lock-free, not wait-free: successive barriers can cause
//!    arbitrarily many retries for a preempted producer;
//! 4. publishes the event tagged `e` (`try_send`), or on failure counts it in
//!    `dropped[e]`;
//! 5. `done[e].fetch_add(1)`.
//!
//! **A barrier** (one at a time) uses two slots, `e % 2`, whose counters only
//! ever grow; epochs `e`, `e - 2`, … share a slot:
//! 1. waits until the *other* slot is settled (`done == started`): every
//!    producer of the previous epoch (and older ones in that slot) has
//!    finished, also if the previous barrier was cancelled or refused before
//!    it settled;
//! 2. reads that slot's `done` and `dropped`: epochs `..E-1` of it, final;
//!    epoch `E+1` does not exist yet;
//! 3. `E = epoch.fetch_add(1)`: the prefix is every event of epoch `E` and
//!    earlier;
//! 4. waits until slot `E` is settled; it then holds epochs `E`, `E-2`, …,
//!    final (epoch `E+2` cannot exist before the next barrier);
//! 5. publishes itself (`try_send`), behind every published event of the
//!    prefix.
//!
//! Every wait is asynchronous (yielding), inside the caller's timeout, and
//! cancelling one leaves nothing to undo: the next barrier's step 1 waits out
//! whatever the cancelled one left.
//!
//! The writer counts committed and failed events against their exact epoch
//! tag (events of `E+1` can be ahead of the barrier too), and folds epochs
//! `..=E` into the answer when it reaches barrier `E`.

//! **Why the prefix is exact.** Every operation is `SeqCst`, so they all sit in
//! one total order (step numbers below are the barrier's). Take a producer whose event is tagged `E` (it kept `e = E`).
//! Its (producer) step-3 load read `E`, so that load precedes the barrier's
//! bump, and its step-2 increment precedes that load. So every kept
//! `started[E]` increment precedes the bump, and the barrier's step-4 reads,
//! which follow the bump, see all of them. An undone
//! increment is matched by its decrement, which may come after the bump; until
//! then, if observed by settlement, `started[E]` reads one too high,
//! `done[E]` cannot match it, and the barrier keeps waiting. A stray may
//! instead arrive after successful settlement reads. A producer's step-5 increment follows its publish
//! or its drop, so once `done[E] == started[E]` every `E` event is either in
//! the queue or counted in `dropped[E]`, all before the barrier publishes
//! itself. The writer handles the queue in order, so when it reaches the
//! barrier it has resolved every `E` event (and every earlier epoch's) and
//! counted each as committed or failed against its tag. Events of epoch `E+1`
//! may also be ahead of the barrier; they count against the other slot, not
//! this prefix.
//!
//! So, over epochs `..=E`, `done == committed + failed + dropped`, exactly:
//! the barrier's answer (`done`, which only kept and finished events reach,
//! not `started`, which a stray may briefly raise).
//!
//! **Strays.** A producer whose step-3 load sees a bump undoes its step-2
//! increment. If observed by the settlement read, that increment makes
//! `started` read high and delays settlement until undone. A stray arriving
//! after that read is harmless: it cannot validate the old epoch or publish
//! an event tagged with it. `done` itself is never raised by a stray.
//!
//! A stray increment (step 2, then undone in step 3) can only make `started`
//! read high, never low: `done` only grows after a kept increment. So
//! the settlement reads cannot accept an unfinished validated producer.
//! They do not exclude a late stray after the `started` read; that stray
//! only retries, and an observed outstanding stray delays a later settlement.
//!
//! **What waits.** Only the barrier, and only for producers already between
//! steps 1 and 5 of epoch `E`: a `try_send` and a few atomics each.

use std::sync::atomic::{AtomicU64, Ordering::SeqCst};

/// One slot's counters; started also decreases on retries.
#[derive(Debug, Default)]
pub(crate) struct Slot {
    pub(crate) started: AtomicU64,
    pub(crate) done: AtomicU64,
    pub(crate) dropped: AtomicU64,
}

/// A prefix's producer-side totals: events finished, and dropped among them.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Produced {
    pub(crate) events: u64,
    pub(crate) dropped: u64,
}

impl Produced {
    pub(crate) fn plus(self, o: Self) -> Self {
        Self {
            events: self.events + o.events,
            dropped: self.dropped + o.dropped,
        }
    }
}

impl Slot {
    /// Events are counted by `done`: a stray (see the module docs) may raise
    /// `started` at any time, `done` only a kept, finished event.
    fn read(&self) -> Produced {
        Produced {
            events: self.done.load(SeqCst),
            dropped: self.dropped.load(SeqCst),
        }
    }

    fn settled(&self) -> bool {
        self.done.load(SeqCst) == self.started.load(SeqCst)
    }
}

#[derive(Debug, Default)]
pub(crate) struct Epochs {
    epoch: AtomicU64,
    slots: [Slot; 2],
}

/// A producer's place in an epoch: taken by [`Epochs::enter`], finished by
/// [`Epochs::leave`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Entered(pub(crate) u64);

impl Epochs {
    pub(crate) fn current(&self) -> u64 {
        self.epoch.load(SeqCst)
    }
    fn slot(&self, epoch: u64) -> &Slot {
        &self.slots[usize::from(epoch % 2 == 1)]
    }

    /// Producer steps 1–3.
    pub(crate) fn enter(&self) -> Entered {
        loop {
            let e = self.epoch.load(SeqCst);
            let slot = self.slot(e);
            slot.started.fetch_add(1, SeqCst);
            if self.epoch.load(SeqCst) == e {
                return Entered(e);
            }
            slot.started.fetch_sub(1, SeqCst);
        }
    }

    /// Producer steps 4 (the drop half) and 5.
    pub(crate) fn leave(&self, at: Entered, dropped: bool) {
        let slot = self.slot(at.0);
        if dropped {
            slot.dropped.fetch_add(1, SeqCst);
        }
        slot.done.fetch_add(1, SeqCst);
    }

    /// Barrier step 1's test: the previous epoch's slot has settled.
    pub(crate) fn previous_settled(&self) -> bool {
        self.slot(self.epoch.load(SeqCst) + 1).settled()
    }

    /// Barrier steps 2–3: the previous epochs' totals, and the epoch whose
    /// events complete this barrier's prefix. Call only once
    /// [`Self::previous_settled`], and with no other barrier in flight.
    pub(crate) fn bump(&self) -> (u64, Produced) {
        let e = self.epoch.load(SeqCst);
        let before = self.slot(e + 1).read();
        self.epoch.fetch_add(1, SeqCst);
        (e, before)
    }

    /// Barrier step 4's test.
    pub(crate) fn settled(&self, e: u64) -> bool {
        self.slot(e).settled()
    }

    /// The prefix's producer side, once epoch `e` has settled.
    pub(crate) fn prefix(&self, e: u64, before: Produced) -> Produced {
        self.slot(e).read().plus(before)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One barrier, synchronously (tests spin where the writer yields).
    fn barrier(ep: &Epochs) -> (u64, Produced) {
        while !ep.previous_settled() {
            std::hint::spin_loop();
        }
        let (e, before) = ep.bump();
        while !ep.settled(e) {
            std::hint::spin_loop();
        }
        (e, ep.prefix(e, before))
    }

    /// The straggler interleaving, step by step: a producer reads epoch 0,
    /// a barrier bumps, the producer increments `started[0]` late, sees the
    /// bump, undoes, and re-enters epoch 1. Barrier 0 never counts it.
    #[test]
    fn a_producer_racing_the_bump_moves_to_the_next_epoch() {
        let ep = Epochs::default();
        let e = ep.epoch.load(SeqCst);
        let (b, before) = ep.bump();
        assert_eq!((e, b), (0, 0));
        ep.slot(e).started.fetch_add(1, SeqCst);
        assert!(!ep.settled(0), "a stray not yet undone holds the barrier");
        assert_ne!(ep.epoch.load(SeqCst), e);
        ep.slot(e).started.fetch_sub(1, SeqCst);
        assert!(ep.settled(0));
        assert_eq!(ep.prefix(0, before), Produced::default());
        let at = ep.enter();
        assert_eq!(at, Entered(1));
        ep.leave(at, true);
        assert_eq!(ep.slot(1).dropped.load(SeqCst), 1);
    }

    /// A producer inside the epoch at the bump holds the barrier until it
    /// leaves, and is counted in the prefix.
    #[test]
    fn a_producer_inside_the_epoch_is_waited_for_and_counted() {
        let ep = Epochs::default();
        let at = ep.enter();
        let (e, before) = ep.bump();
        assert_eq!((at, e), (Entered(0), 0));
        assert!(!ep.settled(0));
        ep.leave(at, true);
        assert!(ep.settled(0));
        assert_eq!(
            ep.prefix(0, before),
            Produced {
                events: 1,
                dropped: 1
            }
        );
    }

    /// A barrier cancelled after its bump (never settled, never answered)
    /// leaves the next barrier to wait its epoch out; the next prefix still
    /// holds everything.
    #[test]
    fn a_cancelled_barrier_is_covered_by_the_next() {
        let ep = Epochs::default();
        let a = ep.enter();
        let (e0, _) = ep.bump(); // cancelled here: epoch 0 unsettled
        assert_eq!(e0, 0);
        let b = ep.enter(); // epoch 1
        ep.leave(b, false);
        assert!(!ep.previous_settled(), "epoch 0 still has a producer");
        ep.leave(a, true);
        let (e, p) = barrier(&ep);
        assert_eq!(e, 1);
        assert_eq!(
            p,
            Produced {
                events: 2,
                dropped: 1
            }
        );
    }

    /// Prefixes are cumulative across slot reuse.
    #[test]
    fn answers_are_cumulative_across_slot_reuse() {
        let ep = Epochs::default();
        let mut want = Produced::default();
        for (epoch, events, drops) in [(0_u64, 3_u64, 1_u64), (1, 2, 0), (2, 4, 2), (3, 0, 0)] {
            for i in 0..events {
                let at = ep.enter();
                assert_eq!(at, Entered(epoch));
                ep.leave(at, i < drops);
            }
            want = want.plus(Produced {
                events,
                dropped: drops,
            });
            assert_eq!(barrier(&ep), (epoch, want));
        }
    }

    /// A stray that lands in a slot after its epoch settled holds that
    /// slot's next barrier until it is undone, and leaves no trace.
    #[test]
    fn a_late_stray_in_a_reused_slot_is_waited_out() {
        let ep = Epochs::default();
        let stale = ep.epoch.load(SeqCst); // a producer that read epoch 0
        assert_eq!(barrier(&ep).0, 0);
        assert_eq!(barrier(&ep).0, 1);
        // Epoch 2 uses slot 0; the stray lands there now.
        ep.slot(stale).started.fetch_add(1, SeqCst);
        let at = ep.enter();
        assert_eq!(at, Entered(2));
        ep.leave(at, false);
        let (e, before) = ep.bump();
        assert_eq!(e, 2);
        assert!(!ep.settled(2), "the stray holds the barrier");
        ep.slot(stale).started.fetch_sub(1, SeqCst);
        assert!(ep.settled(2));
        assert_eq!(ep.prefix(2, before).events, 1);
    }

    /// Eight producer threads entering and leaving (a third dropping) while
    /// barriers run for 2 s: every barrier's prefix equals what the producers
    /// themselves tagged with its epoch and earlier.
    #[test]
    fn concurrent_producers_and_barriers_agree_with_each_producers_tally() {
        use std::collections::HashMap;
        use std::sync::Arc;
        use std::sync::atomic::AtomicBool;
        let ep = Arc::new(Epochs::default());
        let stop = Arc::new(AtomicBool::new(false));
        let producers: Vec<_> = (0..8)
            .map(|p| {
                let ep = Arc::clone(&ep);
                let stop = Arc::clone(&stop);
                std::thread::spawn(move || {
                    let mut tally: HashMap<u64, (u64, u64)> = HashMap::new();
                    let mut n = 0u64;
                    while !stop.load(SeqCst) {
                        let at = ep.enter();
                        let drop = (n + p).is_multiple_of(3);
                        if n.is_multiple_of(64) {
                            std::thread::yield_now();
                        }
                        ep.leave(at, drop);
                        let t = tally.entry(at.0).or_default();
                        t.0 += 1;
                        t.1 += u64::from(drop);
                        n += 1;
                    }
                    tally
                })
            })
            .collect();
        let mut answers = Vec::new();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while std::time::Instant::now() < until {
            answers.push(barrier(&ep));
        }
        stop.store(true, SeqCst);
        let mut by_epoch: HashMap<u64, (u64, u64)> = HashMap::new();
        for t in producers {
            for (e, (n, d)) in t.join().expect("producer") {
                let x = by_epoch.entry(e).or_default();
                x.0 += n;
                x.1 += d;
            }
        }
        let mut want = Produced::default();
        for (e, got) in &answers {
            let (n, d) = by_epoch.get(e).copied().unwrap_or_default();
            want = want.plus(Produced {
                events: n,
                dropped: d,
            });
            assert_eq!(*got, want, "epoch {e}");
        }
        assert!(answers.len() > 100, "{} barriers", answers.len());
        assert!(want.events > 100_000, "{} events", want.events);
    }
}
