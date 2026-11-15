# Completion drain — e441bdc2 (partial test coverage)
Remaining requested tests: `never_terminator_next_request_isolated`, `drain_eof_completed_client_unaffected`, `pool_shutdown_tasks_joined`, `finish_without_runtime_closes`. Timeout/EOF/shutdown currently have lower-level socket tests, not all requested integration/task-count assertions.

## Step 0 (20 sequential streamed requests per row)
| Terminator D | frozen f9cc6678 sockets | Rust 21ccf9be sockets |
|---|---:|---:|
| 0 ms (separate timer callback) | 20 | 20 |
| 20 ms | 20 | 20 |
| 200 ms | 20 | 20 |
| 2 s | 20 | 20 |
| never | 20 | 20 |
Frozen: zero sockets open when each batch finished, including never. Rust: never batch had one still open at sampling; zero after another 100 ms, and zero after subsequent 1 s and 5 s waits. No incomplete socket reused. Exact closure latency was not measured.
Driver: `/tmp/opencode/diag/drain/fix2-observe.ts`; logs `fix2-frozen.log`, `fix2-baseline.log` in that directory. Raw TCP origin, custom chat-completions credential, directly seeded virtual model, gateway restart; every response checked for hello and DONE. Initial missing cost metadata was corrected before these counts.
Baseline used existing `/tmp/opencode/bench-gate/bin/fix-21ccf9be`, not a newly rebuilt baseline binary; binary-to-source identity was not independently verified here.

## Design and close conditions
Paths below are relative to `crates/omni-providers/src/http/`.
`body.rs:172–216`: synchronous ready poll retained; pending reusable body handed to pool with its strong pool reference removed. Request/adapter can drop immediately; task owns body and only Weak<Pool>.
`pool.rs:172–196`: pool-owned JoinSet, one task per body, max 32, no queue. Completed handles reaped at adoption; retained handles also bounded to 32. JoinSet drop aborts tasks. Chosen for explicit ownership and bounded task storage without new dependencies.
64 KiB wire budget includes buffered remainder and chunk framing (`body.rs:173–178,277–288`); bounded reads cannot exceed remaining budget. 100 ms deadline measured from adoption (`pool.rs:178,190–193`).
Close: nonreusable or missing pool (`body.rs:194–201`); excess initial buffer/budget (`175–176,282–283`); read error (`286`, drain exits at `207`); EOF before framing (`fill_or_abort`, `292–297`); malformed chunk framing (existing `read_next`/`parse_chunk_size`); timeout (`pool.rs:193`).
Close: capacity 32 reached (`pool.rs:185–187`), absent runtime (`179–180`), poisoned task mutex (`182–183`), pool shutdown (JoinSet drop), failed weak upgrade (`body.rs:209–214`). No runtime means close, no spawn.
Release uses unchanged reusable + empty-buffer checks (`body.rs:255–262`). Buffered forged bytes close there; socket-resident unsolicited bytes/EOF rejected by unchanged `pool.rs:95–104` still_idle at checkout. Pre-existing unsolicited-data-after-checkout race remains.
Preterminal cancellation/errors still drop body without adoption. Pool keys, expiry, TLS, still_idle unchanged; no unsafe or dependencies added.

## Tests and red evidence
`connection_reuse.rs`: original six Content-Length/cancellation tests unchanged; delayed test unignored, upstream terminator explicitly signalled only after complete client response, then idle-pool observation before next request: 1 socket/20.
Red: `/tmp/opencode/diag/drain/fix2-red.log`: `test result: FAILED. 0 passed; 1 failed; 0 ignored` (idle-pool wait expired). Other new tests were not run red first.
Additional committed integration cases: custom Responses 1/20; five barrier-synchronized waves of 32, exactly 32 sockets and exact own response sets; post-handoff forged response rejected, second request uses different credential and returns exactly own1. Adapter response drops at End in these probes.
`drain_tests.rs`: never terminates closes; >64 KiB payload and wire-framing budget close; malformed chunk close; buffered forged bytes close; upstream EOF close; handoff survives; 40 simultaneous handoffs retain exactly 32 slots, overflow sockets close; dropping pool destroys Weak ownership and all peer sockets close within outer deadline.
Shutdown test proves socket/owner cleanup, not explicit joins or task-finished counter. Never/EOF tests do not directly assert a subsequent completed gateway response. No no-runtime regression test added.
Not covered: TLS traffic, real providers, performance/allocation benchmark, exact deadline under executor starvation.

## Final-commit gates (all logs under /tmp/opencode/diag/drain/)
`cargo test --offline -p omni-providers -p omni-gateway`: exit 0, `fix2-tests.log`; 60 `test result: ok` summaries, total 321 passed, 5 ignored, no FAILED line (includes subprocess summaries).
Last line: `test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s`.
Flakiness: `fix2-loop.log`: 20/20 runs passed; each runs all 10 connection integration tests and all six drain unit tests; final marker `RUN 20 PASS`.
Clippy all-targets -D warnings: exit 0, `fix2-clippy.log`: `Finished dev profile [unoptimized] target(s) in 3.95s` (Cargo log includes backticks).
Fmt: `fix2-fmt.log`: `fmt exit=0`.
Build used requested offline/shared target, incremental off, debug=0, jobs=3. Worktree clean after commit; no push/merge.

## Concerns
Adding drain bookkeeping grew the dispatch future beyond its existing 5500-byte ceiling. Boxing read_next in next_chunk restored the unmodified size gate; introduces an allocation per call, including normal streaming. Needs performance review; no throughput claim made. Bounded fill also boxes its future.
Full requested test matrix is incomplete as listed above; this is a passing partial implementation, not an assertion that every requested acceptance criterion was independently proved.
