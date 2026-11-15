# Completion drain — fix7, HEAD 3f580317
**Review findings completed:** expired drains no longer evict healthy idle connections; generic local helper calls are covered by the structural guard. Relative to 570d10ff, the only product change is inside checkin_before; all other changes are tests.
the frozen gateway closes the upstream connection after a chunked streaming response whose terminator arrives in a later write; with this change Rust returns it to the pool when the terminator arrives within the bounds — a Rust-only difference

## Latest round
fix7 commits: 0266c69b (admission ordering plus expired/admitted destination-limit tests), 3f580317 (generic helper closure). Admission is decided under the idle lock after the sweep and zero-limit check, before entry creation or eviction. A refused drain leaves the post-sweep idle set untouched (the sweep still removes connections expired by the pool's idle rule). No insertion if the deadline has passed at that decision; executor scheduling can still delay physical close. Kept the smaller make-room-then-push ordering for admitted connections. Removing the new admission conditional/comment makes this function's body byte-identical to 548aed49's ordinary checkin body; None performs the same operations with no extra clock read.
Red-first equivalent of reviewer eviction test: `fix7-red.log`, `drain admission must preserve one idle socket`, left 0/right 1, `test result: FAILED. 0 passed; 1 failed`. Fixed tests verify expired submission preserves the healthy peer without EOF, and admitted submission closes/replaces the old peer while retaining one idle socket. `fix7-drain.log`: 16 passed, including deadline_during_checkin_lock.
Generic fn definitions were already collected; normalisation now drops balanced call turbofish before `(` as well as path generics before `::`. New mutation rows below execute in the same ordinary test suite; real source still produces zero violations, allow-list remains empty.

| Additional fix7 mutation | Caught |
|---|---|
| `allocation_helper::<u8>()`, appended allocating generic definition | yes |
| `Self::allocation_helper::<T>()` / `self.allocation_helper::<T>()` / nested `allocation_helper::<Vec<u8>>()` | yes, all three |

`fix7-tripwire.log`: all four new mutation markers `caught yes`; 3 passed. Remaining limits unchanged: const-expression braces before function bodies, conservative name-only false positives, external callees, macros, trait dispatch, aliases/re-exports and dependency allocations. Minor points retained: mutex-contention test intentionally takes one real second; paused-clock drip observes closure through bounded scheduler yields, not a deterministic reactor-completion guarantee.

### fix7 final-commit gates (supersede historical gates below)
Prescribed offline/shared target/incremental-off/debug-off/jobs=3 environment. Logs under `/tmp/opencode/diag/drain/`. Each final gate log searched for `FAILED`, `panicked`, `^error`: no matches.
- `fix7-tests.log`: exit 0, **61 ok summaries, 337 passed, 5 ignored** including subprocess summaries; final `test result: ok. 1 passed; 0 failed; 0 ignored`, finished in 0.03s.
- `fix7-loop.log`: **RUN 30 PASS**; 90 summaries, **930 passes**, zero ignored. Same fix6 loop commands: gateway connection_reuse + providers lib http::drain_tests + providers body_read_tripwire (12 + 16 + 3 each run).
- `fix7-clippy.log`: exit 0, `Finished dev profile [unoptimized] target(s) in 0.22s` (dev backticked in log).
- `fix7-fmt.log`: `fmt exit=0`.
- `fix7-size.log`: `dispatch concrete state machine bytes=5496`, limit 5500; 1 passed.
- `fix7-unchanged.log`: byte-compared every tracked crates/*/src/* file to 570d10ff, excluding drain_tests.rs and checking pool.rs separately. Pool prefix/suffix outside checkin_before are identical; all other src files, including entire body.rs and its seven request functions, are identical. Ordinary-body comparison with 548aed49 also asserted byte equality after removing admission conditional/comment. Stat: drain_tests.rs 61 added lines, pool.rs 13 touched, body_read_tripwire.rs 36 touched; 3 files, 98 insertions/12 deletions.
Ran red-first eviction regression, fixed drain tests, expanded mutation suite, clippy precheck and all final gates/30 loops. Read rereview2 and r4 eviction/generic-helper/probes scripts and logs; did not execute the reviewer scripts or repeat historical allocation/drip-red measurements. Two append-only commits, no push/merge; report edited separately and not committed.

fix6 commits: 6dd21f3a (item A), a8929731 (item B), 570d10ff (append-only clippy correction: two test unwraps replaced with descriptive expects). No push/merge. Report edited separately, not committed.
Scanner returns function/normalised text/reason violations. It blanks nested comments, ordinary/raw/byte strings and chars while preserving byte offsets/newlines and recognising lifetimes; brace-matches exact function names including generic definitions; removes whitespace and path generic arguments. Same-file helper closure finds no additional required helpers in current source. Real source: zero violations. Allow-list: empty; no allocation spellings waived. `.clone()` is denied (none in scanned functions); reused-buffer reserve/extend_from_slice remain deliberately allowed amortised growth.

| Mutation in next_chunk | Caught |
|---|---|
| `Box::pin(self.read_next())` | yes |
| `std::boxed::Box::pin(..)` | yes |
| `.boxed()` | yes |
| `String::from("x")` | yes |
| `Box::<_>::pin(..)` | yes |
| `Box ::` newline `pin (..)` | yes |
| `Arc::new(1)` | yes |
| `vec![1, 2, 3]` | yes |
| `.to_string()` | yes |
| `Bytes::copy_from_slice(..)` | yes |
| new same-file `sneaky()` containing `Box::new` | yes: unscanned local helper |
| `// }` then `Box::pin` | yes |
| `"}"` then `Box::pin` | yes |
| `/* } /* nested */ } */` then `Box::pin` | yes |
| `'}'` then `Box::pin` | yes |

All mutations execute in ordinary cargo tests against real source mutated in memory. Separate blanking test covers false signatures in strings, lifetimes, escaped chars, Unicode chars, raw/byte strings and nested comments. `fix6-tripwire.log`: 3 passed; 15 caught markers. Temporary real-source boxing: `fix6-tripwire-red.log`, `reason: "Box::pin"`, `test result: FAILED. 0 passed; 1 failed`; body.rs restored exactly.
Limits: external callees/crates, macro expansions, trait dispatch, aliases/re-exports, dependency allocations and unlisted spellings; ordinary signatures assumed, arbitrary const-generic expressions and Unicode identifiers not parsed. Name-only local-call matching is conservative and can conflate methods on unrelated types. Review remains necessary; this is not runtime allocation measurement.
Slow-drip now sends at 0/40/80 ms, advances only to 100 ms, lets the drain/reactor process closure while keeping the paused clock there, checks observed close time <= start + 100 ms and idle count zero. Bounded 1,000 scheduler yields avoid paused-clock auto-advance; reactor scheduling remains a test limitation. Red mutation removed the outer absolute timeout and gave each fill read a fresh 100 ms timeout (one byte per read in this case). `fix6-drip-red.log`: `peer not closed at absolute drain deadline`; `test result: FAILED. 0 passed; 1 failed`. pool.rs/body.rs restored byte-for-byte.
`hold_idle_for_test` verified `#[cfg(test)]`; retained one-second hold for generous margin on this loaded host rather than introducing a 300 ms scheduling assumption. `fix6-lock.log`: 1 passed, finished in 1.00s.

### fix6 final-commit gates (supersede historical fix5 gates below)
All logs under `/tmp/opencode/diag/drain/`, prescribed offline/shared target/debug-off/incremental-off/jobs=3 environment. Each final gate log searched for `FAILED`, `panicked`, and `^error`: zero matches.
- `fix6-tests.log`: exit 0, 61 ok summaries, **335 passed, 5 ignored**, including subprocess summaries; final `test result: ok. 1 passed; 0 failed; 0 ignored`.
- `fix6-loop.log`: **RUN 30 PASS**, 90 ok summaries, **870 passed**, zero ignored. Each iteration: `cargo test --offline -p omni-gateway --test connection_reuse`, `cargo test --offline -p omni-providers --lib http::drain_tests`, `cargo test --offline -p omni-providers --test body_read_tripwire` (12 + 14 + 3 tests).
- `fix6-clippy.log`: exit 0, `Finished dev profile [unoptimized] target(s) in 0.25s` (log includes backticks around dev).
- `fix6-fmt.log`: `fmt exit=0` for `cargo fmt --all -- --check`.
- `fix6-size.log`: `cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture`; `dispatch concrete state machine bytes=5496` <= 5500; 1 passed.
- `fix6-unchanged.log`: compared bytes of every tracked crates/*/src/* file against `git show 26b5c39b:path`, except drain_tests.rs. All identical, including all seven named request functions and pool.rs. `git diff 26b5c39b..HEAD --stat`: only drain_tests.rs (24 lines touched) and tests/body_read_tripwire.rs (402 lines touched), 379 insertions/47 deletions. Thus no non-test src line changed.
Ran all above, both red mutations, restored-source tests, and final gates. Read reviewer report/mutations.py/mutations.log and historical fix5 evidence; did not rerun the historical allocation measurement or reviewer script. Initial full test invocation hit the tool's 120-second timeout and was rerun to completion; initial loop selected the wrong package before any tests ran, corrected; initial clippy found two unwraps, corrected append-only. Final full gates and 30 loops rerun on 570d10ff.

8aeb5cd1 fixes deadline enforcement, adds six drain cases and the ordinary-test structural guard. 548aed49 removes the C preload and its misleading standalone allocation test, in a separate commit. No preload instructions/references remain in production/test sources.
26b5c39b adds deadline admission under the idle lock; fix7 places that decision after sweeping but before destination entry creation/eviction, so a refused drain leaves the post-sweep idle set untouched. Both early drain checks remain to avoid useless reading/lock waiting. Ordinary check-in passes no deadline and gains no clock read. After the check under the lock passes, make-room and insertion proceed; a connection admitted just before the deadline then lives under the pool's ordinary idle rules. Executor stalls can delay closing. Current pool source imports Tokio Instant for idle timestamps too; deadline comparison explicitly uses tokio::time::Instant::now, not a wall clock.
fix5-red.log: deadline_during_checkin_lock failed with idle count 1, expected 0; fixed test passes. Signalled lock acquisition plus one-second hold against 100 ms deadline reproduces contention without near-limit sleeping; not a paused-clock deterministic test, scheduling remains a limitation.
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
Correction: seven drain unit tests before fix4, 13 after fix4, now **14** including deadline_during_checkin_lock. Original seven: drain_never_terminates; drain_invalid_and_excess_wire; drain_eof; drain_survives_body_handoff; drain_capacity_and_pool_shutdown; pool_shutdown_tasks_joined; finish_without_runtime_closes.
New six: expired_before_first_poll (paused clock); slow_drip_uses_absolute_deadline (paused clock, 40 ms steps); capacity_recovers_after_completion (two waves of 32); runtime_teardown_ends_drains (future-drop counter); excess_initial_buffer_not_adopted; nonreusable_not_adopted.
12 connection integration tests: six original Content-Length/cancellation cases; delayed_chunked_terminator_reuses (signal after complete client response, 1/20); responses_reuse (1/20); concurrent_reuse (five waves of 32); drain_forged_response_isolation; never_terminator_next_request_isolated; drain_eof_completed_client_unaffected (changed credentials, exact own0/own1).
Structural request_body_reads_do_not_allocate scans next_chunk, read_next, fill, fill_or_abort, line, clamp, parse_chunk_size, release. Dispatch size gate unchanged. Poisoned-mutex/task-panic injection is not covered; not requested in this round's committed-case list.

## Final-commit gates — /tmp/opencode/diag/drain/
`fix5-tests.log`: cargo test --offline -p omni-providers -p omni-gateway exit 0; **61 ok summaries, 333 passed, 5 ignored; zero lines containing FAILED or panicked** (includes subprocess summaries).
`fix5-loop.log`: **30/30**, final marker `RUN 30 PASS`; each run all 12 connection tests, 14 drain unit tests and existing tripwire.
`fix5-clippy.log`: exit 0; `Finished dev profile [unoptimized] target(s) in 0.15s`; zero lines starting error.
`fix5-fmt.log`: `fmt exit=0`. `fix5-size.log`: `dispatch concrete state machine bytes=5496`; `test result: ok. 1 passed; 0 failed; 0 ignored`.
`fix5-unchanged.log`: extracted brace-balanced function bodies from git show 548aed49 and working HEAD and asserted byte equality for next_chunk/read_next/fill/fill_or_abort/line/clamp/parse_chunk_size; all seven identical. Read review note and own-probes.patch; ran own regression and gates; did not run reviewer mutation script or new mutation table.
Requested offline/shared target, incremental off, debug=0, jobs=3 used. No push/merge; both round commits append-only.

## Concerns
No TLS/real-provider or CPU benchmark. Executor scheduling still determines physical close latency. Structural guard is deliberately syntactic and complements review, not runtime measurement. Existing synchronized full-dispatch delayed test still needs client completion/signalling within the real production deadline; 30 final loops passed here.
