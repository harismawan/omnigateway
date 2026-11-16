# A14 outbound idle timeout

Worktree: `/home/homebrew/.local/share/opencode/worktree/1600a1/rust-postgres`, branch `feat/rust-idle-timeout`, base `3a0a230a`.

## Frozen oracle findings

**Important correction to brief:** frozen `proxy.ts:1008,1012,1016` explicitly disables the socket idle timeout for `/v1/messages`, `/v1/responses`, and `/v1/chat/completions`. The matching minified calls were also verified inside the frozen executable. Adding a 255-second timeout to their stalled JSON/SSE responses would violate the oracle. These responses can continue retaining resources until disconnect or configured request deadline; this change deliberately preserves that behavior.

Frozen binary `/tmp/opencode/a8/ts`: SHA256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`, embedded Bun `1.4.4 (38afee6c8)`.

Reliable paced run: `red5.log`, ~301 seconds, both gateway processes remained alive. Rows concurrent in loopback netns with real 255s timeout and 4KiB receive buffers:

* Stalled static 32MiB response: frozen truncates after 1,796,096 queued bytes; Rust base sends entire file and stays open. Driver only drains at 278s, so this does not precisely timestamp the frozen close.
* Idle `/health` keepalive: frozen EOF 253.73s, Rust base 255.01s (Bun timer granularity).
* Active slow static reader: both still open at 278s, 21,305,344 bytes received.
* Stalled inference JSON (6MiB): both deliver all 6,291,770 bytes after resuming reads, remain open.
* Stalled inference SSE: both remain open after 278s and a bounded drain. Fresh upstream frames produced throughout the stall.
* `/api/stream` upgrades in frozen (101); Rust already returns 404. Frozen closes a non-ponging WebSocket independently of HTTP idle timeout; registry source uses 20s pings / 60s pong deadline. WebSocket migration is not implemented in Rust, recorded as existing gap rather than extending this item's scope.
  Final-driver sample bytes confirm three `89 00` ping frames followed by `88 0f 03 e9` (close 1001) and UTF-8 `pong deadline`; not an HTTP 255-second cutoff.
* After explicit driver disconnect and orderly shutdown: both stores contain JSON 200/null and SSE 499/`interrupted`. Static and keepalive traffic produces no inference request-log rows.

Initial attempts retained: `red.log` fixture DB path failure; `red2` unpaced endless SSE overloaded frozen and hung incomplete-header probe; `red3` superseded similarly and terminated; `red4` oversized JSON exceeded Rust's pre-existing 8MiB buffered-output budget. `red5` fixed pacing, bounded header/body waits and JSON size. Earlier process deaths invalidate their apparent short timeout measurements. No runtime timeout knobs added.

Docs/source evidence: Bun HTTP docs describe sent/received inactivity, including streaming. Saved Bun v1.4.4 `HttpResponse.h` and `HttpContext.h` plus current source under this evidence directory. Source rearms on writes/partial writes and writable drain, including some failed write attempts; successful partial socket writes are the relevant backpressure activity here. Request-body source has throughput-based timeout resetting (16KiB/s), not an unconditional reset per input byte. This change does not claim to fix existing Rust inbound header/body differences.

## Design

`src/http.rs` wraps the TCP transport, below every response kind. Successful nonempty reads and writes, including vectored/partial writes, update one monotonic clock. Pending/empty writes and producing queued response frames do not. A connection-level timer rechecks activity at expiration instead of resetting a timer for every chunk. No per-chunk allocation, task spawn, notification, or extra syscall; one `Arc` per connection, relaxed atomic activity timestamp, existing vectored-write capability preserved. Timer cancellation drops hyper through existing disconnect destructors, releasing service/response work and its claims. Inference routes are explicitly exempt, as frozen. Idle keepalive retains 255s budget.

An exemption-changing request wakes the timer with a connection-local Notify (per request, never per chunk). This prevents re-enabling the timeout from inheriting an old disabled recheck deadline. Six paused-time tests now pass, including vectored writes and a pending hyper service with a claim-drop sentinel plus client EOF. This proves the same destruction boundary, not each particular upstream/limiter implementation independently.

Paused-time unit tests cover blocked writer, reads/partial writes, inference exemption/re-enable, idle-reader/zero, vectored writes and service cleanup. All six pass. No dependencies or TS product changes.

## Commits / binaries

* `7946f5a1`: measurement driver (3 files, +217).
* `942c7348`: transport timeout implementation (2 files, +195/-2).
* Baseline binary: `rust-base`, SHA256 `e2bdf139c4939c522ea54cb36b28637930a63a5138072fbbf17d5272e8b39a5b`, built at `3a0a230a`.
* Implementation binary: `rust-final`, SHA256 `27c5844f1f1229f2850e76e5912726aad7cb832a5a791e8ef1a785280744893e`, built after `942c7348`.
* `214a02d0`: timer-mode wake, additional tests, driver evidence/assertions (4 files, +98/-5).
* `da4b7a99`: test-only clippy unwrap allowance (1 file, +1).
* Final binary: `/tmp/opencode/a14/rust-final2`, SHA256 `4b8c6a6b9103c1db24e0332b7926265ca8e6588d78039c65b33a48a930a77c7b`, commit `da4b7a9927d1eb376019aba83373d48ad13c9ecc`.
* Branch total: 4 commits, 5 files, +506/-2. Clean after final commit. No push/merge.

## Throughput

`burst.ts`, `burst.log`, `burst/results.json`: alternate base/final, 2,000 authenticated non-stream inference requests at concurrency 20, then 8,603,191-byte SSE. Two passes each. Base 6,245 / 5,096 req/s; final 5,514 / 6,428 req/s. Aggregated base 5,612 req/s, final 5,936 req/s (~+5.8%, noisy concurrent gates). SSE base 129.3 / 113.3ms; final 110.9 / 112.0ms. Short burst detects no consistent regression, not a statistical performance proof.

Final2 repeat (`burst2.log`): base 7,428 / 5,338 req/s; final 5,315 / 6,574 req/s. Aggregated base 6,212 vs final 5,878 req/s (-5.4%); per-pass ordering reverses. SSE base 102.1 / 108.4ms, final 112.5 / 100.6ms. Concurrent gates make this inconclusive; isolated repeat below resolves the ordering noise.

## Verification

First implementation real-duration driver **red → green**: baseline `red5` failed stalled static and pre-existing WebSocket gap; after recording the latter separately, `green` passes. Frozen and final both truncate stalled static at exactly 1,796,096 bytes; slow readers stay open; JSON/SSE exemptions unchanged. Both stores contain JSON 200/null and SSE 499/interrupted.

Exact final command/exit lines appear below, quoted from `.exit` files. Unit red failed to compile missing implementation (`unit-red.log`); three initial implemented paused-time tests passed (`unit-green.log`), six final tests passed (`unit-final.log`). Baseline workspace passed without flaky rerun (`workspace-test-base.exit`).

Provider wrappers `anthropic-ns.sh` and `openai-ns.sh` invoke bare `bun`; evidence-directory copies insert `--no-env-file` without modifying repository wrappers. Other wrappers already supply it. All invocations have scrubbed environment/private HOME and loopback namespaces.

Initial implementation workspace passed (1,545 test lines marked ok, no flaky rerun). First clippy failed test-only unwrap lint (`clippy.log`/`clippy.exit`, 101); retained and fixed consistently with surrounding tests. Final-commit full gates passed with `*2`/`clippy3` suffixes; earlier attempts retained.

## Unverified / limitations

Exact Bun partial-read/failed-write corner cases are not fully black-box measured. HTTP pipelining per-request exemption changes have no new dedicated probe. Non-inference JSON/export timeout covered architecturally at transport layer, not separately real-time probed. WebSockets remain an existing unimplemented Rust route. The intended stalled-inference resource-release change is **not** applied because frozen explicitly exempts those requests. A response may already have completed application-side and logged success before its remaining socket-buffered bytes are truncated; this change does not rewrite an already completed log (nor does the frozen static probe create one).

### Retained first-pass command/exit evidence

```text
cargo build --offline -p omni-gateway: 0
cargo test --offline -p omni-gateway http::tests: 101
cargo test --offline -p omni-gateway http::tests: 0
cargo test --offline --workspace: 0
cargo test --offline --workspace: 0
cargo clippy --offline --workspace --all-targets -- -D warnings: 101
cargo clippy --offline --workspace --all-targets -- -D warnings: 0
cargo fmt --all -- --check: 0
cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture: 0
idle-timeout-ns.sh frozen rust-final: 0
bash /tmp/opencode/a14/anthropic-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/rust-final /tmp/opencode/b4/e2e/a14/anthropic: 0
bash /tmp/opencode/a14/openai-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/rust-final /tmp/opencode/b4/e2e/a14/openai: 0
bash conformance/e2e/antigravity-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/rust-final /tmp/opencode/b4/e2e/a14/antigravity: 0
bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/rust-final /tmp/opencode/c1/w-a14: 0
unshare -Urn bash -c run.ts: 0
unshare -Urn bun --no-env-file /tmp/opencode/a14/burst.ts: 0
unshare -Urn bun --no-env-file /tmp/opencode/a14/burst2.ts: 0
cargo build --offline -p omni-gateway: 0
cargo test --offline -p omni-gateway --lib http::tests: 0
```

Initial dispatch size: 3,400 bytes (ceiling 5,500). No known flaky test failed on either completed workspace run.

### Final2 real-duration driver

```text
bash conformance/e2e/idle-timeout-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/rust-final2 /tmp/opencode/a14/green2: 0
```
Final2: all six socket rows pass in ~301s; both request-log assertions pass (200/null JSON, 499/interrupted SSE). Frozen and Rust static truncation byte counts both 1,796,096.

### Build discipline / retained failures

Every cargo invocation used offline mode, jobs=2, incremental=0, dev/test debug=0, CARGO_HOME=/home/homebrew/.cargo, private HOME and the worktree-local target. Disk checked before builds and remained above 6.9GiB free. No cleanup of user files or target caches.
The initial successful baseline cargo build was followed by an incorrect binary copy name (omni-gateway vs omnigateway); base-build.exit records cargo status only. Correct binary copy was then made from target/debug/omnigateway, with hash recorded. Final build/copy/hash commands use the correct binary name.
All source commits are append-only. No TS product files, lockfile, dependencies, real environment files or global configuration changed. Admin-routes driver was read for fixture conventions but never executed.

### Final-commit gates (quoted from .exit files)

```text
cargo test --offline --workspace: 0
cargo clippy --offline --workspace --all-targets -- -D warnings: 0
cargo fmt --all -- --check: 0
cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture: 0
bash conformance/e2e/idle-timeout-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/rust-final2 /tmp/opencode/a14/green2: 0
bash conformance/e2e/idle-timeout-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/rust-base /tmp/opencode/a14/red-final-driver: 1
bash /tmp/opencode/a14/anthropic-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/rust-final2 /tmp/opencode/b4/e2e/a14/anthropic2: 0
bash /tmp/opencode/a14/openai-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/rust-final2 /tmp/opencode/b4/e2e/a14/openai2: 0
bash conformance/e2e/antigravity-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/rust-final2 /tmp/opencode/b4/e2e/a14/antigravity2: 0
bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/rust-final2 /tmp/opencode/c1/w-a14-final: 0
unshare -Urn bash -c 'ip link set lo up; bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a14/rust-final2': 0
unshare -Urn bun --no-env-file /tmp/opencode/a14/burst-isolated.ts: 0
```

Final workspace passed without rerun, including all three named historically flaky tests. Dispatch concrete future: **3,400 bytes <= 5,500**. Final driver against unchanged base fails **only rust/static** (`red-final-driver.log`), and against final binary passes (`green2.log`): same driver, same real-duration budget, red → green.
Isolated repeat after cargo/provider gates: base, 4 x 2,000 non-stream requests: 7786.6 aggregate req/s; SSE mean 99.89ms (8,603,191 bytes).
Isolated repeat after cargo/provider gates: final, 4 x 2,000 non-stream requests: 7797.4 aggregate req/s; SSE mean 101.45ms (8,603,191 bytes).
Final/base throughput delta: 0.14%. Small local burst only; no per-chunk allocation/syscall was introduced.

### Supplemental TCP diagnostic (not a gate)

An extra `fin-timing.py` experiment attempted TCP_INFO/FIN timestamps while receive windows stayed full. This cannot reliably timestamp application-side close: TCP can queue FIN behind unsent data when the peer window is zero. Stopped the experiment and its owned gateways explicitly; no result claimed. Existing real-duration driver instead drains the queued bytes after 278s and verifies truncation/EOF versus full body. Exact application-close timestamp remains unverified.

Supplemental diagnostic terminated intentionally (quoted from `.exit`):

```text
unshare -Urn python3 /tmp/opencode/a14/fin-timing.py: 143
```

## r1 — review corrections


Commit `264a5de3`: 4 files +108/-27. Shared `server::route_path` supplies normalized routing and timeout exemption; includes Elysia trailing-slash handling. Hyper header timer disabled in favor of the transport budget, so completed exempt sockets retain exemption. Non-exempt inbound transport and body waits rearm only after 16,384 × idle seconds bytes; inference read_body has no idle deadline. Request changes clear the inbound counter and set/rearm mode. No dependencies; no TS product changes.

Red unit: missing shared function compile error, then normalized test green and trickle test red (7 pass/1 fail); final 9 paused/normal tests pass. Review probes copied (never modified originals) to `r1-probes`, CLI cwd corrected to rust-postgres. Red/green probes run in separate loopback namespaces with real 255s duration. Supplemental slow-header probe trickles an unfinished header at 100/200s.

Residual: raw transport counts header/framing bytes toward threshold; body-specific timer counts decoded body bytes. Thus exotic chunked framing near the threshold may cut earlier via decoded-body timer; no claim of exact Bun internal framing parity. Failed-write/drain corner cases from original report remain unisolated. Production threshold is exactly 4,177,920 bytes for 255s; subsecond test durations use proportional bytes rather than rounded-to-zero seconds.

Historical checkpoint: full gates and isolated burst were pending; final evidence follows below.

Commits at this checkpoint: `264a5de3` (4 files +108/-27), `b03c126f` (1 file +2/-1, ordinary driver now sends normalized inference paths), `b0936e67` (1 file +1/-1, upload test holds socket until shutdown). First full workspace attempt failed only changed test request-log assertion: explicitly dropping an unfinished request body follows existing 500/INTERNAL read-error path, not shutdown 499. Test corrected to assert shutdown cancellation; focused rerun passed. No product error classification was changed beyond scope. First clippy/fmt/size all exit 0. Second full gates completed below.

Both r1 builds produce identical production binary SHA256 `ad7e51bdef724223ca3d3247c08c0a5c646392ecf9615e5ceeab1910c911afc9`; final build after commit `b0936e67`, binary `/tmp/opencode/a14/r1-rust2`. Prior gates/probes using `r1-rust` execute byte-identical production code.

Reviewer evidence remains untouched. Red normalized probe fails JSON/SSE; red completed-exempt stays open frozen vs EOF Rust255s; red inbound count_tokens EOF frozen vs pending Rust at280s. Initial supplemental headers probe failed with BrokenPipe when sending after frozen had already closed, retained; revised select-based probe records closure time without writing after EOF.

### r1 real-duration green results

Normalized JSON/SSE paired probe passes: JSON full 6,291,770 bytes and no EOF; SSE stays open. Completed inference idle stays open at280.10s both. Following ordinary GET closes frozen257.61s vs Rust257.01s from initial POST; pipelined POST+GET closes253.61 vs255.00s (Bun timer granularity). Non-exempt count_tokens trickle now EOF both at278s inspection, no response bytes.
Exact `.exit` lines and classifications will follow. Original reviewer scripts only return measurement completion for inbound/transition; classification above comes from their JSON rows, not process exit alone.

### r1 initial-header discovery

Measured frozen **initial incomplete headers use Bun's 10s default**, before a routed request receives configured255s: standalone frozen EOF12.00s; paired select-based frozen EOF9.52s vs intermediate Rust255.00s. Saved Bun HttpResponseData default idleTimeout=10 agrees. `cfe1c561` adds initial `min(configured idle,10s)` until first routed request; later completed inference stays exempt. Initial header red test is black-box; added paused-time ten-second unit alongside9 existing tests. Final unit10/10 passed. Final commit source tree clean.
`cfe1c561` (1 file +19/-3). Final binary `/tmp/opencode/a14/r1-final`, SHA256 `ef377cb74c908fc7a2e56f5c577e94a56dcf4b9fbb62b050125f5ec36ffd68d9`, built after `cfe1c561`. Earlier r1-rust/rust2 gates are superseded where initial-header behavior matters; final full gates rerunning.
The optional first headers probe failed while writing at100/200s after frozen already closed; no parity claim from its process status. Select-based probe fixes that harness bug. One-byte/200s probe remains equal-truncation expectation, not active-reader expectation.

Final initial-header paired probe: frozen8.397s vs Rust10.002s EOF, empty response, equal class with Bun4s granularity. One-byte/200s intermediate paired probe: both EOF1,796,241 raw remaining bytes, confirming reviewer's minor correction. Final repeats pending.

R1 scope deliberately changes server.rs shared route path and inbound reader, as explicitly required by review rulings. No admin routes modified. `http1_builder` retains its public duration parameter for callers but delegates all budgets to IdleIo at the production listener; standalone test listeners without IdleIo do not acquire idle enforcement. Initial header default uses10s, subsequent ordinary requests255s, completed inference timeout disabled. No new environment knobs.

### r1 retained attempt commands

```text
cargo test --offline -p omni-gateway --lib http::tests: 101
cargo test --offline -p omni-gateway --lib http::tests: 101
cargo test --offline -p omni-gateway --lib http::tests: 0
cargo test --offline -p omni-gateway --lib http::tests: 0
cargo test --offline -p omni-gateway --lib http::tests: 0
cargo build --offline -p omni-gateway: 0
cargo build --offline -p omni-gateway: 0
cargo build --offline -p omni-gateway: 0
cargo test --offline --workspace: 101
cargo clippy --offline --workspace --all-targets -- -D warnings: 0
cargo fmt --all -- --check: 0
cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture: 0
cargo test --offline -p omni-gateway --test server an_exempt_body_that_stops_arriving: 0
normalized probe frozen vs da4b7a99: 1
transition probe frozen vs da4b7a99: 0
inbound probe frozen vs da4b7a99: 0
headers probe frozen vs da4b7a99: 1
normalized probe frozen vs r1-rust: 0
transition probe frozen vs r1-rust: 0
inbound probe frozen vs r1-rust: 0
headers probe frozen vs r1-rust: 1
headers-timed probe: 0
one-byte probe: 0
frozen initial partial headers probe: 0
```

R1 commits since reviewed HEAD:4 commits,5 files, +129/-31 total (including e2e/test updates). Disk checks immediately before builds ranged5.8→5.3GiB; later5.1GiB. Stop threshold remains5GiB; no files/caches deleted. Initial first-round low-throughput wording above is superseded by r1's measured threshold policy. Initial-body logs500 after peer closing is pre-existing and retained; shutdown test499 is a different cancellation path, not evidence they are identical.

Residual initial header implementation:10-second precise Tokio timer matches measured8–12s Bun class, not coarse4-second tick alignment. Incoming initial headers near4.18MiB threshold are not separately probed. Ordinary response/socket writes still rearm on successful nonempty socket I/O, including partial vectored writes. New per-read counter uses a relaxed atomic add; no allocation or syscall; final isolated burst appears below.

### r1 disk boundary

Filesystem transiently fell below5GiB during the second workspace run (5,241,503,744 bytes observed). Attempted TERM to owned cargo-test PID3537881; process had already exited, so no signal delivered. The queued loop completed test/clippy/fmt/size with exit0 before inspection; no further Cargo work started. Available bytes oscillate around5GiB due concurrent environment growth. No deletion/cleanup attempted. Workspace unit binary was built before the last source commit; final focused unit tests and clippy checked the last source. A fresh complete workspace on final initial-header change remains unverified because workspace started before that edit and no rebuild will start below cutoff.

### r1 isolated throughput

After Cargo completed: four alternating base/final bursts,2,000 authenticated JSON requests at concurrency20 and one8,603,191-byte SSE per pass.
base: 7057.80 aggregate req/s, mean SSE 102.69ms.
final: 7044.48 aggregate req/s, mean SSE 101.35ms.
Final/base delta -0.19%; no material regression shown by this short local burst.
```text
unshare -Urn bun --no-env-file /tmp/opencode/a14/r1-burst.ts: 0
```

### r1 Cargo verification evidence

```text
cargo test --offline --workspace: 0
cargo clippy --offline --workspace --all-targets -- -D warnings: 0
cargo fmt --all -- --check: 0
cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture: 0
cargo test --offline -p omni-gateway --lib http::tests: 0
cargo build --offline -p omni-gateway: 0
```

Second workspace passed, all three named historical flakes passed; no flaky rerun needed. That workspace loaded9-test HTTP unit binary before final initial-header change; final focused10-test suite passed separately. Final clippy/fmt/dispatch-size commands executed after final commit; dispatch size3,400 bytes. Fresh final full-workspace run is unverified under5GiB build cutoff; evidence is intentionally not presented as one final all-workspace run.

### r1 final paired probe classifications

All final probes complete with process exit0; rows checked independently for parity. Normalized JSON full6,291,770 bytes, noEOF both; SSE noEOF both. Completed exempt idle remains open280.02/280.01s; next ordinary frozen256.34 vs Rust257.01s; pipeline252.34 vs255.00s. Count_tokens trickle EOF both after278s hold. Initial slow header EOF8.397 vs10.002s. One-byte/200s EOF both1,796,241 remaining raw bytes. Differences in timeout seconds are within Bun4s tick granularity.

```text
normalized probe frozen vs r1-final: 0
transition probe frozen vs r1-final: 0
inbound probe frozen vs r1-final: 0
headers-timed probe frozen vs r1-final: 0
one-byte probe frozen vs r1-final: 0
```

Final JSON behavior assertions independently passed (normalized2 + transition3 + inbound1 + initial headers1 + one-byte1 =8 paired classes; measured rows retained in r1-final-classifications.json). Process exit0 is not used as substitute for row equality.

### r1 final provider gates (completed subset)

```text
bash /tmp/opencode/a14/anthropic-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/r1-final /tmp/opencode/b4/e2e/a14/r1-final-anthropic: 0
bash /tmp/opencode/a14/openai-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/r1-final /tmp/opencode/b4/e2e/a14/r1-final-openai: 0
bash conformance/e2e/antigravity-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/r1-final /tmp/opencode/b4/e2e/a14/r1-final-antigravity: 0
bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/r1-final /tmp/opencode/c1/w-a14-r1-final: 0
```

Historical checkpoint: final run.ts + ordinary normalized idle driver and supplemental silent inference upload were running. They subsequently passed; fresh post-recovery Cargo results and final status follow below.

### r1 controller-provided disk recovery

Controller reported reclaiming its unused main-target build cache (not evidence); independently confirmed14GiB free. No implementer deletion performed. Fresh complete workspace test and clippy at unchanged `cfe1c561` ran after the already-running idle/silent-upload probes finished. Earlier disk-blocked statements above are historical and superseded by the final results below.

### r1 final outcome — verification complete

All requested review corrections implemented in four append-only commits after reviewed HEAD `da4b7a99`:

| Commit | Subject | Files / lines |
|---|---|---|
| `264a5de3` | fix(http): align normalized idle budget transitions | 4, +108/-27 |
| `b03c126f` | test(http): gate normalized inference paths | 1, +2/-1 |
| `b0936e67` | test(http): cancel exempt upload during shutdown | 1, +1/-1 |
| `cfe1c561` | fix(http): match initial Bun header budget | 1, +19/-3 |

Net r1 diff: **5 files, +129/-31**. Worktree clean; no push/merge. Reviewer-owned evidence remains unchanged.

After the running probes completed, a **fresh full workspace test at final `cfe1c561` passed**, including all10 HTTP unit tests (initial-header regression included),1,347 `test ... ok` lines, and all three named historical flakes. No flaky rerun required. Fresh final clippy, fmt and dispatch-size checks passed; concrete dispatch future **3,400 bytes <=5,500**. All Cargo commands used the worktree-local `./target`, offline mode and mandated build settings, one at a time, private HOME and scrubbed PATH. Disk remained14GiB free throughout these final gates.

Final ordinary idle driver passes at the final binary: both static responses truncate after **1,796,096 bytes**, active slow readers stay open, normalized inference JSON completes **6,291,770 bytes**, and SSE stays open. Both stored outcomes are JSON200/null and SSE499/interrupted. WebSocket404/101 remains the previously documented out-of-scope route gap.

Supplemental **silent inference upload** (no body progress for278s) remains pending/open at280s in both frozen and final Rust, with no response bytes: confirms the exemption also removes the former inference-body idle ceiling. Final normalized, transition, inbound, initial-header and one-byte probe behavior classes match frozen as documented above; only coarse Bun timer granularity differs.

Isolated final/base throughput remains **7,044.48 vs7,057.80 req/s (-0.19%)**, mean8.6MiB SSE **101.35 vs102.69ms**. No material regression demonstrated by the short burst.

**Final binary:** `/tmp/opencode/a14/r1-final`  
**Built-after commit:** `cfe1c5618f925d95883fa397f0fcba7c021a11d0`  
**SHA256:** `ef377cb74c908fc7a2e56f5c577e94a56dcf4b9fbb62b050125f5ec36ffd68d9`

Remaining unverified: exact Bun failed-write/drain corner cases; near-threshold chunked/header framing accounting (raw transport bytes vs decoded body bytes); coarse tick alignment; individual upstream/limiter resource counters beyond existing disconnect/destructor coverage. Fresh final full-workspace verification is **no longer blocked or unverified**.

### r1 final command/exit evidence

Quoted verbatim from corresponding `r1-*.exit` files; failed/superseded attempts retained above.

```text
cargo test --offline --workspace: 0
cargo clippy --offline --workspace --all-targets -- -D warnings: 0
cargo fmt --all -- --check: 0
cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture: 0
bash /tmp/opencode/a14/anthropic-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/r1-final /tmp/opencode/b4/e2e/a14/r1-final-anthropic: 0
bash /tmp/opencode/a14/openai-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/r1-final /tmp/opencode/b4/e2e/a14/r1-final-openai: 0
bash conformance/e2e/antigravity-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/r1-final /tmp/opencode/b4/e2e/a14/r1-final-antigravity: 0
bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/r1-final /tmp/opencode/c1/w-a14-r1-final: 0
unshare -Urn bash -c run.ts: 0
bash conformance/e2e/idle-timeout-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/r1-final /tmp/opencode/a14/r1-final-idle: 0
normalized probe frozen vs r1-final: 0
transition probe frozen vs r1-final: 0
inbound probe frozen vs r1-final: 0
headers-timed probe frozen vs r1-final: 0
one-byte probe frozen vs r1-final: 0
silent inference body probe: 0
unshare -Urn bun --no-env-file /tmp/opencode/a14/r1-burst.ts: 0
```
