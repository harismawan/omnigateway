# A8 speed investigation, rounds 1–3
- R1 baseline 1k/10k/50002: 2.981/31.692/187.451 ms; split read 36.661, preliminary 66.221, projection 7.793, validation 2.963, final sort 4.723, serialization 61.737 ms.
- R1 f43a486e borrow comparisons →135.138; c2d73919 direct JSON →92.689; 7805401f ASCII/equal →78.516; bf7482f5 collation ranks →71.233 ms (later 94.565); E2E Rust75.8/TS60.4. Report 48b0de37.
- R2 indexed benchmark baseline61.738 →5112834b compact reader49.219 →5108fa28 ranked preliminary43.436 ms; final 1k/10k .621/8.176. Bare stepping9.496 ms; indexed range/order, no temp B-tree.
- R2 split read22.458/preliminary8.987/projection-sort1.450/serialization9.276; E2E Rust79.6/TS66.2, repeat98.7/92.5. f0c5d283 report. Both drivers exact expected counts; 68 test summaries/387 passed/10 ignored; clippy/fmt passed.
- R1 benchmark lacked observed_at index; R2 restored index and exact 8,550,404 bytes, BUT retained rowid/no-affinity table unlike production WITHOUT ROWID. Thus 43 ms was not a production-schema measurement.
## Round 3: no production changes
- Scratch release handler instrumentation: nine medians auth .128, reader acquisition .134, blocking queue .020, function67.593, response construction .002, total handler68.143 ms.
- Function nine ms: 71.488,72.730,62.173,69.377,63.775,63.666,70.682,67.025,67.593.
- Client minus handler nine ms: 8.716,9.780,8.462,7.238,6.051,3.263,4.441,7.707,4.557; median7.238. This includes transport/client processing and work outside handler, not a direct last-byte measurement.
- E2E TS nine ms: 92.0,79.4,72.0,72.9,62.0,63.3,64.5,70.3,63.0; median70.3.
- E2E Rust nine ms: 80.6,82.9,71.1,77.0,70.6,67.3,75.5,75.1,72.7; median75.1. Every response200/8,550,404 bytes.
- Uptime: 16 days9:19, 2 users, load3.38/4.11/4.36. Pre-release free disk5.7GB. Instrumented release copied outside checkout.
- Reproduced file-backed production schema using frozen store, same overflow SQL/nine labels: Rust open_reader nine median58.710 ms (r3-file.log), versus47.363 after changing only sample table to rowid/no-affinity plus observed index (r3-rowid.log).
- File-backed production + driver's faketime environment median57.834 ms (r3-file-faketime.log); no measured slowdown from faketime in this experiment.
- Inference: table layout accounts for ~11.35 ms of benchmark mismatch; gateway67.59 vs standalone58.71 leaves ~8.88 ms not attributed (different runs/host load/allocator/connection state).
- Reader code opens SQLITE_OPEN_READ_ONLY and sets busy_timeout5000, without main-connection WAL/synchronous/foreign-key pragmas. Gateway uses mimalloc; test binary does not. Allocator/WAL/cache effects not isolated.
- Frozen Bun accountQuotaHistory median40.780 ms; JSON.stringify median12.411; combined median53.190. Nine combined:64.378,59.522,53.190,51.370,53.165,53.303,47.203,54.208,52.913; all8,550,404 bytes.
- Frozen script uses actual createStore/accountQuotaHistory, file database and second inserting connection; scratch r3-frozen.ts/log. WAL size/checkpoint timing not captured; do not infer WAL cost.
- Frozen E2E70.3 minus standalone53.19 =17.11 ms is only a cross-run inference, not measured handler overhead.
## Transport observations
- Rust json_ok moves String into Bytes/Full boxed body; no explicit 8.5MB copy. Measured construction .002ms. Accepted sockets set TCP_NODELAY.
- strace first overflow Rust: one writev, two iovecs (146-byte headers +8,550,404-byte body), returned8,550,550. shutdown after1.924ms from syscall entry; close after2.036ms. Other requests show partial writes.
- strace first overflow TS: sendmsg requested127-byte headers +8,550,404-byte body, returned2,661,248; one sendto returned remaining5,889,283. shutdown1.572ms after sendmsg entry, close1.647ms. No observed delayed-close wait in these examples.
- Both deliver contiguous large buffers, not many small frames. Traces: r3-rust.trace/r3-ts.trace. Detailed syscall traces used instead of -c to retain sizes and close timing.
- Traced drivers reached overflow but timed out during overall shutdown/cleanup (120s TS,240s Rust); tracing perturbed timings, excluded from performance conclusions. No complete traced-driver result claimed.
## Evidence / remaining decision
- No measured response-copy or delayed-close cause; no connection handling or production code changed. Scratch instrumentation and benchmark hook removed; git diff showed only unrelated bun.lock before report edit.
- Prior snapshot/driver equality evidence still applies to unchanged production code; no new driver/surface gate claimed this round. Instrumented timing driver completed normally before trace runs.
- Final gates:68 test result: ok summaries,387 passed,10 ignored,no FAILED (r3-tests.log); clippy Finished dev profile in3.41s (r3-clippy.log); fmt exit=0 (r3-fmt.log).
- Logs/script/traces under /tmp/opencode/a8/speed/r3-*. Driver directories removed after preserving handler log. No TS edits; bun.lock and other users' files unstaged.
- Remaining gap is mostly function execution:67.59ms gateway vs corrected standalone58.71, not35ms of response overhead. Production-table read cost merits profiling; no unavoidable floor or end-to-end parity established.
