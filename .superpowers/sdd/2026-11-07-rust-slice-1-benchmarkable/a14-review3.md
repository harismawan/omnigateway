# A14 round 3 narrow independent review

Verdict: **APPROVE A14 at84c476846e9c43e9bd3e162683b55618157f19ff**, across all rounds, subject to the complete documented differences/unverified limits below. No remaining A14 findings.13/13 current-round paired checks equal; all requested gates pass.

## Findings first

No new finding. Prior trailing-slash finding is closed by independent paired reproduction below. I1–I3 were closed in round2; the timeout implementation is unchanged in this round. Critical0, Important0, Minor0 remaining A14 findings. The documented A9 WebSocket gap is not attributed to A14.

## Scope

cfe1c561..84c47684; no product edits, commits, subagents, or evidence modifications outside reviewer-owned directory. All12 quick pairs, real255-second normalized-path exemption check, and requested gates complete.

## Source audit

Only production delta is server.rs:502–503,511: `path` again uses `static_files::pathname`, while `route` uses `route_path` and matching uses `route.as_ref()`. `route_path` itself is byte-unchanged, as are lib.rs exemption selection, http.rs timeout state machine, static_files.rs and all other production files. Dispatch and exemption call the identical shared helper on `req.uri().path()`; no second dispatch/exemption normalizer.

Byte identity recorded independently in `source-identity.json`. The three new tests cover plain/normalized missing path spelling, static slash preservation, and normalized inference dispatch. Assertions do not assert a shortened test budget as a substitute for production255s coverage; the new raw280s probe provides that check separately. Test-only expect/comment follow-up does not alter production behavior.

All `handle` pathname uses audited: plugin-asset classification at526 and static serving at527 receive slash-preserving `path`; static not_found_get atstatic_files.rs:527,562 embeds that same pathname through server.rs:468. Route classification/payload-limit check uses the stripped route key as before. There are no pathname-bearing log statements in the modified handle region; handlers still receive the original request, not a rewritten URI, and unchanged downstream logs/errors can derive their original URI as before. No other consumer relied on the overwritten path. Plugin paths with/without trailing slash included in independent quick checks.

Supplied final binary SHA256 independently checked: b6472a30956a2a4acbe3121f461d46a2844ba4e6d4466ecf6d6dfdfa2db79ce3. Final source builds are independent; binary rebuilt-after-commit provenance remains implementer evidence, not an independent production rebuild by reviewer.

## Independent paired results

`paired/quick.exit:0`: **12/12 pairs equal** in status, body byte length/SHA256, and end-to-end headers case-insensitively excluding Date/hop-by-hop.24 sockets. Raw response heads retained; Rust's explicit Connection:close while frozen closes without that header is inherited and not masked as a byte-identical response claim. Cases: `/missing/`, `/missing`, encoded-dot normalized missing slash, doubled missing slash, static trailing slash, normalized static trailing slash, plugin asset with/without trailing slash, encoded-dot messages trailing slash, normalized responses trailing slash, backslash chat, normalized chat trailing slash. Exact evidence `paired/quick.json`. Missing slash JSON is65 bytes in both; no-slash is64 in both. **The final outstanding trailing-slash finding is independently closed.**

Static pairs were fully drained and SHA256 compared, not header-only samples:33,554,432 body bytes each. Plugin asset trailing slash remains the dedicated63-byte `no such plugin asset` body; without slash remains75-byte general catch-all, equal both. Doubled missing slash preserves66-byte JSON both. `quick-classifications.json` retains all12 comparisons without counting fixture/startup traffic.

`run.exit:0`: namespace `unshare -Urn bash -c 'ip link set lo up; bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a14/r2-final --keep'`,49 passing comparison rows, all equal.

`paired/exempt.exit:0`, `paired.exit:0`: raw POST `/v1/x/../chat/completions/` returns the equal401/121-byte body, then **remains open at280.014s frozen /280.011s final Rust**, no EOF. This uses the real production255s configuration, not a shortened timeout. Confirms the changed dispatch derivation still selects the same normalized route as exemption and completed-exempt persists past255s. Evidence `paired/exempt.json`.

Current-round socket counts: **13 paired checks /26 sockets,13 equal,0 new differences** (12 immediate +1 real-duration). run.ts49 equal comparison rows reported separately; prior-round26 unique classes overlap and are not added as new unique classes. Across rounds all identified A14 findings are closed; the previously measured A9 WebSocket gap remains expressly out of scope.

| Requirement | Independent evidence |
|---|---|
| `/missing/` and `/missing` exact body spellings | paired/quick.json;65 vs64-byte bodies preserved |
| static trailing slash, normalized static | full32MiB drain/hash comparison in quick.json |
| encoded-dot/backslash/slash inference dispatch | four inference quick cases401/equal |
| shared dispatch/exemption helper unchanged | source-identity.json and reviewed diff |
| other pathname consumers restored | server.rs:526–527, static_files.rs:527,562 audit; plugin quick cases |
| production255s normalized inference exemption | paired/exempt.json; both open280s |
| normal conformance | run.exit0;49 equal rows |
| workspace/clippy/fmt | respective .exit files all0; final evidence below |

## Final independent gates

Exact exit codes read from reviewer-owned `.exit` files, not implementer claims:

| Command | Exit file | Code |
|---|---|---:|
| cargo test --offline --workspace | workspace.exit |0|
| cargo clippy --offline --workspace --all-targets -- -D warnings | clippy.exit |0|
| cargo fmt --all -- --check | fmt.exit |0|
| namespace run.ts frozen vs r2-final --keep | run.exit |0|
| combined paired probes | paired.exit |0|
|12 raw HTTP pairs | paired/quick.exit |0|
| normalized-path280s pair | paired/exempt.exit |0|

Workspace at final84c47684 passed first attempt with **1,350 `test ... ok` lines**; no flaky retry required. New3 regression tests passed (workspace.log:987–989). All3 named historical flakes passed: admitted_drain_replaces_oldest_idle:1289; pg_health_retry a_failed_reconciliation_read_is_reported_as_unknown:2372; a_pinned_reader_lets_the_wal_grow_past_the_trigger:2503. Clippy final exit0, fmt final exit0. Sequential offline Cargo with jobs2, incremental0, dev/test debug0, explicit CARGO_HOME, private HOME, requested shared target. Disk9.1→9.0GiB at gate boundaries; always above5GiB, no deletion/cleanup. No idle-driver or dispatch_size rerun in this narrow requested gate set; previous independent size3,400 bytes and idle driver pass carry forward for unchanged timer/body code. Implementer r2 claims for those gates are not relabeled independent reviewer runs.

## Approval conditions / documented differences carried across rounds

1. Bun's coarse ~4s timer tick versus precise Tokio timer; results match timeout classes, not exact timestamps. Initial no-input/incomplete/trickled headers use10s; after first ordinary routed request255s. Completed inference leaves connection exempt until next ordinary request dispatches, including incomplete next headers. Independently measured in prior round.
2. Threshold4,177,920 bytes (16,384×255): transport counts raw header/framing/read-ahead bytes; the body reader counts decoded bytes. Exotic chunked/header framing near threshold remains an accepted approximation, not exact Bun internal accounting parity.
3. Inference routes disable socket and body idle ceilings. Non-exempt low-throughput bodies expire; successful threshold bursts rearm. Cancellation is source/drop-test and request-log observed, not instrumented for every concrete limiter/upstream/writer resource. count_tokens expiry creates no inference row in either runtime. Explicitly closing unfinished exempt body follows existing500/INTERNAL read-error outcome; shutdown cancellation is499/interrupted. These are distinct paths.
4. Only positive successful read/write progress (thresholded for reads) rearms Rust. Bun failed-write and zero-progress writable/drain corner cases are not independently isolated; partial/vectored writes source/unit covered. Expiry/readiness boundary races not stress-tested.
5. One-byte/200s reader is equal truncation class, not an active-reader guarantee; receive-window/socket progress matters. Active draining reader was independently measured staying open. Buffered bytes and FIN observation do not pinpoint exact close time.
6. WebSocket404 Rust/101 frozen is documented A9 route/upgrade gap, explicitly outside A14. Not an idle parity claim.
7. No actual304-producing route tested. HEAD and admin streaming export covered in the first review, not newly repeated; no admin-routes driver run. Export cancellation has no inference resources to release; already-running blocking DB page reads are bounded, not synchronously cancelled.
8. Pipelining covers small completed requests, both mode-switch directions and partial next heads, not concurrent long inference responses (Hyper dispatch is serial). No HTTP/2 introduced.
9. Prior isolated burst final/base +1.77% (7,126.26/7,002.58 req/s) with short-local-run limits and uncontrolled global host noise; no full production load guarantee. No new burst in this narrow round. Preserving pathname adds one pathname fast-path scan per request and normalization/allocation on unusual paths versus r1; no benchmark isolated that additional cost.
10. Gates are final-source independent; final socket/conformance tests use independently hashed supplied executable. Prior duration/source/unit evidence is carried forward for unchanged timer code rather than every255s case being rerun at every commit. Broader provider gates were not independently repeated in this narrow round. No syscall tracing or CPU profile.
11. Quick raw HTTP comparisons are not whole-wire byte equality: Date and hop-by-hop headers differ; Rust explicitly sends Connection:close on these close-request probes while frozen closes without that header. This difference existed in baseline, is not introduced by A14, and is retained in raw evidence.
12. Initial headers near the multi-megabyte inbound rearm threshold were not separately probed. Initial10s is min(configured,10s) in Rust, with proportional byte thresholds for subsecond unit-test durations; production uses255s/4,177,920 bytes. No new timeout environment knob.
13. Enforcement belongs to the production listener's IdleIo wrapper. The public http1_builder duration argument is retained but Hyper's independent header timeout is disabled; standalone/custom test listeners using only that builder do not gain transport timing. No guarantee outside the production wrapper is inferred.

## Cross-round evidence retained

First review: `/tmp/opencode/a14-review/review.md` (read-only). Second review: `/tmp/opencode/a14-review2/review.md` and `classifications.json`;26 unique paired classes,24 equal then,1 new slash regression now closed,1 documented WebSocket gap. That round independently reran I1–I3 plus initial/subsequent header timing, trickle and threshold-positive inbound behavior, mode transitions, standard idle driver, gates, and base/final burst. This narrow round verifies the only subsequent production delta, rather than treating its12 quick pairs as a replacement for prior real-duration coverage. All identified A14 blockers are independently closed; final approval rests on this cumulative evidence and explicit limits above, not exact parity in every Bun internal corner case.

## Restoration

`restoration.json`: HEAD84c476846e9c43e9bd3e162683b55618157f19ff; symbolic-ref exit1 (detached); working/index diff exit0; porcelain status exit0, empty output. No checkout edits needed restoration; all harnesses/evidence remain under reviewer-owned r3 directory. No commits, subagents, deletion, or real/global config access. All Bun commands use --no-env-file and scrubbed environment/private HOME; probes and run.ts run inside loopback-only namespaces.
