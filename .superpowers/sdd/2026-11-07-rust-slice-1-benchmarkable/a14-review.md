# A14 independent review

Verdict: **REQUEST CHANGES** — confirmed new normalization/exemption mismatch truncates inference JSON and SSE. All requested standard gates pass; they do not cover this raw-path case.

## Findings (incremental)

### Important — NEW normalized inference path loses exemption and truncates JSON/SSE

`lib.rs:527–528` tests raw `req.uri().path()`, whereas `server.rs:486–492` explicitly normalizes WHATWG dot segments and backslashes before routing. A raw POST `/v1/x/../chat/completions` routes to inference but is marked non-inference by the new timer. Frozen uses normalized routing and invokes `apps/gateway/src/routes/proxy.ts:1016`.

**Paired real-duration reproduction confirmed** (`normalized/sockets.json`, `normalized.log`, `normalized.exit:1`): authenticated POST JSON and SSE through this raw path, 4 KiB receive window, stop reading after headers, resume after 278 s. Frozen JSON delivers all **6,291,770** bytes and remains open; final Rust JSON EOF after **1,793,935** bytes. Frozen SSE remains open (12,629,092 raw bytes during bounded drain); final Rust SSE EOF after **1,798,144** bytes. Both initially return HTTP 200; final SSE logs interrupted. Exact close timestamp is not inferred from buffered FIN. **Independent base comparison passes** (`base-normalized.exit:0`): base JSON delivers all 6,291,770 bytes and base SSE remains open (12,826,360 raw bytes); frozen remains open for both. This confirms an A14 regression, not an inherited gap. Fix: select exemption from the same normalized pathname used by routing; add a raw-socket regression for normalized spelling of each exempt route.

### Important — existing completed-exempt keep-alive mismatch

Frozen `routes/proxy.ts:1016` disables timeout for the request and leaves the completed connection exempt until a subsequent ordinary request. Rust `lib.rs:248`'s pre-existing Hyper header timeout independently closes the idle connection at 255 seconds, even though the new `http.rs:48–50` timer stays disabled. Paired raw-socket POST `{}` (no Authorization, 401 response), then wait: frozen remains open at 280.09 s, Rust EOF at 255.00 s. Subsequent GET /health on the same connection: frozen EOF 257.59 s, Rust 257.00 s from initial POST, including a two-second spacing. Pipelined POST+GET: frozen 253.59 s, Rust 255.00 s. **Baseline independently confirms the same mismatch** (`base-transition/extra.json`: frozen open 280.10 s, base EOF 255.00 s; next request and pipeline equal by timeout class). This is not newly attributed to A14; scope decision left to controller.

### Important — non-exempt inbound low-throughput upload differs (existing code; scope undecided)

Frozen `routes/proxy.ts:1060–1066` authenticates and reads count_tokens JSON without `server.timeout(request,0)`; Bun HttpContext.h:682–686 requires 16 KiB/s worth of bytes before rearming. Rust `server.rs:754–773` instead resets on every frame (unchanged from base). Paired authenticated POST `/v1/messages/count_tokens`, Content-Length 10,000, send `{`, then spaces at 100 and 200 seconds: frozen EOF when inspected at 278 s; final Rust still pending at 280 s (`inbound/body.json`, inbound.exit:0). No total-body deadline was tested. **Independent base probe reproduces exactly the same difference** (`base-inbound/body.json`, base-inbound.exit:0). Reported without deciding whether inbound parity belongs in A14 or a separate item.

### Minor — probe expectations must distinguish socket progress from application reads

Requested “read one byte every 200 s must stay open” is not true of the frozen oracle with a full TCP receive window. Both truncate a 32 MiB static response after 1,796,241 remaining bytes (two bytes already consumed separately) and EOF at 278 s. This is an equal behavior class, not a Rust defect. Regularly draining 8 KiB every 80 ms is the separate active-reader class.

### Probe harness failures retained

`driver.exit:1` is the copied driver's exact-two-log-rows postcondition, invalidated by extra inference POST probes; original socket assertions printed PASS. No product failure inferred. `export.exit:1` was a reviewer script-generation syntax error; `export2` initially exercised a 400 because since/until are mandatory; corrected `export3` tests actual streaming export. Unauthenticated slow-body row is invalid as an inbound test (auth rejects before body read); replaced by authenticated body probe.

## Source review

Frozen `apps/gateway/src/routes/proxy.ts:1008,1012,1016` explicitly calls `server.timeout(request,0)` for all three inference POST handlers. `index.ts:405–414` says other routes get 255 seconds. Reviewer independently verified frozen/final executable full hashes against the report.

`http.rs:23–27,89–129`: only Ready/Ok nonempty transport reads/writes touch the timestamp; vectored partial writes count; Pending, errors, zero, flush and shutdown do not. A pending write is polled again and its eventual Ready/Ok counts. One Arc allocation per connection, two atomic fields, one Notify and monotonic origin; no per-chunk allocation or extra socket syscall (Instant uses platform clock; no syscall tracing performed). Existing vectored capability preserved. No panic/expect on production I/O paths.

`http.rs:38–57`: no periodic granularity added while enabled: timer sleeps to the recorded deadline, rechecks latest activity, and sleeps exactly to the new deadline. Scheduling delay remains possible; the clock is tokio monotonic Instant. Disabled mode wakes every idle duration or on a request Notify. One retained Notify permit prevents a lost re-enable wake. Connection polling and service mode changes occur within the same connection future; a simultaneous readiness/expiry race remains normal select boundary behavior, not an atomic multi-task protocol. HTTP/1 hyper serializes response dispatch; no HTTP/2 support is introduced.

Frozen saved Bun 1.4.4 source: HttpResponse.h:56–65 sets/resets a per-socket timeout; 849–850 and 890–891 rearm after writes even without requiring positive progress. HttpContext.h:935–936 disables timeout during a writable callback and :1015–1016 rearms afterward. :682–686 resets inbound body timeout only after `16384 * idleTimeout` received bytes. Thus “only successful socket I/O” is a useful Rust policy, NOT an exact line-for-line model of every Bun write/drain path. Black-box cases are needed.

Rust inbound `server.rs:754–773` already reset a 255-second frame timeout on every frame at base `3a0a230a`; slow-body differences are not newly introduced by this patch. Scope decision left to controller.

Export cancellation has no upstream, inference limiter claim, Finisher, or inference writer slot to release: `admin_routes.rs:302–328` streams database pages. Its reader semaphore/lease is explicitly released before each socket await (:82–124). Dropping hyper drops the suspended generator; an already running spawn_blocking page read is not synchronously cancelled but is bounded and returns its lease. A socket probe cannot prove nonexistent inference resources for this route.

## Gates completed

Quoted from reviewer `.exit` files (not implementer claims):

```text
cargo test --offline --workspace: 0
cargo clippy --offline --workspace --all-targets -- -D warnings: 0
cargo fmt --all -- --check: 0
cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture: 0
unshare -Urn bash -c 'ip link set lo up; bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a14/rust-final2': 0
```

Workspace passed first attempt, 1,343 `test ... ok` lines. All three named historical flakes passed (workspace.log:1292,2379,2504); no rerun needed. dispatch_size: 3,400 bytes. `run.ts`: all rows equal (50 table lines including headers). No admin-routes driver run. All Cargo commands sequential, offline, jobs=2, incremental=0, shared warm target, private HOME; all Rust files touched first. Disk remained above 5 GiB at each build boundary.

## Further socket results

`sockets/extra.json`: ordinary metrics and HEAD responses idle-close in both (frozen 253.59 s, Rust 255.00 s); metrics body sizes differ as expected for telemetry, not an idle regression. Early write-half-close after GET /health delivers full 200 then EOF in both within 30 ms. `export/export.json` large admin JSON (3,231,975 bytes) truncates identically at 1,793,921 bytes with EOF after hold. Empty/missing export dates returned equal 400; not counted as stalled export coverage.

`body/body.json`: authenticated inference slow upload (opening `{`, one space at 100 s and 200 s, unfinished body) remains open in both at 280 s. This route is exempt in frozen, so it does not exercise the 16 KiB/s non-exempt rule. Non-exempt count_tokens differs as documented above. Inference body silence past 255 s is still enforced by Rust's pre-existing read_body even though frozen exempt mode has no socket idle ceiling; this exact silent-body variant was not measured here.

`export-valid/export.json`: **actual stalled streaming JSONL export**, valid since/until, 6,000 seeded log rows with 6,000-character model field. Both return 200 chunked then EOF with exactly 1,793,810 raw body bytes at 278 s; far short of the ~38 MiB dataset. Concurrent large admin JSON again truncates identically at 1,793,921 / 3,231,975 bytes. Two independent admin runs agree. Shutdown snapshots contain exactly the 6,000 fixture rows and no inference rows; exports do not create inference request logs. This proves socket truncation, not individual destructor resource counters.

Pristine unmodified idle driver passes all six paired socket classes and both stored-row assertions (JSON 200/null, SSE 499/interrupted): `pristine.exit`: `bash conformance/e2e/idle-timeout-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a14/rust-final2 /tmp/opencode/a14-review/pristine: 0`.

Additional command/status evidence quoted from `.exit` files (full normalized command also retained in `normalized-full.exit`):

```text
unshare -Urn bun --no-env-file /tmp/opencode/a14-review/normalized.ts: 1
unshare -Urn bun --no-env-file /tmp/opencode/a14-review/normalized.ts --rust /tmp/opencode/a14/rust-base: 0
unshare -Urn bun --no-env-file /tmp/opencode/a14-review/transition.ts --rust /tmp/opencode/a14/rust-base: 0
unshare -Urn bun --no-env-file /tmp/opencode/a14-review/inbound.ts: 0
unshare -Urn bun --no-env-file /tmp/opencode/a14-review/inbound.ts --rust /tmp/opencode/a14/rust-base: 0
unshare -Urn bun --no-env-file /tmp/opencode/a14-review/body.ts: 0
unshare -Urn bun --no-env-file /tmp/opencode/a14-review/export.ts --work /tmp/opencode/a14-review/export-valid: 0
```

The custom scripts log these shortened command labels, but every actual invocation used `unshare -Urn bash -c 'ip link set lo up; bun --no-env-file …'`, explicit --ts/--rust/--work, private HOME and `env -i`; full commands are also in harness completion evidence. Custom probe exit 0 means the measurement completed, not that parity holds; individual rows above determine parity.

## Throughput

Reviewer repeat after Cargo finished: four alternating base/final pairs, 2,000 authenticated nonstream requests each at concurrency 20; one 8,603,191-byte SSE per pass. Base aggregate 7,382.77 req/s; final 7,315.96 req/s (-0.91%). SSE mean base 108.34 ms, final 102.42 ms. Short local test, not a statistical proof; no material slowdown demonstrated. CPU contention from other namespaces/other work is not controlled globally. `burst2.exit`: `unshare -Urn bash -c 'ip link set lo up; bun --no-env-file /tmp/opencode/a14-review/burst2.ts': 0`. Initial burst.exit:1 was a reviewer fixture key created in a different CLI default database; corrected by writing private seed .env, never reading a real environment file.

## Unverified / limits

No actual 304-producing route was identified; neither frozen gateway source nor Rust has an explicit ETag/If-Modified-Since handler. HEAD is measured, but 304 is not claimed. Partial writes and read/write progress are source/unit covered and blocked TCP behavior measured; failed Bun write attempts and writable-drain-without-positive-progress were not isolated black-box. Boundary scheduling races are not stress-tested. Pipelining covers completed exempt 401 followed by health, not two simultaneous long inference responses (Hyper dispatch is serial). Individual upstream, writer-slot and limiter destructor counters were not instrumented for export, which owns none of those resources. No product mutation was made. Existing claim-drop unit test and real inference interrupted-row evidence are narrower than proving every possible resource path. WebSocket 404/101 remains explicitly outside A14.

Evidence is reviewer-owned under this directory; implementer evidence is read-only.

## Counts by unique final-vs-frozen probe class

19 valid paired classes (38 sockets; repeats and invalid fixtures excluded):

| Group | Classes | Equal by idle-behavior class | Different |
|---|---:|---:|---:|
| Standard static, inference JSON/SSE, health keepalive, active reader | 5 | 5 | 0 |
| WebSocket (known A9 gap) | 1 | 0 | 1 existing |
| Completed exempt idle / next ordinary request / pipeline | 3 | 2 | 1 existing |
| Half-close, one-byte/200 s, HEAD, metrics | 4 | 4 | 0 |
| Valid streaming export / large admin JSON | 2 | 2 | 0 |
| Authenticated inference / count_tokens slow upload | 2 | 1 | 1 pre-existing policy |
| Normalized-path JSON / SSE | 2 | 0 | **2 new** |
| **Total** | **19** | **14** | **5** |

Base cross-checks independently repeat completed-exempt transitions (3 classes), normalized-path JSON/SSE (2 classes), and count_tokens upload (1 class). No Critical finding. Important findings: 1 new blocker, 2 inherited gaps reported without scope ruling. Minor: 1 oracle expectation correction.

## Restoration

No checkout content was edited; all scripts/fixtures/evidence are under `/tmp/opencode/a14-review/`. Only requested Rust mtimes were touched. `restoration.txt`:

```text
git diff --exit-code: 0
da4b7a9927d1eb376019aba83373d48ad13c9ecc
git symbolic-ref -q HEAD: 1 (1 = detached)
```

`git status --porcelain=v1` produced no output (no tracked or untracked changes). No commits, resets, deletions, subagents, admin-routes driver, real `.env`, or global OmniGateway config access. Gate build disk checks were 6.9 GiB for workspace and 6.2 GiB for clippy/fmt/size; later overall minimum observed 6.0 GiB, above the 5 GiB stop threshold.
