# Completion drain — final HEAD 548aed49
the frozen gateway closes the upstream connection after a chunked streaming response whose terminator arrives in a later write; with this change Rust returns it to the pool when the terminator arrives within the bounds — a Rust-only difference

## Latest round
8aeb5cd1 fixes deadline enforcement, adds six drain cases and the ordinary-test structural guard. 548aed49 removes the C preload and its misleading standalone allocation test, in a separate commit. No preload instructions/references remain in production/test sources.
Deadline now checked at start and before check-in; a stalled executor can delay closing but can no longer cause a late check-in. timeout_at remains responsible for pending reads, but its inner-first polling cannot bypass the absolute-deadline checks.
Regression red: `/tmp/opencode/diag/drain/fix4-red.log`, `expired_before_first_poll`: `test result: FAILED. 0 passed; 1 failed`; paused clock advanced past adoption deadline, ready terminator was wrongly salvaged and socket-close wait expired. Fixed test passes without wall-clock sleeps.
Structural red: `fix4-tripwire-red.log`, `next_chunk: forbidden Box::pin: match Box::pin(self.read_next()).await {`; `test result: FAILED. 0 passed; 1 failed`. Scratch boxing restored afterward; standing guard passes in ordinary suite.
measured once with a temporary malloc-counting preload, since removed: 0 allocations for 1,000 chunks at e77e2787, 1,000 at e441bdc2
Standing guard: tests/body_read_tripwire.rs plus unchanged dispatch size gate, **5496 <= 5500 bytes**. Explicit reader/helper names, denied allocation spellings, exact-site justified allow-list (currently empty), stale-exception check. Cannot see allocations inside callees in other files, macro expansions or unlisted spellings; not an allocation proof.
Earlier e77e2787 removed inline drain state and boxed read futures; terminal-only Conn::Finishing budget wrapper is unwrapped before check-in. Normal next_chunk/read_next/fill/fill_or_abort/line remain baseline code, no per-read boxing.

## Step 0 (20 sequential streamed requests per row)
| Terminator D | frozen f9cc6678 sockets | Rust 21ccf9be sockets |
|---|---:|---:|
| 0 ms (separate timer callback) | 20 | 20 |
| 20 ms | 20 | 20 |
| 200 ms | 20 | 20 |
| 2 s | 20 | 20 |
| never | 20 | 20 |
Frozen: zero sockets open when each batch finished. Rust never batch: one open at sampling, zero after another 100 ms and subsequent 1 s/5 s waits. No incomplete socket reused in this observation; exact closure latency not measured.
Driver `/tmp/opencode/diag/drain/fix2-observe.ts`; logs `fix2-frozen.log`, `fix2-baseline.log`. Raw TCP custom chat-completions origin, seeded model/restart; hello/DONE checked. Existing baseline binary identity not independently verified.

## Ownership, bounds, close conditions
ResponseBody::finish_if_ready polls without waiting, hands pending reusable body to pool after removing strong pool reference. Request drop cannot cancel drain.
Pool-owned JoinSet holds <=32 tasks, no queue; reaps completed handles at adoption; tasks hold Weak pool. Pool drop aborts all. No runtime or poisoned task mutex: immediate close.
Conn::Finishing enforces 64 KiB HTTP-wire budget including initial buffer; deadline 100 ms from adoption. Terminal wrapper has one allocation and a 16 KiB stack scratch read/copy; ordinary Plain/Tls reads unchanged.
Close: nonreusable/missing pool, excess initial buffer, exhausted wire budget, malformed framing, read error, premature EOF, timeout/expired check, capacity, missing runtime, failed Weak upgrade, shutdown.
a connection is returned only at a message boundary with nothing buffered, and unsolicited bytes that arrive before the next checkout cause it to be discarded; as with any keep-alive reuse, the origin answers the next request on that socket
Preterminal cancellation/errors, keys, expiry, TLS configuration and still_idle unchanged. No dependency or unsafe Rust added.

## Committed coverage
Correction: seven drain unit tests before this round, now **13**. Original seven: drain_never_terminates; drain_invalid_and_excess_wire; drain_eof; drain_survives_body_handoff; drain_capacity_and_pool_shutdown; pool_shutdown_tasks_joined; finish_without_runtime_closes.
New six: expired_before_first_poll (paused clock); slow_drip_uses_absolute_deadline (paused clock, 40 ms steps); capacity_recovers_after_completion (two waves of 32); runtime_teardown_ends_drains (future-drop counter); excess_initial_buffer_not_adopted; nonreusable_not_adopted.
12 connection integration tests: six original Content-Length/cancellation cases; delayed_chunked_terminator_reuses (signal after complete client response, 1/20); responses_reuse (1/20); concurrent_reuse (five waves of 32); drain_forged_response_isolation; never_terminator_next_request_isolated; drain_eof_completed_client_unaffected (changed credentials, exact own0/own1).
Structural request_body_reads_do_not_allocate scans next_chunk, read_next, fill, fill_or_abort, line, clamp, parse_chunk_size, release. Dispatch size gate unchanged. Poisoned-mutex/task-panic injection is not covered; not requested in this round's committed-case list.

## Final-commit gates — /tmp/opencode/diag/drain/
`fix4-tests.log`: cargo test --offline -p omni-providers -p omni-gateway exit 0; **61 ok summaries, 332 passed, 5 ignored, no FAILED** (includes subprocess summaries).
`fix4-loop.log`: **30/30**, final marker `RUN 30 PASS`; each run all 12 connection tests and all 13 drain unit tests.
`fix4-clippy.log`: exit 0; `Finished dev profile [unoptimized] target(s) in 0.19s` (Cargo backticks omitted).
`fix4-fmt.log`: `fmt exit=0`. `fix4-size.log`: `dispatch concrete state machine bytes=5496`; `test result: ok. 1 passed; 0 failed; 0 ignored`.
Requested offline/shared target, incremental off, debug=0, jobs=3 used. No push/merge; both round commits append-only.

## Concerns
No TLS/real-provider or CPU benchmark. Executor scheduling still determines physical close latency. Structural guard is deliberately syntactic and complements review, not runtime measurement. Existing synchronized full-dispatch delayed test still needs client completion/signalling within the real production deadline; 30 final loops passed here.
