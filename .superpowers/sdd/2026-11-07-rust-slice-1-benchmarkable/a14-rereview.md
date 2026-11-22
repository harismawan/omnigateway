# A14 independent re-review

Verdict: **REQUEST CHANGES** — one Important new trailing-slash catch-all response regression. I1–I3 are closed in independent real-duration probes; all requested gates pass.

## Findings (first)

### Important — NEW trailing-slash normalization leaks into 404 bodies

Frozen `apps/gateway/src/app.ts:530` embeds the pathname in its catch-all error. Rust `server.rs:491–503,527` now overwrites that pathname with the slash-stripped routing key, unlike the pre-fix separate `path` and `route` variables.

Independent paired raw-socket GET `/missing/`: frozen returns 404 with `no route for /missing/` (65-byte JSON); final returns 404 with `no route for /missing` (64-byte JSON). `quick/quick.json` retains exact responses. Independent base repeat (`base-quick/quick.json`) returns the original `/missing/` in both. This is a new response-body regression caused by r1, not a timer granularity difference. Preserve the pathname for catch-all/static/error handling while sharing the route-key normalization for dispatch and exemption.

Other immediate raw-path checks (`quick/quick.json`) agree by routing class: `/large.txt/`200, encoded-dot normalized messages401, normalized trailing-slash responses401, backslash normalized chat401. These are immediate routing checks, not substitutes for the real255s exemption checks.

## Scope

Review range da4b7a99..cfe1c561; checkout detached at cfe1c561. No product edits, commits, or subagents. Prior reviewer and implementer evidence are read-only.

## Source review

- `server.rs:491–503`, `lib.rs:528`: dispatch and exemption both invoke the same `route_path`; no competing inference normalizer. The plain-path fast path borrows; slash trimming allocates if borrowed; unusual paths normalize twice (exemption and handler), not two different algorithms. The pathname-vs-route-key regression above is the exception.
- `http.rs:33–67`: initial mode is enabled with min(configured,10s); first service dispatch sets routed permanently. Every dispatched request clears received bytes, rearms last time, and selects enabled or exempt. Completion itself changes no mode, so completed-exempt remains exempt. The next ordinary request reenables. No separate Hyper header deadline remains (`lib.rs:249`). Pipelined mode changes occur when Hyper calls the service, not on raw socket read-ahead.
- `http.rs:102–123`: counts every successful nonempty underlying socket read (including headers/framing and read-ahead); counter resets on request dispatch and on reaching threshold. Production threshold is 255×16,384 = 4,177,920 bytes. Excess over threshold is discarded, matching the source's reset-to-zero policy, but raw rather than decoded accounting is approximate. The relaxed atomic add wraps only after 2^64 accumulated bytes; realistic idle-window traffic cannot approach that. Writes touch only on successful positive progress, including partial/vectored writes; flush, shutdown, zero, errors and Pending do not touch. No new production I/O panic/expect.
- `server.rs:759–796`: non-exempt body reader has its own fixed deadline, rearmed only after the same threshold of decoded data bytes; trailers do not count. Exempt inference passes Duration::ZERO and awaits without deadline. Counter resets once per body and per threshold, not per frame. The duplicate decoded-body deadline may expire earlier than the raw transport near a framing/header threshold; this is the documented residual. Doc comment “at most idle between frames” is now stale, not the implementation.
- `lib.rs:535–549`: timeout drops the watched Hyper connection and its service/body, matching disconnect cancellation structurally. `finish.rs:197–201,181–193` makes an unfinished handler emit 499/interrupted and releases admission on write. Inference body read precedes admission/upstream dispatch (`server.rs:922,947`), and inference is exempt anyway. Non-exempt count_tokens owns no inference Finisher, admission claim, upstream, or request-log row (Rust `server.rs:1284–1335`; frozen proxy.ts:1058–1099). Thus its expired stalled upload must not be asserted to produce a 499 inference row. Existing drop-claim unit test checks Hyper future destruction, not all concrete resource counters.

## Harness / binary identity

Frozen SHA256 f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63; final ef377cb74c908fc7a2e56f5c577e94a56dcf4b9fbb62b050125f5ec36ffd68d9. Independent sha256sum matched supplied binaries. Real-duration probes run loopback-only with env -i, private HOME, no-env-file for every Bun invocation, and no real config access. The shared target path is used solely as requested build output, never as a command working directory.

Initial run.ts invocation failed before gateway startup because this driver does not accept --work (`run.exit:1`); corrected invocation uses --keep (`run2.exit:0`, all rows equal). Evidence retained rather than overwritten.

## Independent real-duration results

Copied normalized/transition/inbound probes run concurrently against one frozen/final pair (`paired.exit:0`; each of four child `.exit` files is 0). **I1, I2, I3 are closed for the measured cases.** Normalized JSON full 6,291,770 bytes both, no EOF; normalized SSE no EOF both after 278s hold and bounded drain. Completed exempt connection remains open at 280.11/280.10s; next ordinary closes frozen 257.47 vs Rust 257.01s (from initial POST), pipelined exempt→ordinary 253.47 vs 255.00s. Authenticated count_tokens trickle at100/200s has EOF and no response in both at278s.

`paired/headers.json` independently verifies initial rule, not implementer evidence: empty fresh connection EOF frozen9.425/Rust10.001s; incomplete first headers9.417/10.002s; first-header trickle every2s9.417/10.001s (four bytes sent each). A complete GET /health followed by incomplete second headers closes253.456/255.002s; second-header trickle at100/200s253.456/255.001s. Thus Bun uses10s initially,255s after a complete ordinary request, and small trickles do not reset either deadline. All return empty response bytes on expiry.

Pristine idle driver (`idle.exit:0`) independently passes all its assertions: static truncation1,796,096 bytes both; ordinary keepalive253.57/255.00s; active readers open with21,280,768 bytes at278s; JSON full6,291,770; SSE open. Stored rows200/null and499/interrupted both. Its WebSocket404/101 difference is the documented existing gap, not timer parity. JSON/SSE here duplicate the normalized class and are not double-counted below.

The combined experiment's request logs match exactly: one200/null JSON, one499/interrupted SSE, three401/AUTH transition requests; no extra count_tokens request-log row. This confirms non-exempt mid-body expiry leaves no inference row in either gateway, consistent with the source. It does not instrument all resource destructors.

Supplemental `extra.exit:0`, seven paired classes: silent inference upload remains open with zero response bytes280s both; silent count_tokens EOF253.572/255.002s with no response; count_tokens receiving4,200,000 bytes at150s remains open280s both (independent threshold-positive check). Encoded-dot/trailing-slash messages and responses return401 then remain open280s both, completing real-duration exemption coverage of all three routes. Ordinary→exempt pipeline stays open280s both; completed exempt→incomplete ordinary next headers also stays open280s both, showing exemption persists until the next request actually dispatches. Request logs match: four401/AUTH, one500/INTERNAL from explicitly closing the still-incomplete exempt upload at probe end. This is the existing disconnect body-read outcome, not shutdown cancellation; count_tokens leaves no row for silent or threshold/trickle uploads.

One-byte/200s repeat (`one-byte.exit:0`) confirms equal truncation class, not indefinite liveness: frozen/Rust EOF at278.01s with1,792,145/1,796,241 remaining raw bytes after two separately read bytes. Buffered byte count varies with socket scheduling, so exact equality is not asserted.

## Limitations / documented differences

- Bun's coarse timer tick versus precise Tokio expiry; measured seconds compared by timeout class, not exact equality.
- Raw transport threshold includes header/framing/read-ahead; decoded-body threshold does not. Near-threshold exotic chunked framing remains unisolated.
- Failed Bun writes, zero-progress writable drains and expiration/readiness boundary races are source-reviewed but not independently isolated black-box.
- No304-producing route tested; HEAD is not newly retested here. No admin-routes driver run, as requested.
- Pipelining probes cover small completed requests and partial next heads, not concurrent long inference responses. Hyper service dispatch is serial.
- No individual limiter/upstream/writer-slot destructor counters instrumented; source ownership, existing drop tests and observed request-log outcomes are narrower evidence. Non-exempt count_tokens has no such inference resources or request log to free.
- Short local burst is not a statistical performance guarantee; unrelated host activity cannot be globally controlled.
- Tests/clippy built the final source cold; socket/performance/conformance measurements use the supplied final executable whose full hash was independently checked. No independent production-executable rebuild/hash equivalence is claimed.

## Gates — independent, final source

Exact exits read from reviewer-owned files; each Cargo command ran sequentially with offline mode, jobs2, incremental0, dev/test debug0, private HOME/CARGO_HOME, shared requested target. Disk boundaries14→12→11GiB, always above5GiB. Fresh cold workspace passed first attempt; no retry required.1,347 `test ... ok` lines. All three named historical flakes passed: `http::drain_tests::admitted_drain_replaces_oldest_idle` line1551, `a_failed_reconciliation_read_is_reported_as_unknown` (pg_health_retry integration binary) line2636, `a_pinned_reader_lets_the_wal_grow_past_the_trigger` line2766. New initial-header unit and pending-service-drop unit passed too.

| Command | Exit file | Code |
|---|---|---:|
| cargo test --offline --workspace | workspace.exit |0|
| cargo clippy --offline --workspace --all-targets -- -D warnings | clippy.exit |0|
| cargo fmt --all -- --check | fmt.exit |0|
| cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture | dispatch_size.exit |0|
| unshare -Urn bash -c 'ip link set lo up; bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a14/r1-final --keep' | run2.exit |0|
| bash conformance/e2e/idle-timeout-ns.sh frozen final reviewer-work | idle.exit |0|
| copied combined normalized/transition/inbound + new headers | paired.exit |0|
| supplemental7 paired classes | extra.exit |0|
| one-byte/200s repeat | one-byte.exit |0|
| immediate final/frozen and base/frozen route checks | quick.exit / base-quick.exit |0 /0|
| isolated alternating base/final burst | burst.exit |0|

dispatch_size concrete future3,400 bytes. run.ts49 passing comparison rows, all equal. Initial invalid --work run.exit1 is retained and superseded, not concealed. No other failed reviewer commands represent product failures; no workspace flakes encountered, so no second workspace attempt.

## Independent isolated throughput

After Cargo, standard gates and other reviewer namespace probes completed:4 alternating base/final pairs,2,000 authenticated JSON requests per pass, concurrency20, one8,603,191-byte SSE per pass. Frozen not involved in this benchmark. Base `/tmp/opencode/a14/rust-base`:8,000 requests, aggregate7,002.58 req/s, mean SSE105.36ms. Final `/tmp/opencode/a14/r1-final`:8,000 requests, aggregate7,126.26 req/s, mean SSE107.66ms. Delta **+1.77%**; no material hot-path throughput regression demonstrated. Raw rows `burst/results.json`, aggregate `throughput.json`; `burst.exit:0`. Source hot-path delta: one relaxed atomic add per successful positive read plus threshold arithmetic/compare; no new per-chunk allocation or explicit socket syscall. One additional route_path call per request; normalization allocation only on unusual/trailing-slash paths. No CPU profiling/syscall tracing performed.

## Probe counts

26 unique paired final-vs-frozen classes /52 class sockets:24 equal by tested behavior class;1 new difference (404 pathname);1 existing documented WebSocket404/101 gap. `classifications.json` records each pair. Repeated normalized JSON/SSE in the ordinary driver, immediate route checks already covered by long normalized messages/responses probes, baseline repeats, health startup requests, and burst/gate traffic are excluded. Unique classes: normalized JSON/SSE2; completed-exempt transitions3; trickled count_tokens1; initial/subsequent headers5; supplemental bodies/exemptions/pipeline7; standard static/keepalive/active/WebSocket4; immediate missing slash/static slash/backslash route3; one-byte reader1. First-reviewer scripts were copied byte-identically (`probe-origin.txt`). One Important new blocker; no Critical findings.

## Restoration proof

`restoration.json`: HEAD cfe1c5618f925d95883fa397f0fcba7c021a11d0; symbolic-ref exit1 (detached); git diff and cached diff exit0; porcelain status exit0 with empty stdout. No product or checkout harness modifications were made. All reviewer harness/evidence files are outside the checkout under this directory; no files require reverting. No commits, resets, deletions, subagents, or global configuration access.
