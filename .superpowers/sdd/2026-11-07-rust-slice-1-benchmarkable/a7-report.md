# A7 — fix round 2 complete for review

## Fix round 2

**Status: fix round 2 complete for review.** Final implementation/test commit `d0c11d29`. Evidence root **`/tmp/opencode/a7-fix2/`**. Independent review `a7-r1-review.md` read completely; this section supersedes round-1 cursor/latency/lane descriptions. No jobs outstanding; unrelated files, stash, roadmap and other worktrees untouched.

| Finding | Commit | Test and independent RED |
|---|---|---|
| R1 decoded cursor | `7af16d7e` | `cursor-red.log`: 17 equal/12 failures against round-1 binary. `cursor-{boundary,final,middle,replacement-order,rounded-at}.log`: each 23 equal/0 failures. Both roles and anonymous, interactive logs plus CSV/JSONL |
| M4 cancelled opener permit | `394f9341`, harness lint `d0c11d29` | Deterministic single-blocking-worker unit test queues opener then cancels its async caller: `open-red.log` sees all four permits incorrectly available; `open-green.log` passes, opener retains one until drained |
| Nodes report lane | `394f9341` | `nodes.log` 29 equal/0 failures; final full nodes fixture passes. Routing/isolation change verified by code; no independent failing behavioral test for nodes was executed |
| Latency statistic | `2a509db6` | `latency-red.log` fails pre-fix `/tmp/opencode/a7-final/rust-final`; `latency-green.log` 17 equal/0 failures; full final rerun passes |
| Chunk CRLF validation | `5876f99c` | `framing-red.log` self-check fails on malformed `1\r\naXX0\r\nYY`; fixed self-check plus nodes comparison `framing-green.log` 29/0. Also rejects malformed final delimiter `0\r\nYY` |

### Cursor semantics

Boundary cells are captured without strict text decoding; conversion to the next-query binding happens only when a sentinel establishes another page. TEXT is decoded lossily, integer cells convert through f64 as Bun JS numbers, BLOB retains bytes, NULL remains NULL. No strict UTF-8 conversion can fail cursor extraction, and an exactly-full final page computes no next cursor. Cached statement rows and transaction reset remain unchanged.

`cursor-decoded-boundary` reproduces review fixture: 499 rows at 100.5, invalid `0xFF` ID at 99, last row at 98. TS and Rust now return **501** JSONL rows; interactive page 500 rows. Exactly-full final fixture returns **500** rows. Middle invalid ID also matches. `replacement-order` changes boundary bytes to `0xC0`: TS binds U+FFFD (UTF-8 EF BF BD), which sorts above stored C0, so the boundary row appears again on the next page. Both export **502 rows from 501 stored rows**, identical response bytes; no deduplication is introduced. `rounded-at` covers integer 9007199254740993 rounding on interactive boundary values; export range's safe-integer maximum excludes those high timestamps in both gateways, so that fixture is not evidence of traversing such timestamps through export. Fractional/long/BLOB and prior export cases rerun in full driver.

An initial build error (`Value::from(ValueRef)` unsupported) caused an exploratory run to reuse the old artifact; corrected build and all five final targeted comparisons passed. Those initial reused-artifact failures are not extra regression findings.

### Permits, lane scope, known limits

Report-opening task now owns the permit and returns `(store, permit)` together. Cancellation cannot release its slot while the blocking open remains queued/running. Nodes now acquires the independent report lane like usage/logs, after authorization; config reads remain on control. Export retains round-1 per-page pool behavior.

Readers are read-only with **the same 5000ms busy timeout**, not the same pragmas: foreign_keys and synchronous are not set on readers; this does not affect SELECT. Both semaphore queues have **unlimited waiter count and waiting time**. One waiting future retains request/query state and a semaphore waiter but no reader connection; cancellation removes it. Four active tasks is not a total request-memory bound. TS has no corresponding semaphore bound. Accepted M2 pins and separately deferred outbound idle timeout remain exactly as documented below; no new difference pinned.

### Latency gate and results

15 loaded samples, each taken while an export is open, alternating with idle samples of the identical `/api/logs?limit=1` request. Each sample cycle closes its export and allows 300ms for a cancelled page to finish before the next idle probe. Rust **loaded median ≤10ms** is the gate; TS uses the same statistic for recording. Either gateway's **idle median >10ms fails inconclusive**, never passes. Individual scheduler outliers do not trigger the latency assertion. Status, open-export, committed real-request rows, checkpoint and framing assertions remain.

| Run | Rust loaded / idle median ms | TS loaded / idle median ms |
|---|---|---|
| Pre-fix RED (`latency-red/`) | **58.691 / 1.883** | **0.956 / 1.571** |
| Final (`final/admin-routes-last/`) | **2.021 / 2.388** | **0.654 / 1.266** |

Raw 15-sample arrays retained in `slow-reader-{rust,ts}.json`. No retry-until-green or bound relaxation was used for this statistic.

### Final gates

Fresh TS built outside checkout and fresh Rust copied outside checkout to **`/tmp/opencode/a7-fix2/final/{ts,rust}`**. Manifest **`final/manifest.json`**, commit **`d0c11d299df0e7ef0ab49cb9ccde4197b393e99c`**, TS SHA256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`, Rust `dd6095affdd10633ce0f17cadd99d4a402b9dcdb6c279b9015fd4fdb4cdf57cf`. Manifest written before last driver runs. Same prior commands, paths switched to a7-fix2/final; output directories/logs suffixed `-last`. CARGO_INCREMENTAL=0, DEV/TEST DEBUG=0; drivers MIMALLOC_PURGE_DELAY=1, admin-routes port 19443. All runs finished and results read.

| Gate | Result | Log under `final/` |
|---|---|---|
| cargo test --offline --workspace | **1050 passed, 0 failed, 7 ignored** | `workspace-last.log` |
| cargo clippy --offline --workspace --all-targets -- -D warnings | clean | `clippy-last.log` |
| cargo fmt --all -- --check | clean | `fmt-last.log` |
| admin-routes | **2768 equal / 10 expected / 0 failures** | `admin-routes-last.log` |
| admin-auth | **212 equal / 4 expected / 0 failures** | `admin-auth-last.log` |
| surface | **606 equal / 61 expected / 0 failures** | `surface-last.log` |
| run.ts | **all rows equal** | `run-last.log` |

Initial Clippy flagged ignored channel Results in the new cancellation test; `d0c11d29` asserts them, then every gate and fresh build was rerun. Own recorded scratch roots removed (`removed-scratch.json`).

## Fix round 1

**Status: fix round 1 complete for review.** Final implementation `3702b018`; this section supersedes the older stream-lifetime permit description and unresolved-M2 status below. M2 is now explicitly accepted by the owner. No other new difference was pinned. No jobs outstanding.

### Final per-page pool design and verification

`3702b018` replaces stream-lifetime export leases with **at most four pooled read-only SQLite connections**. Every page acquires a semaphore permit, takes an idle connection (or opens one lazily within the bound), steps/decodes/encodes on the blocking pool, returns the connection, then releases its permit **before returning encoded bytes to the body**. A started blocking task owns its RAII lease even if its async caller disconnects; it finishes at most that page and returns the connection. Cancellation while waiting acquires nothing. Pool connections stay open for reuse; their presence after disconnect is intentional, not a held lease. No statement/transaction remains active between pages. Typed raw cursors allow any pooled connection to serve the next page. `prepare_cached` now reuses statements per pooled connection. Separate usage/log four-permit lane and config connection remain independent.

A stalled client holds encoded response bytes/socket state and its cursor, **no reader lease or permit**. More exports can proceed regardless of that client's socket progress. Admission can briefly wait for an active page, never for an earlier client's consumption. SQL/encoding errors return the lease too; the RAII guard also returns it during unwinding.

New driver test was independently **RED** on the old binary: `page-red.log`, fifth export blocked behind four stalled clients past 5 seconds. New build GREEN `page-export-bounds.log`; permanent test completes a fifth while four stop reading, then eight concurrent exports and eight after disconnect. Bound mutant (eight permits) independently RED in `page-mutant.log`: eight export connections observed. This replaces the obsolete five-slot mutation check; old shared-lane mutant evidence remains historical, while the current permanent test exercises usage/log reads with four stalled exports. No new shared-lane mutant claim.

Final `page-final/admin-routes-retry/bounds-rust.json`: fifth completes **239.593ms**, eight concurrent and eight post-disconnect completed. Export WAL descriptor peak **10**, baseline **6**, hence **four** pooled readers. Usage **1115.442ms**, 500-row logs **32.654ms**, one-row logs **1.880ms**, all within the independent-lane 2000ms test bound. These are distinct from the tight single-export 10ms test.

### Checkpoint, export bytes and final gates

TRUNCATE assertion now uses **at most 50 nonblocking attempts, 20ms between attempts** (~1s retry budget plus execution/scheduling). Test resets fixture busy_timeout to zero during these probes and restores it afterward; export must still be open when checkpoint succeeds. Final Rust succeeds on attempt **3**, TS on **1**. The previously failed checkpoint overlapped possible active page/writer work; old logs do not identify the exact lock holder, so no stronger causal attribution is made.

Targeted post-change `page-export-{bounds,volume-1,volume-2,volume-3,matrix}.log`: **11 / 17 / 17 / 17 / 173 equal**, zero failures. The final full driver reruns all matrices and three 30,000-row byte comparisons. Final disconnect **1 page at close, 2 after settling**, follow-up **200**. Final hard 10ms slow-reader samples Rust **2.009 / 1.838 / 1.703ms**; TS **0.725 / 0.605 / 0.827ms**, three committed real request rows and export still open.

Fresh outside-checkout artifacts under **`/tmp/opencode/a7-fix1/page-final/`**, manifest **`page-final/manifest.json`**, implementation commit **`3702b0183da74929924889e7188bf1545faa8429`**. TS SHA256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`; Rust `802505944ebfaeda9ac8778a17296bfc657da31c62a34c158ba087c72cd62666`. Same build/driver commands documented below with directory `page-final`, admin-routes output `admin-routes-retry`. All Rust builds/tests incremental=0, DEV/TEST debug=0. Drivers MIMALLOC_PURGE_DELAY=1; admin-routes port 19443. Manifest written before drivers.

| Gate on final implementation | Result | Log under `page-final/` |
|---|---|---|
| workspace offline tests | **1049 passed / 0 failed / 7 ignored** | `workspace.log` |
| workspace all-target Clippy -D warnings | clean | `clippy.log` |
| fmt --all --check | clean | `fmt.log` |
| admin-routes | **2653 equal / 10 expected / 0 failures** | `admin-routes-retry.log` |
| admin-auth | **212 equal / 4 expected / 0 failures** | `admin-auth.log` |
| surface | **606 equal / 61 expected / 0 failures** | `surface.log` |
| run.ts | **all rows equal** | `run.log` |

First full attempt `page-final/admin-routes.log` failed **TS** slow-reader latency at 95.096ms (Rust volume process had not started). Unchanged final retry passed; threshold was not relaxed. Both attempts retained. Own recorded failed-driver scratch roots removed (`page-final/removed-scratch.json`).

### Known differences and deferred work

- **Accepted M2**, eight exact HEAD-export pins: HEAD has no body, header describes GET framing only, repository issues no HEAD export requests, matching requires replacing Hyper's HTTP/1 response encoder. Each pin's `why` carries that reason; no response masks or additional pins introduced.
- Preexisting two admin-routes expected differences, four admin-auth and 61 surface expected differences unchanged.
- Outbound idle timeout is a separate owner-assigned roadmap item across response kinds, not fixed here. Retained script **`/tmp/opencode/a7-fix1/stall/stall.ts`**, `stall/{ts,rust}.json`: TS closes ~**256.226s**, Rust still open at **330s**. With per-page leases this cannot monopolize export permits. Roadmap file untouched.
- Usage memory improvement and five-process before/after tables below remain applicable; this change does not alter usage serialization.

### Historical checkpoint evidence (superseded where stated above)

### Finding → commit → test

Evidence paths below relative to **`/tmp/opencode/a7-fix1/`**.

| Finding | Commit | Evidence / RED status |
|---|---|---|
| Export contention + hard 10ms slow-reader bound | `ed3dc1c7` | `profile2.log` independently RED at 172.412ms; isolation/roundtrip removal GREEN. Final 1.873–2.363ms, hard 10ms unchanged |
| Usage/log shared-control exposure | `0fca2fdc` | `reports-red2.log` RED; `reports-green.log` GREEN. `5deab832` samples concurrent reads five times, bounds median at 10ms to avoid single scheduler outliers; distinct from the slow-reader hard per-call bound |
| I1 raw typed cursor | `b3061657` | fractional `cursor-red.log` RED; fractional/long/BLOB GREEN. Only fractional independently failed before fix |
| I2 nonfinite CSV | `b2e6f9e9` | `nonfinite-red2.log` 15 equal/2 failures → `nonfinite-green2.log` 17/0 |
| M1 JS-whitespace limit | `5deab832` | `m-red-logs.log` 215 equal/2 failures → `m-green-logs.log` 217/0. U+FEFF plus other whitespace/non-whitespace cases |
| M3 method-aware HEAD normalization | `5deab832` | `m3-red.log` throws invalid chunk header on TS; subsequent HEAD driver completes. Also rejects incomplete GET chunk framing |
| M2 HEAD export header | **unfixed**, pins in `5deab832` | `m-red-head-reports.log` 75 equal/8 failures. HEAD four routes × three roles, valid/invalid and empty/nonempty CSV/JSONL; eight success HEAD exports differ only in TE. Pins are documented evidence, not a fix |
| Connection bounds + independent usage/log lane | `c04a176f` | `bounds-1.log`, `resume-export-bounds.log`, final driver GREEN. Existing implementation passed; deliberately broken five-slot build fails `bounds-mutant-five-slots.log`; shared-lane mutant fails `bounds-mutant-shared-lane.log`. No independent cancellation-bug RED claimed |
| Usage memory | `8de0229b`, lint-only `5b0a2bae` | Five complete before runs establish excessive peak; five after runs per binary byte-equal. `resume-usage.log` 449/0, `resume-usage-large.log` 11/0 before commit. Three unit tests passed before/after refactor; no changed response behavior intended |
| Alternate fixture port | `2d02753c` | `port-{usage-traffic,credential-identity,credentials}.log`: 9/75/179 equal; final whole driver on 19443/upstream 19444. No 18444 literal remains |
| Page timing detail | `b99278f9` | `timing-volume.log` 17/0; final per-page preparation, stepping/collection, carrier decoding separately recorded |

### Connection-bound behavior and evidence

Final `final/admin-routes-last/bounds-{rust,ts}.json`: four Rust export WAL descriptors above baseline (6 → 10); fifth receives **no response headers or body** until a permit is available. No extra reader is opened while waiting. After one finishes, fifth first byte arrives **48.374ms** later. After a disconnect, next waiting export starts in **29.652ms**; with a previously abandoned waiter ahead of it, **34.955ms**. Bound 1000ms. All clients dropped: WAL descriptors return to baseline in **21.260ms**. Main database descriptors may remain cached by SQLite's POSIX-locking VFS after connection close; WAL descriptors count active read connections. Main descriptors grow at most baseline + eight (four exports plus four report readers), observed 6 → 14.

Usage/logs/nodes/keys and invalid export requests complete while four exports plus a waiter remain open, for admin and viewer. Eight simultaneous usage/log requests also finish (166.737ms total). Other-report individual bound 2000ms; usage 99.112/400.444ms, 500-row logs ~30ms, one-row logs ~1.9ms. These are not the separate tight slow-reader 10ms test.

TS has no export permit cap: fifth, sixth, seventh already receive bytes before another finishes/disconnects. This is an observable latency difference, and a Rust client may hit its own timeout waiting. Neither queue length nor wait time has a new explicit cap. A scratch fully stalled-client experiment (`stall/{ts,rust}.json`, script retained) also found TS closes its server socket ~256.226s after inactivity, while Rust remained open through 330s. This preexisting outbound idle-timeout difference can prolong permit occupancy; it is a concern, not a passing timeout-parity test.

### Usage memory — five fresh processes per gateway before and after

Linux VmHWM in kB, same **300,000 rows / 70,000 buckets** fixture, three large usage responses per process (contention request plus viewer/admin comparisons). No release-vs-debug mixing: Rust dev build, incremental off, debug info off. Direct binaries outside checkout. Runs with default allocator settings do **not** use `scripts/run-rust-gateway.sh`; additional batches explicitly inherit **MIMALLOC_PURGE_DELAY=1**, the script's policy, into both gateways. No claim that environment variable controls TS's allocator.

| Policy / phase | Rust five peaks (kB) | Rust range | TS range |
|---|---|---|---|
| Default before (`mem/before-{1..5}`) | 269444, 264104, 239428, 268420, 263320 | **239428–269444** | **153172–157592** |
| Default after (`mem/after-{1..5}`) | 66216, 57848, 66224, 58268, 68940 | **57848–68940** | **153384–155884** |
| Purge=1 before (`mem/before-purge1-{1..5}`) | 255140, 268300, 268700, 253952, 269276 | **253952–269276** | **142380–144028** |
| Purge=1 after (`mem/after-purge1-{1..5}`) | 65096, 56632, 56068, 67856, 56996 | **56068–67856** | **140788–144172** |

Every one of these 40 gateway runs completed its comparison: each paired run 11 equal, zero failures. All five after Rust peaks are below every corresponding TS peak, with either allocator policy. Early `mem/base-*` attempts included two aborted runs due to single-sample contention bounds and are **not** the five-run baseline; initial `before-*` fixture harness attempts were rerun after allowing TS its single blocking sample. Summary files and per-process `usage-large-*-rss.txt` retain individual values.

Cause (`mem/probe-before.log`, `probe-after.log`): `JsValue` 32 bytes, field pair 56; tree requested **94,330 KiB in 1,050,003 allocations**. Keys replicated as owned UTF-16 per bucket, oversized field vectors, boxed string storage, and carrier overhead dominate. This is about 15 allocations/bucket for this split fixture (the product comment's 23/25 estimate overcounts; measured recursive allocation count is authoritative). Tree build adds ~109,204 KiB RSS in the scratch default-allocator control test. Stringification additionally builds **14,572,240-byte** JSON with 16,777,216-byte capacity; it does **not** clone the whole tree. Tree and response string coexist. Response `String` moves to `Bytes`/Full, without a second response-body copy. Scratch peak **132,700 → 26,204 KiB**, after dropping output **113,932 → 7,384 KiB**. These scratch tests use the test allocator, not gateway mimalloc.

Gateway `mem/steps-*.json` separately demonstrates retention: original default-policy RSS after four sequential answers reaches 265,076 KiB and stays there after 1.5s idle; purge=1 does not guarantee immediate reclamation on idle allocation threads. Optimized default-policy fourth response RSS 79,664 KiB, purge=1 64,660 KiB. The structural fix avoids building/freeing that million-allocation carrier tree, writes one bucket at a time on the blocking reader thread, and moves one completed string into the HTTP body. SQLite still aggregates, memory still scales with buckets/output, and no new cardinality cap was introduced. All direct probe response hashes match TS (`9d13e1571856a32f…`, full SHA in `steps-*.json`).

### Final export and page measurements

Final full driver includes export-matrix, 30,000-row byte comparisons three configurations × CSV/JSONL × roles, fractional/long/BLOB cursors, nonfinite CSV, disconnect, connection saturation and hard slow-reader bound.

`final/admin-routes-last/disconnect-rust.json`: pages at close **1**, after 500ms **2**, follow-up **200**. `slow-reader-rust.json`: **1.989 / 1.873 / 2.363ms**, idle **1.272–2.372ms**; TS **1.438 / 1.342 / 1.024ms**. Both three real committed request rows and export still open; hard **10ms** per call.

261 final page events: prepare **112–769µs**, combined query/decode **152–56132µs**, stepping+collection **59–21279µs**, decoding **90–53950µs** (includes tiny final/one-row pages). First full page: prepare **648µs**, step/collection **6512µs**, decode **22262µs**; second prepare **132µs**, step/collection **6206µs**, decode **27743µs**. Stepping is measured as combined elapsed minus timed decoding, so includes binding/collection overhead, not pure SQLite CPU. Prepared statement caching could save sub-ms preparation per page, small relative to decoding/stepping; not implemented.

### Final gates on `5b0a2bae` (passed, with M2 pins explicitly noted)

All logs under `final/`; fresh TS built with `bun scripts/build-binary.ts /tmp/opencode/a7-fix1/final/ts`; Rust `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo build --offline -p omni-gateway`, copied to `/tmp/opencode/a7-fix1/final/rust`. Both outside checkout. `manifest.json` records full commit and both SHA256 hashes before drivers. Driver environment MIMALLOC_PURGE_DELAY=1; admin-routes A7_TEST_PORT=19443. Invocation `bun conformance/e2e/NAME.ts --ts /tmp/opencode/a7-fix1/final/ts --rust /tmp/opencode/a7-fix1/final/rust --out /tmp/opencode/a7-fix1/final/NAME`; admin-routes output uses `admin-routes-last`; run.ts omits --out.

| Gate | Result | Log |
|---|---|---|
| `cargo test --offline --workspace` | **1049 passed, 0 failed, 7 ignored**, 117 suite summaries | `workspace-last.log` |
| `cargo clippy --offline --workspace --all-targets -- -D warnings` | clean | `clippy.log` |
| `cargo fmt --all -- --check` | clean | `fmt-last.log` |
| admin-routes | **2653 equal, 10 expected, 0 failures** (8 new M2 pins + 2 prior) | `admin-routes-last.log` |
| admin-auth | **212 equal, 4 expected, 0 failures** | `admin-auth.log` |
| surface | **606 equal, 61 expected, 0 failures** | `surface.log` |
| run.ts | **all rows equal** | `run.log` |

First Clippy found `ok().expect()` in new test, fixed in `5b0a2bae`. First full driver (`admin-routes.log`) failed a WAL checkpoint busy assertion during Rust slow export. Targeted `volume-retry.log` and final full driver passed unchanged: a transient active page/writer can overlap checkpoint; no claim that the first failure was disproved. Prior snapshot timing failure was addressed by preexisting `614dfa35`; final workspace passed. Own failed-run scratch roots located from this task's logs were removed; list `removed-scratch.json`. No running commands remain.

---

## Final hand-off (supersedes all historical NEXT STEP sections below)

Status: **complete for review**. Final implementation commit `e9a89479`; subsequent report-only commit records these results. No frozen TS product files, unrelated working changes, stash, or other worktrees changed.

| Requirement | Commit(s) | Permanent tests / independent RED |
|---|---|---|
| Usage schemas, roles, grouping, raw/daily reads | `6d2a7a8e` | usage HTTP missing-route RED; duplicate parameter mismatch RED; final usage matrix |
| Usage store extraction, volume, offsets, raw cells | `89ecdb01` | coverage passed before refactor; no behavioral RED |
| Logs guarded reader, paging/filter/cursor and real usage traffic | `598f5aaa` | logs 80 equal/150 failures → 155/0; real traffic coverage had only a test-cookie error |
| Typed bound store parameters | `73c918de` | existing corpus; structural change, no RED |
| Provider/cursor/schema and BLOB coercion parity | `ca1f39f0` | 39/20 → 53/0; BLOB degradations independently RED; traversal coverage already passed |
| Cursor identity and Infinity errors | `dc3bcce7` | Infinity 49/4 → 53/0; surrogate identity already passed |
| Streamed export and validation | `abfb8cac` | missing route 26/42 → 47/0 |
| Export matrix, empty framing, 30k rows × three runs | `466757c1` | BLOB CSV and empty JSONL framing RED; volume coverage already passed |
| Disconnect page-read cancellation proof | `3fb6e78b` | permanent export-volume-1 socket test; missing instrumentation RED (`disconnect-red.log`); GREEN 17/0; no cancellation bug found |
| Slow-reader real traffic and admin latency | `40e107b3` | permanent export-volume-1 scenario; behavior already passed. First run's six mismatches were fixture credential UUIDs, fixed by fixture cleanup, not product behavior |
| Nodes store/control/reader-guarded route | `595711d6` | `nodes-red.log` 17 equal/24 failures (missing route); `nodes-self.log` 29/0. Empty/single/several/stale/NULL/BLOB/invalid UTF-8/nonfinite cells, all roles and expected statuses; independent self assertion on each gateway |
| Visible per-page timing | `e9a89479` | console formatter discarded structured timing field; emitted timing in message, final HTTP gates below |

### Final evidence

All paths below relative to `/tmp/opencode/a7-final/`. Fresh TS built with `bun scripts/build-binary.ts /tmp/opencode/a7-final/ts-final`; Rust with `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo build --offline -p omni-gateway`, copied from `target/debug/omnigateway` to `/tmp/opencode/a7-final/rust-final`. Both outside checkout. `manifest.json` records `e9a89479` full commit and SHA256 of both artifacts before drivers. Build logs: `build-{ts,rust}.log`. Earlier targeted tests reused the prior TS artifact and are not the final gate evidence.

| Gate | Result | Log |
|---|---|---|
| `cargo test --offline --workspace` | 1046 passed, 0 failed, 7 ignored | `workspace.log` |
| `cargo clippy --offline --workspace --all-targets -- -D warnings` | clean | `clippy.log` |
| `cargo fmt --all -- --check` | clean | `fmt.log` |
| admin-routes | 2433 equal, 2 expected, 0 failures | `admin-routes.log` |
| admin-auth | 212 equal, 4 expected, 0 failures | `admin-auth.log` |
| surface | 606 equal, 61 expected, 0 failures | `surface.log` |
| run.ts | all rows equal; DB row counts 37/18/6/4 | `run.log` |

Rust gates used CARGO_INCREMENTAL=0 and profile DEV/TEST DEBUG=0. All runs were foreground and completed; results read. One initial 120-second workspace attempt was terminated and rerun to completion. Driver invocation: `bun conformance/e2e/NAME.ts --ts /tmp/opencode/a7-final/ts-final --rust /tmp/opencode/a7-final/rust-final --out /tmp/opencode/a7-final/NAME` for admin-routes/admin-auth/surface; run.ts uses the same binaries without --out. Before the last driver rerun, process log files were cleared: Bun's file redirection otherwise retained old content, which inflated absolute page counts on a repeated output directory. Final disconnect JSON has fresh counts.

### Cancellation, contention and known differences

`admin-routes/disconnect-rust.json`: **1** page completed at socket close, **2** after a 500ms settling interval (at most one additional), follow-up admin status **200**. The raw socket waits for successful export headers plus body bytes then destroys the connection; the permanent check rejects missing Rust instrumentation. TS is exercised for follow-up health but has no page event, so its zero counter is not a cancellation measurement. Existing stream drop behavior needed no fix.

Slow client resumes once per 200ms, pauses after each socket chunk; 30k-row export remains open while three actual `/v1/chat/completions` calls traverse the authenticated stub and three request_logs rows become visible. Permanent per-admin bound: **2000ms**. Final `admin-routes/slow-reader-{rust,ts}.json`: Rust **54.953 / 131.319 / 143.638ms**, TS **0.720 / 0.612 / 0.478ms**. Both have rows=3/exportOpen=true. These are observations on this host, not worst-case guarantees.

Control connection is held for one bounded 500-row page, including SQL read and JSON/CSV encoding, released before yielding to socket backpressure; no stream-long DB transaction/write lock. Debug timing measures this page operation (excluding mutex acquisition, with negligible closure/event overhead outside the timer). Final Rust process logged 247 completed page operations, **50.508–169.166ms** each across cancellation, slow export and full-format comparisons (`admin-routes/export-volume-1-rust.log`). A single page can therefore delay another admin call by up to the remaining page time (observed page maximum ~169ms); Rust's extra page encoding under its control mutex is materially more contention than TS's synchronous page read then row-at-a-time serialization. Observed maximum admin latency excess in this scenario is **142.917ms** (143.638 minus TS maximum 0.720). TS page-operation duration itself was not instrumented; no precise causal or universal worst-case difference is claimed. Request-log writer still progresses independently.

Nodes binds `now - 60000`, strict `seen_at > cutoff`, descending seen_at; preserves raw-cell JSON semantics. Rust node ID is a fresh UUID v4 from `clock::uuid_v4()` in gateway startup; frozen TS uses `crypto.randomUUID()` at startup. They intentionally differ even for the same installation. Fixture comparisons use stable foreign IDs with self=false; an additional per-binary check obtains `/health` nodeId, inserts exactly that row and asserts id and self=true. Future-dated fixtures are relative to driver start, with stale row at 1, avoiding clock-boundary races; heartbeat writing remains outside this route increment.

No new known response mismatch in exercised cases. Existing expected driver divergences remain as described in their logs. Coverage not added: live Postgres, exhaustive malformed cursors, exact 60-second clock boundary, nonfinite numeric CSV formatting, independent TS page timing, long-duration/multi-export contention stress. Earlier volume RSS evidence below remains applicable; no claim of constant usage-report cardinality.

### Roadmap D4 hand-off

Write PgStore readers for **usage, logs, export pages and nodes** matching SQLite typed filter/query interfaces: aggregate raw/daily usage with JS-compatible cells, descending `(at,id)` cursor pages with bound parameters and limit+1, reuse those pages for bounded streaming export, nodes strict now-minus-60s filter/order. No PG reader was added here. Wire backend selection/config into the control handle and gateway so reader operations use a separate PG reader/pool rather than the log writer; preserve first-page errors, guards and lossless serialization. Test against a live unique postgres:17-alpine container (remove afterward), then run all four HTTP route matrices against real TS PG: roles/statuses, filters/cursors, unusual cells/identity, cross-runtime/restart reads, CSV/JSONL bytes, cancellation page count, slow-reader concurrent writer progress and admin latency. SQLite results do not establish PG equivalence.

---

## Historical checkpoints

## Current state — export matrix/volume checkpoint (466757c1)

**NEXT STEP:** implement a debug-level export page-read event and a permanent disconnect test that records reads at socket close and asserts at most one subsequent page, then verifies another admin request. Add slow-reader concurrent real `/v1` traffic with DB row visibility and measured admin latency on both binaries. These two proofs are still missing. Then read frozen `/api/nodes` and maintenance.nodes, implement/test empty/single/stale/unusual rows and self-node identity. Do not mark complete until these pass.

Status: **partial checkpoint, not complete for review**. Usage and logs retain previous coverage. Export has additional adversarial/volume proof; nodes remains unimplemented.

Requirement → commit → test:
- CSV BLOB cell coercion → `466757c1` → `matrix.log` independent RED (TS `"1,2"`, Rust `[object Object]`) → `matrix-final.log` GREEN. Store now preserves CSV-specific BLOB string conversion before JSON round-trip; JSON output remains indexed objects.
- Empty JSONL HTTP framing → same commit → `matrix-green.log` independent RED (TS Content-Length 0 vs Rust chunked) → final GREEN. Empty response uses an exact-size empty body.
- All supported log filters, roles, empty results, comma/quote/CR/LF/formula/tab/non-ASCII/invalid UTF-8, NULL, numeric text, BLOB → same commit → matrix **173 equal / 0 failures** (initial **161 equal / 12 failures**, intermediate **167 / 6**). Other cases were coverage, not independent RED.
- 30,000-row CSV and JSONL, each admin/viewer/anonymous, three fresh process runs → same commit → `volume-{1,2,3}.log`, **17 equal / 0 failures each**; no independent RED. Caller invalid cursor and limits 1/2 plus repeated format fields are ignored/overridden across all 60 pages as TS does. Export strips *all* cursor/limit/format entries before appending server limit, and subsequent cursors are generated base64url, so caller paging cannot override later pages.

RSS evidence `/tmp/opencode/a7-accept/volume-{1,2,3}/export-volume-N-{ts,rust}-rss.txt`: TS VmHWM **86,160–88,044 kB** (86,160 / 88,044 / 87,172), Rust **40,140–40,556 kB** (40,140 / 40,556 / 40,260). Each process serves both formats; these are combined process peaks, not independently attributed format peaks. Payload comparisons are byte-equal after HTTP dechunking and validated dynamic filename masking. Preliminary runs reused previous TS artifact; final gates rebuilt both binaries.

Final gates at `466757c1`, evidence `/tmp/opencode/a7-accept/`: workspace **1046 passed / 0 failed / 7 ignored** (`workspace.log`), workspace all-target clippy clean (`clippy.log`), fmt clean (`fmt.log`). Fresh outside-checkout binaries, commit/SHA256 recorded before drivers in `manifest.json`. Admin-routes **2404 equal / 2 expected / 0 failures**; admin-auth **212 equal / 4 expected / 0 failures**; surface **606 equal / 61 expected / 0 failures**; run.ts **all rows equal** (matching log names). All foreground runs finished and results read. Incremental/debug disabled.

Known differences/concerns: no mismatch in exercised matrix; disconnect page counts, slow-reader writer/admin latency and nodes not done. Control mutex remains per page including encoding (500 rows), never whole stream; TS synchronously reads a page then serializes rows while yielding. Relative worst-page admin blocking has **not** been measured. Nonfinite numeric CSV remains untested. D4: add PG readers for usage, logs/export pages, nodes; wire backend selection into control and gateway, then live-PG HTTP, restart/cross-runtime reads, scalar/identity and streaming concurrency conformance. Historical state below is superseded by this section.

## Latest: cursor identity closed; initial streamed export

**NEXT STEP:** finish export verification before nodes: permanent three-run tens-of-thousands-row CSV/JSONL byte comparisons with RSS ranges; instrument page reads to count post-disconnect work; concurrent slow export plus real `/v1` log commit and admin-read latency assertions; full filter/escaping/unusual-cell matrix. Export implementation is present but these acceptance requirements are still unverified. Then `/api/nodes`.

| Requirement | Commit | Evidence (`/tmp/opencode/a7-export/`) |
|---|---|---|
| Lone-surrogate cursor at same timestamp as U+FFFD/ASCII/astral neighbors | `dc3bcce7` | Real TS matches existing lossy binding; canonical cursor comparison passes. Comment pins Bun UTF-8 boundary. No identity bug/RED |
| ±Infinity input errors and cursor mutations | `dc3bcce7` | `identity-red.log` 49 equal / 4 failures → `identity-green.log` 53/0; Infinity was behavioral RED |
| Guarded CSV/JSONL export and errors | `abfb8cac` | `red.log` 26 equal / 42 failures (missing route) → `green2.log` 47/0 |

Frozen behavior discoveries: absent format defaults CSV; unknown format rejects with 400. Both time bounds required. **Caller cursor is ignored**, even malformed, and caller limit overridden to 500, exactly as frozen `exportLogs` does; the handler's unreadable-cursor comment is inaccurate. Export reads the first page before returning a response. CSV column order/header/CRLF, JSONL LF, formula guard, comma/quote escaping and filename/content headers match the exercised fixture. Filename timestamp is validated near-now before masking. Driver now decodes HTTP chunk framing before payload comparison (chunk boundaries/hex case are transport details).

Streaming implementation: first page fetched before Response; subsequent pages pulled by async body stream, each yielding at most one 500-row encoded chunk. No whole-export collection. Control mutex held **per page** including page serialization, released before yielding/backpressure; no explicit read transaction spans pages. TS reads a page synchronously with SQLite `.all()`, then yields rows; neither holds a reader across stream consumption. Dropping Rust stream stops future loop iterations; an already-running blocking page operation may complete. This is implementation reasoning, **not measured cancellation proof**. Current page encoder serializes/parses the bounded page JSON before formatting; memory is page-sized but less efficient than direct row encoding. No RSS range or slow-client writer-progress result claimed.

Final gates at `abfb8cac`: fresh TS/Rust binaries outside checkout; commit/hashes recorded before drivers in `manifest.json`. Workspace **1046 passed / 0 failed / 7 ignored** (`workspace.log`); workspace all-target clippy clean (`clippy.log`); fmt clean (`fmt.log`). Admin-routes **2180 equal / 2 expected / 0 failures**; admin-auth **212 equal / 4 expected / 0 failures**; surface **606 equal / 61 expected / 0 failures**; run.ts **all rows equal** (matching log names). Builds incremental/debug disabled.

Status: **partial export checkpoint, not complete for review**. Remaining concerns: export adversarial encoding matrix (notably nonfinite numeric CSV values), strict chunk-framing validation in test driver, measured cancellation/page counts, three-run memory and concurrent writer proof. No known mismatch in exercised cases. D4 still owns PG report readers/backend selection/live conformance. Historical next-step sections below are superseded.

## Latest continuation: typed reader and log parity fixes

**NEXT STEP:** resolve lone-surrogate cursor comparison against a real SQLite TS oracle before export: the typed cursor now retains UTF-16 but store binding still uses `String::from_utf16_lossy`, so the known identity concern is not closed. Exercise canonical lone-surrogate cursors against actual replacement-character IDs, including equal timestamps and ordering. Add the remaining unsafe-number Infinity and broader cursor mutation vectors. Then read frozen export implementation/handler, establish byte-level CSV/JSONL RED, and iterate this typed reader with first chunk awaited before response construction; verify cancellation, slow-reader writer progress, and three-run RSS ranges. Nodes remains subsequent scope.

| Requirement | Commit | Independent evidence under `/tmp/opencode/a7-parity/` |
|---|---|---|
| Typed store filter interface; all values including limit bound | `73c918de` | Existing logs corpus `typed.log` passes; structural refactor, no behavioral RED claimed |
| Exact provider pattern, negative unsafe integer, safeToken unknown key, permissive cursor decode/version order | `ca1f39f0` | `red.log`: 39 equal / 20 failures → `green.log`: 53 equal / 0 failures |
| BLOB degradations JS coercion | `ca1f39f0` | `cells-red.log`: TS 500 versus Rust 200 → `cells-green.log`: 17 equal / 0 failures; invalid two-byte and valid single-byte blobs |
| Full cursor traversal, newer insertion between pages | `ca1f39f0` | `walk.log`: 157 equal / 0 failures; 503 original IDs exactly once across 17-row pages; no independent RED |
| Empty table, text numeric cell, BLOB duration, NULL resolved model, valid RTK arrays | `ca1f39f0` | final driver; cells fixture; no independent RED except BLOB degradations above |

Store Query fields are explicit time bounds, failed/state, provider, requested/resolved/either model, error code, key/account IDs, UTF-16 cursor and limit. SQL text no longer crosses its API. Frozen logFilterSchema has no RTK filter input, so none was invented; RTK arrays are row output and whitelist-filtered. Multi-byte Uint8Array stringifies to comma-separated decimal bytes before JSON.parse, which correctly fails for the tested blob; a single byte parses as a number.

Final gates on implementation commit `ca1f39f0`, both binaries freshly built outside checkout; manifest commit/SHA256 written before driver runs: `/tmp/opencode/a7-parity/manifest.json`. Workspace **1046 passed / 0 failed / 7 ignored** (`workspace.log`); all-target workspace clippy clean (`clippy.log`); fmt clean (`fmt.log`). Admin-routes **2080 equal / 2 expected / 0 failures**; admin-auth **212 equal / 4 expected / 0 failures**; surface **606 equal / 61 expected / 0 failures**; run.ts **all rows equal** (matching log names). Incremental/debug disabled.

Status: **partial checkpoint, not complete for review**. Known unresolved issue: lone-surrogate cursor binding. Additional coverage caveats: overflow-to-Infinity schema wording, exhaustive malformed cursors, and schema-excluded NULL measures remain unchecked. Export not started; no three-run export RSS/cancellation/writer-progress claims. PostgreSQL report readers/backend routing and live HTTP conformance remain D4. Earlier historical next-step lists below are superseded by this section.

## Latest checkpoint — initial logs, 598f5aaa

**NEXT STEP:** finish logs traversal and adversarial conformance before export. Add a driver step that follows every returned cursor over all 503 seeded rows, inserts a newer row between pages, and asserts no duplication/omission of original rows. Add empty-table, unusual-cell, valid RTK filter, malformed cursor variant and validation boundary cases. Then export's precise next step is to read frozen `exportLogs`/CSV serialization and admin handler, add independent byte-level HTTP RED for CSV/JSONL, and iterate the bounded store page reader with the first chunk awaited before building the response. Do not collect an export; verify cancellation and writer progress with a slow reader.

Commit `598f5aaa`: additive `omni-store::logs` page reader (limit+1, descending at/id, raw-cell JSON conversion), control validation/opaque cursor, guarded GET/HEAD route; usage traffic fixture. Requirement → test map: route/filter/default/cap/guard/cursor malformed → `red.log` **80 equal / 150 failures** against old Rust → `green2.log` **155 equal / 0 failures**. Invalid time error text independently mismatched real TS in `green.log`, corrected to `since: Invalid input`. Every log HTTP case asserts status independently. Usage real request → `traffic-green.log` **9 equal / 0 failures**: exactly one upstream request and one usage bucket, requests=1/input=1/output=1/errors=0, only duration normalized after finite/range validation. Its initial failure was a test cookie formatting error, **not an implementation RED**. Usage and logs were committed together, not separately as requested.

Evidence `/tmp/opencode/a7-logs/`. Touched-crate tests **305 passed / 0 failed / 5 ignored** (`tests.log`); touched-crate all-target clippy clean (`clippy2.log`), fmt clean (`fmt.log`). Fresh TS and Rust binaries built at `598f5aaa`, outside checkout, manifest with hashes recorded before final driver. Final admin-routes **1997 equal / 2 expected / 0 failures** (`admin-routes-final.log`). Cargo incremental/debug disabled. No full workspace gate claimed in this continuation.

**Status: incomplete checkpoint, not complete for review.** Remaining coverage: traversal/insert-between-pages, empty log table, unusual log cells, valid RTK arrays, usage invalid UTF-8 dimension/ID and aggregate integer overflow. Known implementation concerns: provider validation is not yet an exact port of PROVIDER_ID_PATTERN; negative unsafe-integer error wording and safeToken unknown-key sanitization need correction; cursor decoding currently uses strict base64 before the TS version check (TS Buffer is permissive); lone-surrogate cursor IDs narrow through UTF-16-lossy conversion; raw BLOB degradations JSON coercion may differ. The page reader currently accepts internal SQL clauses assembled by control rather than typed filter fields. No export/nodes implementation. PG remains deferred to D4. These are explicit unfinished items, despite the ordinary corpus being green.

## Continuation checkpoint (89ecdb01)

**NEXT STEP:** add a usage-specific real `/v1` stub-upstream request, wait for its committed log, then assert `/api/usage` tokens/counts (normalize only validated nondeterministic duration/timestamps). Expand invalid UTF-8 tests to dimension and ID parameters (current vectors only exercise numeric fallback), and add integer-overflow aggregate error coverage. Then start `/api/logs` with independent real-TS HTTP RED, followed by export and nodes. PostgreSQL is deferred for every route to D4 per the revised instructions.

`89ecdb01` extracts SQL/label conversion into additive `omni-store::reports::usage`, with a defensive SQL expression whitelist. Control retains query validation. Driver now covers 300,000 raw rows across 10,000 keys and seven models (70,000 group/split tuples), +330/-480 minute daily-floor boundaries, a live inserted row with invalid UTF-8 TEXT, BLOB input tokens, text duration, invalid degradations, and a pending row. Five malformed query encodings exercise numeric fallback. All remaining legacy Database connections now set a bounded busy timeout.

**Memory:** neither frozen TS nor Rust has a fixed result bound. For a selected grain, output cardinality is the number of distinct selected group/split tuples among qualifying rows; it is at most the qualifying row count and at most the product of the two dimension cardinalities. An unbounded interval does not impose a fixed ceiling. Both aggregate in SQLite and materialize result buckets, not raw rows. TS additionally holds `.all()` aggregate records before mapping them. Rust directly collects mapped buckets. No new cap is imposed. Final 300k-row fixture VmHWM: **TS 152,852 kB; Rust 142,664 kB** (`admin-routes-final/usage-large-{ts,rust}-rss.txt`). Earlier isolated run: TS 151,060 kB / Rust 240,676 kB; process peaks vary with allocator/runtime behavior. These are Linux process high-water marks through all requests in the configuration, not a guarantee on arbitrary bucket cardinality.

Requirement → commit → test: store extraction, large-table memory, offsets, live/raw cells, malformed numeric query encodings, and legacy busy timeouts → `89ecdb01` → `usage-green.log` (449 equal), `large-green.log` (11 equal), `offset-green.log` and `offset-negative-green.log` (35 equal each), plus full final driver. **No independent behavioral RED occurred in this continuation:** the new tests were run against the old committed implementation before refactoring and already passed (`baseline.log`, `large-baseline.log`, `offset-baseline.log`, `live-baseline.log`). This is coverage plus a behavior-preserving extraction, not a newly fixed mismatch. The prior implementation RED evidence remains below.

Final gates run once against implementation commit `89ecdb01`; evidence `/tmp/opencode/a7-next/`:

| Gate | Result | Log |
|---|---|---|
| workspace tests | 1046 passed / 0 failed / 7 ignored | `workspace.log` |
| workspace all-target clippy -D warnings | clean | `clippy.log` |
| fmt | clean | `fmt.log` |
| admin-routes | 1833 equal / 2 expected / 0 failures | `admin-routes-final.log` |
| admin-auth | 212 equal / 4 expected / 0 failures | `admin-auth-final.log` |
| surface | 606 equal / 61 expected / 0 failures | `surface-final.log` |
| run.ts | all rows equal | `run-final.log` |

Both final binaries freshly built at the recorded commit and copied/compiled outside checkout. `manifest.json` records commit, SHA256s, and final driver log names before those driver runs. Build logs: `build-ts-final.log`, `build-rust-final.log`. Earlier exploratory runs reused the prior TS artifact and are not final gates. Existing unrelated working-tree lockfile/progress edits were preserved. No new known response mismatch; real-traffic usage assertion remains incomplete. Logs/export/nodes remain unimplemented. **Status: partial checkpoint, not complete for review.** D4 must add PG report readers beside the extracted SQLite reader and wire backend selection through control operations and HTTP, with live-PG conformance.

## Historical first checkpoint (superseded by continuation above)

## Changes

Commit `6d2a7a8e` implements GET/HEAD `/api/usage` on the existing independent control connection and blocking pool, with the reader guard first. New `omni-control::reports` validates grain/dimensions/IDs, implements JS optional-number coercion and daily flooring, and aggregates raw/daily SQLite rows. Response uses lossless JS JSON serialization; BLOB bucket labels stringify as comma-separated bytes. SQL expressions are selected from a whitelist. No writer connection or transaction is held by this query.

SQL currently lives in the control module; an additive store reader extraction would allow sharing with a future backend interface. No Postgres reader added in this checkpoint.

Permanent `usage` configuration in `conformance/e2e/admin-routes.ts`: 68 distinct requests × three caller roles, expected status independently checked; raw/daily dimensions and splits, invalid schemas, numeric fallbacks, duplicate grain, key/account narrowing, bounds, empty result, 20 raw and 8 daily rows, BLOB/empty/null labels, text and huge numeric measures. Fixture seed/copy connections now set a 5-second busy timeout. Other legacy driver connections still need the same pragma.

## Requirement → commit → evidence

| Requirement | Commit | Evidence under `/tmp/opencode/a7/` |
|---|---|---|
| Usage reader guard, schemas, all dimensions/splits | `6d2a7a8e` | `red-valid.log`: 191 equal / 372 failures against existing A6 Rust; `green-valid.log` passes empty-table corpus |
| Seeded aggregates, filters, unusual SQLite cells | `6d2a7a8e` | `seeded.log`: 411 equal / 2 failures; `usage-final.log`: 413 equal / 0 failures |
| Last duplicate query parameter wins | `6d2a7a8e` | Independently RED in seeded real TS-vs-Rust HTTP comparison, then fixed and GREEN |
| Regression gates | `6d2a7a8e` | table below |

The seeded aggregate corpus was added after implementation; only its duplicate-parameter finding has an independent behavioral RED. The earlier empty-table corpus had a real missing-route RED. Initial `red.log` additionally had an incorrect expected-status regex in the test; `red-valid.log` corrects it before implementation. Compilation initially needed adapting `JsValue` serialization to `json_ok(String)`. One attempted copy used the wrong binary name (`omni-gateway`, actual `omnigateway`), so `green.log` is not verification evidence.

## Verification

| Gate | Result | Log |
|---|---|---|
| Usage-only final HTTP | **413 equal / 0 failures** | `usage-final.log` |
| Entire admin-routes | **1716 equal / 2 expected / 0 failures**, 38 raw keys | `admin-routes.log` |
| admin-auth | **212 equal / 4 expected / 0 failures**, 116 tokens | `admin-auth.log` |
| surface | **606 equal / 61 expected / 0 failures** | `surface.log` |
| run.ts | **all rows equal**, four DB comparisons | `run.log` |
| cargo test --workspace | **1046 passed / 0 failed / 7 ignored** | `workspace.log` |
| clippy workspace/all-targets, -D warnings | clean | `clippy.log` |
| fmt check | clean | `fmt.log` |

All Rust builds used CARGO_INCREMENTAL=0 and disabled profile debug information. Outside-checkout binary `/tmp/opencode/a7/rust-final` was built from dirty `9624fa13` with the source subsequently committed as `6d2a7a8e`. TS reused `/tmp/opencode/a6-fix2/ts`; it was not freshly rebuilt. `manifest.json` records hashes and source qualifications for each substantive driver run, retrospectively. This does not satisfy the stronger fresh-binary/contemporaneous-provenance goal in full.

## Known differences / concerns / hand-off

- No mismatch in the exercised usage cases. URL parsing currently uses `url::form_urlencoded`; malformed UTF-8 and uncommon duplicate combinations need explicit oracle coverage.
- PostgreSQL, real-traffic usage verification, nonzero offsets, pending rows, comprehensive raw-cell adversaries remain unverified. Existing `run.ts` does exercise traffic and storage, but does not assert this new HTTP report over that traffic.
- Aggregation materializes all result buckets, as TS does. Unbounded high-cardinality report memory remains a concern relative to the brief's bounded-memory requirement.
- `/api/logs`, `/api/logs/export`, `/api/nodes` remain at their prior behavior. No export, paging, cursor, disconnect, or large-export claims.
- D4 must wire database selection through gateway/control readers and add PG implementations for these report operations (not merely select PgStore), then exercise HTTP and cross-runtime restart/cross-read against live PostgreSQL.
- Existing pinned divergences: 2 admin-routes, 4 admin-auth, 61 surface.
- No frozen TS, provider-owned files, CLI-owned files, lockfile, progress, user specs, stash, or other worktrees edited or staged; no unsafe, push, merge, or subagents.

Status: **checkpoint, not complete for review**. Route commit is green for the exercised SQLite corpus; remaining scope and qualifications above are deliberate hand-off items, not completed requirements.
