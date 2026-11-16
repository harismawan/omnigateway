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
