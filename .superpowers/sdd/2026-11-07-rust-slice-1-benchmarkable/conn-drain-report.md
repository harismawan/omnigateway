# Completion drain — e441bdc2 + e77e2787
the frozen gateway closes the upstream connection after a chunked streaming response whose terminator arrives in a later write; with this change Rust returns it to the pool when the terminator arrives within the bounds — a Rust-only difference

## Follow-up since e441bdc2
Removed body-inline drain budget and both boxed read futures. Budget now lives in a boxed terminal-only Conn::Finishing wrapper, allocated once by finish_if_ready, removed before pool check-in. Normal Plain/Tls reads have no allocation or new await state.
The inline budget field and bounded-fill await branch grew the dispatch future; boxing read_next had masked that growth. Restoring the original body layout/read futures resolves it: unmodified size gate reports **5496 bytes <= 5500** (`fix3-size.log`).
`git diff 21ccf9be -- body.rs`: next_chunk (216), fill (263), fill_or_abort (272), line (280), read_next (299) are unchanged; release (252) only unwraps the terminal wrapper synchronously. Paths relative to crates/omni-providers/src/http/.
Allocation probe, 1000 buffered one-byte chunks from local TCP, warmed shared backing storage: **21ccf9be: 0; e441bdc2: 1000 (1/chunk); e77e2787: 0**. e441bdc2 fails the <=8 constant allocation assertion with exit 99; baseline/fix pass. Logs: `fix3-alloc-baseline.log`, `fix3-alloc-red.log`, `fix3-alloc-after.log`.
Probe is its own Rust integration binary plus committed tests/support/body_allocations.c Linux/glibc preload: thread-local malloc/calloc/realloc counting, start/stop sentinels. This substitutes for unsafe GlobalAlloc because workspace forbids unsafe Rust. Ordinary cargo test runs socket assertions; allocation assertion requires LD_PRELOAD and ASSERT_ALLOC_CONSTANT=1. See C file build/run instructions.
Baseline measurements temporarily restored the three HTTP source files from each commit in this worktree, then restored working files; no other checkout modified. Not a full historical checkout build.

## Step 0 (20 sequential streamed requests per row)
| Terminator D | frozen f9cc6678 sockets | Rust 21ccf9be sockets |
|---|---:|---:|
| 0 ms (separate timer callback) | 20 | 20 |
| 20 ms | 20 | 20 |
| 200 ms | 20 | 20 |
| 2 s | 20 | 20 |
| never | 20 | 20 |
Frozen: zero sockets open when each batch finished. Rust never batch: one open at sampling, zero after another 100 ms and subsequent 1 s/5 s waits. No incomplete socket reused; exact closure latency not measured.
Driver `/tmp/opencode/diag/drain/fix2-observe.ts`; logs `fix2-frozen.log`, `fix2-baseline.log`. Raw TCP custom chat-completions origin, seeded virtual model/restart; hello/DONE checked. Baseline existing bin/fix-21ccf9be identity not independently verified.

## Ownership, bounds, close conditions
body.rs:169 finish polls without waiting, then hands pending reusable body to pool after removing its strong pool reference. Request drop cannot cancel drain.
Pool-owned JoinSet holds <=32 tasks, no queue; completed handles reaped at adoption, weak pool reference in tasks; pool drop aborts all. No runtime or poisoned task mutex: immediate close.
Conn::Finishing enforces 64 KiB total wire budget including initial buffered remainder; bounded scratch-buffer read adds no heap allocation. Deadline 100 ms from adoption; capacity excess closes immediately.
Close: nonreusable/missing pool, excess initial buffer, exhausted wire budget, malformed framing, read error, EOF before framing completes, timeout, capacity, unavailable runtime, failed Weak upgrade, shutdown.
release retains reusable/empty-buffer checks; buffered forged bytes close; unchanged still_idle rejects socket-resident excess bytes/EOF on checkout. Pre-existing unsolicited-data-after-checkout race remains.
Preterminal cancellation/errors unchanged; keys, expiry, TLS configuration unchanged. No dependency or unsafe Rust added.

## Complete test list
Original six Content-Length/cancellation integration tests retained; synchronized delayed_chunked_terminator_reuses: complete client response precedes terminator signal, 1 socket/20 requests. Original red log `fix2-red.log`: 0 passed/1 failed, idle-pool wait expired.
Responses tests: responses_reuse (1/20), concurrent_reuse (five barrier waves of 32, exact response sets/32 sockets), drain_forged_response_isolation (different credentials, exact own0/own1).
New never_terminator_next_request_isolated: first complete response precedes signal, drain timeout closes first socket, second accept returns own1 with changed credential. drain_eof_completed_client_unaffected: same sequence with signalled upstream EOF; no late client error.
Unit tests: drain_never_terminates; drain_invalid_and_excess_wire (payload and framing wire budget, malformed framing, forged bytes); drain_eof; drain_survives_body_handoff; drain_capacity_and_pool_shutdown (40 handoffs, exactly 32 retained).
New pool_shutdown_tasks_joined: drop actual Client, task-future Drop guard counter goes 1→0 within outer timeout; socket also closes. finish_without_runtime_closes: runtime creates socket then exits context, finish outside runtime closes with no task/panic.
streaming_body_allocation_count plus external preload proves regression red/green. New follow-up lifecycle tests were not individually run red first.

## Final commit gates — logs /tmp/opencode/diag/drain/
`fix3-tests.log`: cargo test --offline -p omni-providers -p omni-gateway exit 0; **61 ok summaries, 326 passed, 5 ignored, no FAILED** (includes subprocess summaries).
`fix3-loop.log`: **20/20**, final marker `RUN 20 PASS`; each run all 12 connection tests and all eight drain unit tests.
`fix3-clippy.log`: exit 0; `Finished dev profile [unoptimized] target(s) in 2.72s` (Cargo backticks omitted).
`fix3-fmt.log`: `fmt exit=0`. `fix3-size.log`: `dispatch concrete state machine bytes=5496`, test result ok, 1 passed.
Requested offline/shared target, incremental off, debug=0, jobs=3 used. Worktree clean after e77e2787, no push/merge.

## Concerns / limits
No TLS/real-provider or CPU benchmark. Allocation probe isolates buffered body-reader work, not transport refills or encoded output; Linux/glibc-specific, not automatically active in ordinary cargo test. Terminal completion uses one boxed wrapper and a 16 KiB stack scratch read/copy; normal reads unchanged. Tokio deadline requires executor scheduling; no hard real-time claim.
