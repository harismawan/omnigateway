# A3 body capture — checkpoint

Branch `feat/rust-body-capture`; worktree `/home/homebrew/.local/share/opencode/worktree/1600a1/rust-postgres`.

Stopped cleanly after the pure-parts checkpoint to avoid exhausting context. No capture is wired into gateway traffic yet. Working tree clean at checkpoint.

## Frozen design note

Read bodyCapture.ts, mask.ts, bound.ts, artifact.ts, SQLite/Postgres bodies repos, migration 008, CLI bodies, proxy gate/capture call sites and HTTP read path before editing. Frozen pure source files are unchanged from `1780bb39` (`git diff` checked).

- Capture gates, in order: boot environment permission; authenticated key opt-out; snapshot setting. Off bypasses collection and transport decoration entirely.
- Client request is parsed incoming JSON before RTK; outbound attempts are actual transport calls (including auth retries), after RTK/cloaking. Headers are never collected. Client stream response is emitted SSE frames; provider streams are tee-drained to completion, dropping bytes after cap, independently of adapter consumption. Capture uses 512 KiB per-body soft limits, then structural bounds and artifact ceiling.
- finishLog first attempts usage.append, performs debit/events, then calls the body callback with its own failure catch; capture failure must not change client success or failure. Collector settle is at persistence, not dispatch.
- Mask every string value, never keys, before bounding. Limits: 64 KiB strings (UTF-8), last 24 array entries, depth 6 containers, first 80 object properties in JS enumeration order. Whole-artifact omission at 512 KiB.
- OGBA v1 raw header is 10 bytes, authenticated as AAD; random independent 12-byte nonce; AES-256-GCM with 16-byte tag. Store key PBKDF2-HMAC-SHA256 salt `omnigateway-field-encryption-v1`, 210000 rounds. Existing PG implementation already provides raw sealing, raw/gzip/legacy decoding, digest validation and date-shard paths; reused without new dependencies.
- SQLite artifacts are `request_bodies/YYYY/MM/DD/<id>.json.enc` beside database. File precedes row upsert. A11 deletion/orphan logic lives in omni-control/src/database.rs and must be reused in step 2.
- HTTP GET `/api/requests/:id/body` requires operator admin, not reader. Absent row returns 200 with `{requestId,detailState:"none",truncated:false,sizeBytes:0,at:null,artifact:null}`; other rows expose artifact and metadata, not relPath/sha256. CLI implementation remains E3.

## Differences / fidelity cautions

1. Brief mentions atomic writes; frozen `writeArtifact` actually calls recursive mkdir then plain writeFile directly, with no temp/rename. Follow frozen, do not introduce atomic rename semantics silently.
2. BodyRepo has no clear method; control clear_bodies calls prune then orphan sweep. Preserve that existing control operation.
3. X1 carrier rules: new pure API uses JsValue UTF-16, preserving lone surrogates through masking and uncut bounding. Over-limit TextEncoder/TextDecoder truncation alone replaces malformed code units, and default TextDecoder strips an initial BOM. No blanket normalization was introduced.
4. **Unresolved before store/capture integration:** existing `pg::bodies::decode` returns serde_json::Value, so a valid frozen artifact with a JSON lone-surrogate escape cannot be represented/read exactly. Pure prepare has a lone-surrogate differential test, but cross-read currently uses Unicode scalar text only. Do not silently normalize or invent a new representation: finish the existing X1-carrier integration in the shared artifact reader, then test both directions with lone surrogates. This checkpoint does not claim full artifact-carrier fidelity.

## Step 1 checkpoint

Commit `5f0f6e06` — `feat(store): A3 1/5 add body capture pure parts`.

Four files, 541 insertions. Adds JsValue mask/bound/prepare helpers and Bun frozen reference driver. No new dependencies, no TS product edits, no bun.lock edits, no X3 file edits.

Tests: four passing Rust tests; 364 mask/bound differential inputs (nested headers/tool args, prefix/run boundaries, depth, numeric object-key ordering, string byte boundaries, BOM, surrogate values/keys); seven prepare fixtures including omission and oversized error fallback; both seal/read directions on scalar Unicode plaintext; 318 existing frozen corrupt/truncated/gzip/legacy verdicts. Rust-written raw plaintext is checked byte-exact by WebCrypto decryption in frozen reference. Reverse-direction plaintext is currently compared as parsed value, not raw bytes — extend before calling all of step 1 complete.

Red-first evidence: step1-red.exit/log (missing module compile failure). Failed intermediate attempts retained. Initial base build succeeded but copy used wrong binary filename; corrected to `target/debug/omnigateway` before any implementation commit. Base build exit records cargo only, not that initial copy attempt.

## Verified commands (quoted from .exit files)

```text
cargo test --offline -p omni-store --test body_pure -- --nocapture: 0
cargo clippy --offline -p omni-store --test body_pure -- -D warnings: 0
cargo fmt --all -- --check: 0
cargo build --offline -p omni-gateway: 0
cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture: 0
```

Sources respectively: step1-final-test.exit, step1-final-clippy.exit, step1-final-fmt.exit, step1-build.exit, step1-dispatch.exit. Matching logs retained. Dispatch concrete state machine **3400 bytes**, unchanged, ceiling 5500.

All cargo invocations offline, private HOME, explicit scrubbed PATH (including required directories), CARGO_HOME=/home/homebrew/.cargo, jobs=2, incremental=0 and dev/test debug=0. One cargo command at a time. Disk before final build 7.3 GiB available. Every Bun reference invocation uses --no-env-file. No provider traffic generated.

## Binaries

- `/tmp/opencode/a3/rust-base`, commit `e41a2ad46394a21c47e302a6d49a1cdcf5c7ff83`, SHA256 `b6472a30956a2a4acbe3121f461d46a2844ba4e6d4466ecf6d6dfdfa2db79ce3`.
- `/tmp/opencode/a3/rust-step1`, commit `5f0f6e06`, SHA256 `f0c57d38e134ceec242d0901ebb3b2af769738f89158cd193f3bd560dd1f4a80`.

## Remaining

- Complete step 1 artifact reader carrier fidelity and byte-exact reverse plaintext assertions; broaden artifact total-size boundary tests, array/object depth boundary permutations.
- Step 2 SQLite put/get and shared PG semantics (prepare must precede put), read-state recovery, safe ID checks, maintenance clear/prune interplay.
- Step 3 exact collector/request-path integration, default-off overhead, three gates, wire attempts, streams/limits, ordering and failure isolation.
- Step 4 admin HTTP read route.
- Step 5 conformance/e2e/body-capture.ts and -ns.sh; red baseline driver and green capture driver (baseline binary preserved).
- Final whole-workspace test/clippy/fmt, maintenance driver, anthropic/openai namespace copies with --no-env-file, antigravity, smart-router, run.ts namespace driver. **Not run; no success claimed.** Admin-routes reserved for controller. No push/merge.

## s2 — reader fidelity + SQLite checkpoint

Clean HEAD `8dbf9d52` (`feat(store): A3 2/5 sqlite bodies (41 cases)`), preceded by `18a015da` (`feat(store): A3 1b/5 lossless artifact reader (691 cases)`). No steps 3–5 begun. No dependencies added, frozen product TS/bun.lock unchanged, no X3 files edited. Frozen body sources/migration checked against `1780bb39` with empty diff.

### Step 1b

- Shared `pg::bodies::decode` and `BodyRead.artifact` now use `JsValue`; plaintext parsing uses `parse_js`, retaining lone UTF-16 surrogates, JS-rounded numbers, negative zero and overflowing numbers. `decode_plaintext` exposes authenticated plaintext for byte-exact verification. Client readers use `decode`, which still requires an object.
- Six additional bidirectional fixtures: lone surrogates plus unusual numbers, BOM, depth-six mixed containers, strings of 65535/65536/65537 bytes. Both directions compare decrypted plaintext byte-for-byte; frozen parsed/stringified result also compared against Rust's carrier.
- Three whole-artifact size cases: 524287/524288 retained, 524289 omitted; differential prepared bytes. Existing 364 pure cases, 318 envelope verdicts and seven prepare fixtures remain passing. Commit's 691 count counts 364 + 318 + nine new cases, not the seven existing prepare fixtures.
- No production serde artifact-read path remains. Only scalar fixture assertions in `pg_cross_read.rs` convert back to serde for indexing; corpus tests convert expected serde values into JsValue. Important decoder detail: frozen TextDecoder strips one leading BOM before JSON.parse; raw decrypted plaintext is kept intact for verification.

### Step 2

- Added SQLite `SqliteStore::{put_body,get_body}` plus connection-level functions, migrated table reused unchanged. Prepare/mask/bound precedes sealing; safe-id validation precedes preparation. Plain recursive mkdir/write precedes upsert; no temporary file or rename. SQLite values bind TEXT/INTEGER/NULL exactly for valid body rows, with `truncated === 1` read semantics. Unknown states map to none; null paths suppress reads; missing/corrupt observations persist, and restored files recover to ready. Reader uses one file handle, metadata ceiling, and one extra byte to detect growth.
- Moved A11 Node POSIX join implementation into store bodies, reused by control deletion and new reads/writes: no second path helper copy. Existing prune/cap/orphan implementations retained, including file-first deletion and claim recheck.
- PG `put_body_artifact` now shares full preparation with SQLite; existing `put_body` remains explicitly a low-level prepared-JSON interface for cross-read callers. PG retains single-statement bytes+row upsert, server-side size ceiling, and no filesystem orphan sweep. No PG runtime run.
- 38 frozen SQLite operation fixtures compare typed row cells (including typeof every column), actual ciphertext digest validity, exact decrypted plaintext, returned artifact strings/states, overwrite on a different day, absent/missing/corrupt/recovered files, unknown state, seven unsafe ids, stable cap ties, strict retention horizon and orphan cleanup. Ciphertext digest strings differ intentionally with random IVs; each is checked against its own actual bytes, while size/type/plaintext are compared directly.
- Three unit cases cover file-before-refused-upsert and mkdir failure, null path/unknown state/oversized file, and shared PG preparation/sealing. Total step-2 count: 41.
- Brief correction remains plain mkdir/write, not atomic replacement, as frozen specifies. Maintenance e2e itself exercises boot/heartbeat typed tables, **not body pruning**; explicit differential SQLite tests above exercise body prune/cap/orphan interplay.

### Gates (quoted from s2 .exit files)

```text
cargo test --offline -p omni-store -p omni-control: 0
cargo test --offline --workspace: 0
cargo clippy --offline --workspace --all-targets -- -D warnings: 0
cargo fmt --all -- --check: 0
cargo build --offline -p omni-gateway: 0
unshare -Urn bash -c ip link set lo up; exec bun --no-env-file conformance/e2e/maintenance.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a3/s2-rust-final: 0
```

Sources: `s2-store-control-final.exit`, `s2-workspace-final.exit`, `s2-clippy2.exit`, `s2-fmt.exit`, `s2-build.exit`, `s2-maintenance.exit`; matching logs retained. Whole workspace passed both runs without known flaky failures/retry. Existing ignored benchmarks and unavailable PG-runtime tests retain their existing behavior; no PG-runtime claim. Failed attempts retained: SQLite compile name collision, reference setup missing api_keys, reference backup fixture mistake, and clippy fixture unwrap lint. Final clippy permits unwrap only in fixture tests, not production.

Final binary built after final commit: `/tmp/opencode/a3/s2-rust-final`; commit/hash in `s2-rust-final.commit` / `.sha256`; SHA256 `8b590fd0cd010a5020c875005008e28b3fc096facc5cca8b8d4b0c8be41a07f0`. All commands use explicit scrubbed environment/private HOME, offline Cargo with prescribed flags and own target, Bun --no-env-file, maintenance inside private user/network namespace. Disk available at end 6.5 GiB. No files deleted, no push/merge.

### Remaining for controller

Steps 3–5 unchanged: collector/request-path three gates, transport/stream capture and failure isolation; admin body route using JsValue (do not convert artifacts to serde); driver baseline-red/final-green. Wire callers to SQLite put_body or PG put_body_artifact, not PG's low-level already-prepared entry point. No request capture or HTTP read route wired here. Additional end-to-end/provider suites listed above remain controller work.

## s3 — collector-only clean checkpoint (step 3 NOT complete)

HEAD `14a7c98937051c85ec2fece3d65e252b1abb3755` (`feat(gateway): A3 3a/5 collector primitives (83 cases)`), clean. Stopped at a coherent partial commit; **no request-path capture, admin body route, or black-box driver is claimed**. No TS product/bun.lock changes, new dependencies, X3-file changes, pushes, merges, or deletion. Frozen bodyCapture/proxy/store-body source diff against `1780bb39` empty.

Added `crates/omni-gateway/src/body_capture.rs`: lossless JsValue client/attempt assembly; wire-order attempts including a thrown transport; buffered request/response UTF-16 soft caps; streaming UTF-8 replacement decoder with BOM suppression and partial-suffix behavior; soft byte cap retaining the crossing chunk and dropping subsequent bytes; failed-drain partial response; optional blank-line SSE records; bounded client frame sink retaining latest writes. These are primitives only, deliberately not yet installed on transports. No production hot-path behavior changes.

`conformance/store/body-capture-reference.ts` imports unchanged frozen bodyCapture directly. `tests/body_capture.rs` compares 64 collector and 15 sink fixtures byte-for-byte, plus four focused unit cases (83 logical cases; six Rust test functions). Includes UTF-16 lone-surrogate parsed JSON, malformed/incomplete UTF-8, split BOM/scalars, CRLF SSE, exact 512-Ki boundaries, crossing-chunk retention, discarded tails, thrown calls, empty bodies and sink eviction. The differential stream oracle touches its adapter body but never consumes the adapter branch: frozen tee completion is independent. This DOES NOT prove a Rust transport tee yet. Unit suite first failed with absent module import (`s3-collector-red`); initial three focused cases passed after implementation, then differential/edge cases expanded (not all cases individually red first).

### Gates (verbatim .exit lines)

```text
cargo test --offline -p omni-gateway --test body_capture: 101
cargo test --offline -p omni-gateway --test body_capture -- --nocapture: 0
cargo test --offline --workspace: 101
cargo test --offline --workspace: 0
cargo clippy --offline --workspace --all-targets -- -D warnings: 0
cargo fmt --all -- --check: 0
cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture: 0
cargo build --offline -p omni-gateway: 0
```

Sources respectively `s3-collector-red.exit`, `s3-collector-final.exit`, `s3-workspace.exit`, `s3-workspace-rerun.exit`, `s3-clippy-final.exit`, `s3-fmt-final.exit`, `s3-dispatch-size.exit`, `s3-build-checkpoint.exit`, matching logs retained. Workspace first run hit known `http::drain_tests::admitted_drain_replaces_oldest_idle` (`socket closed: Elapsed(())`); one full workspace rerun alone passed (208 test-result summaries). Dispatch state machine stays 3400 bytes, ceiling unchanged 5500. fmt checked immediately before checkpoint commit; binary built after commit.

Binary `/tmp/opencode/a3/s3-rust-checkpoint`, SHA256 `ed27f6744d41df5ef54ffff19b1e0af4682df06303c1f54c93d6f045b5afe303`; commit recorded in `s3-rust-checkpoint.commit`, digest in `.sha256`. Explicit scrubbed environment/private HOME/offline prescribed cargo flags used. Disk 5.7 GiB available at stop (above 5 GiB stop threshold). No e2e/provider traffic generated.

### Remaining

- Finish step 3: ordered env/key/held-snapshot gates; parsed client request before ingress transforms; actual transport calls after codec/cloaking including auth retries; independent stream tee/drain; collect individual emitted client SSE writes before coalescing (including keepalive per frozen writer), JSON/error client responses; collector settle at persistence; usage append then debit/events then separately caught body callback; cancellation/failure isolation; SQLite and PG integration. Existing ResponseBody is concrete with native framing, so tee needs a deliberate seam rather than an adapter-only observer. Existing Finisher queues completion asynchronously; do not persist bodies ahead of committed completion/debits. Measure 2000-request off-path base/final burst; none measured here.
- Steps 4 and 5 entirely remain, including requested commit subjects. No driver red/green evidence yet, no new unavoidable differences identified. All specified e2e gates (maintenance, idle, smart-router, antigravity, anthropic/openai, run.ts) remain unrun for this checkpoint; controller owns admin-routes as specified.

## s4 — step 3b request-path capture wiring

Clean commit `5a98459207629474c10c818a4eb9a292bdba8a04`, `feat(gateway): A3 3b/5 capture wiring (23 cases)`. Steps 4 (admin read route) and 5 (black-box body driver) deliberately untouched. No TS product/bun.lock edits, new dependencies, X3-file edits, push or merge. Frozen bodyCapture.ts and routes/proxy.ts diff against `1780bb39` remains empty.

### Wiring

- Request route short-circuits boot permission, authenticated key opt-out, then held authentication snapshot settings. Closed gates create neither collector nor transport decorator. Parsed lossless incoming JSON is saved before dialect ingress. Request-local dependency clone wraps actual provider calls after encoding/cloaking; retry calls share the collector. Correlation-id filtering excludes independently logged classifier requests; OAuth refresh uses the original refresher transport, not the decorated inference transport.
- ResponseBody gains an optional raw-byte observer and independent streaming tee. The adapter explicitly selects streaming before returning its event stream; this starts the drain even if events are subsequently abandoned. Buffered text retains the original Buffer-style decoder and error semantics. The source drains beyond the capture cap; an abandoned adapter receiver discards subsequent channel writes. No capture allocations occur in ordinary per-chunk reads. Public-boundary inventories explicitly document the two new non-JSON body seams and observer re-export.
- JSON success/error responses and individual emitted SSE records, including keepalive, enter the client half before coalescing. Cancellation marks client truncation. Frame-sink eviction contributes truncation at persistence.
- Finisher queues usage first. A dedicated FIFO fence is acknowledged by the existing commit/debit consumer after preceding completion events; body callback runs after that acknowledgment and waits for collector drains only at persistence. Callback tasks are retained/reaped and joined before Writer::close signals shutdown. SQLite blocking put and PG put_body_artifact share the callback. Persistence failures warn with frozen message `failed to persist request bodies`, requestId and reason, without changing the client result.
- Existing Rust limitations are not repaired by this item: plugin lifecycle events are unported, and failed/dropped usage rows do not produce the successful-commit debit notifications that the existing limiter consumes (frozen debits even on append failure). The new body callback nevertheless executes after attempted append/fence even when the row fails. These are existing finishLog differences, not frozen-vs-brief corrections. PG callback branch uses the implemented PG store API; the running gateway in this checkpoint still boots its existing SQLite backend.

### Tests and evidence

`capture_wiring.rs`: 23 logical cases in three test functions: 21 real HTTP/scripted-provider cases across chat/completions, messages and responses (boot off, setting off, key opt-out, JSON, SSE, persistence failure, oversize provider tail), independent drain after adapter abandonment, and Anthropic OAuth 401/refresh/auth retry. The retry test compares the actual inference calls against the frozen collector and confirms refresh is not captured. Nine persisted plaintext artifacts are compared byte-for-byte against frozen collector assembly plus existing prepare_put; dynamic id/time are supplied from the actual artifact, and emitted client responses are replayed to the collector oracle rather than independently re-rendered by TS. The previous 83 collector/sink cases remain.

Red-first evidence is partial: initial test compilation failed for missing wrap/settle APIs (and an Option formatting mistake). Additional integration matrix and retry/oracle cases were added after basic wiring, not individually red first. Initial expanded retry compilation also failed for tools Option type; retained. Initial workspace gates caught boundary inventory additions and the per-chunk allocation tripwire; fixed by documenting the new boundary and starting the tee at adapter body selection, not per read. No listed load flake occurred in the final runs. All failed logs/.exit files retained.

Final workspace run has 209 successful test-result summaries. Dispatch concrete future is **3448 bytes**, up from 3400 because of the response-body seam, under unchanged 5500 ceiling. Smart-router: 102 equal / 0 failed / 0 invalid oracle. run.ts: all rows equal, including 37 request logs, 18 daily rows, six rollup rows and four health rows. These e2e runs use default capture off and isolated loopback namespaces.

### Gates (verbatim .exit lines)

```text
cargo test --offline -p omni-gateway --test capture_wiring: 101
cargo test --offline -p omni-gateway --test capture_wiring: 0
cargo test --offline --workspace: 101
cargo test --offline --workspace: 101
cargo test --offline --workspace: 0
cargo test --offline --workspace: 0
cargo clippy --offline --workspace --all-targets -- -D warnings: 0
cargo fmt --all -- --check: 0
cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture: 0
cargo build --offline -p omni-gateway: 0
bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a3/s4-rust /tmp/opencode/c1/w-a3: 0
unshare -Urn bash -c 'ip link set lo up; bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a3/s4-rust': 0
unshare -Urn bash -c 'ip link set lo up; bun --no-env-file /tmp/opencode/a3/s4-off-burst.ts': 0
```

Sources in order: `s4-wiring-red.exit`, `s4-wiring-differential.exit`, `s4-workspace.exit`, `s4-workspace-rerun.exit`, `s4-workspace-final.exit`, `s4-workspace-gate.exit`, `s4-clippy-gate.exit`, `s4-fmt-gate.exit`, `s4-dispatch-size.exit`, `s4-build.exit`, `s4-smart-router.exit`, `s4-e2e.exit`, `s4-off-burst-measured.exit`. Four earlier clippy failures (must-use sends, collapsible ifs, mutable body selection, test guard lifetime), expanded-test compile error, and three burst fixture setup failures are preserved in other `s4-*.log/.exit` pairs. The burst failures were missing seed directory, required model isAlias, and wrong seed database filename; no measured result was replaced.

### Capture-OFF measurement

One base/final pair, debug binaries, 2000 non-stream requests at concurrency 20 plus one large SSE (~1.26M emitted client characters), inside `unshare -Urn`. Both databases have zero request_bodies rows. This is a smoke comparison, not a statistically controlled performance claim.

| Binary | Burst ms | requests/s | large SSE ms | HWM before / after burst / after SSE KiB |
|---|---:|---:|---:|---|
| base e41a2ad4 | 271.21 | 7374.29 | 21.00 | 26668 / 39308 / 39952 |
| final 5a984592 | 283.42 | 7056.58 | 22.46 | 27216 / 38732 / 39336 |

Evidence: `s4-off-burst.ts`, `s4-off-burst-measured.log/.exit`, isolated `s4-burst-measured/` databases and process logs. Final throughput -4.31% in this single pair; final post-SSE HWM -616 KiB. No collection/decorators on OFF path by code gate and zero persisted rows.

Binary built AFTER commit: `/tmp/opencode/a3/s4-rust`, SHA256 `eca1fccff788f93cc1ff9749dd7cc46b513abb8dff303cc1bb110a2b2e80f7d0`; commit/digest recorded in `s4-rust.commit/.sha256`. fmt passed before commit, explicit private HOME/scrubbed PATH/offline prescribed cargo flags used, one cargo command at a time. Disk remained ~20 GiB free. Working tree clean at stopping point.

### Remaining for next session

Steps 4–5 only: admin-only GET body reader route with frozen absent-row metadata, and dedicated black-box body e2e driver exercising enabled capture, authorization, persisted artifacts and errors. Strengthen that driver's independent client-frame/render comparisons and end-to-end cancellation timing; current differential oracle deliberately replays observed client output. No admin route or body-specific e2e driver is claimed here.

## s5 — step 4 body read route; clean checkpoint before step 5

Commit `007d00af4bb08361ed4d99da058480c5318d475a`, `feat(gateway): A3 4/5 body read route (29 cases)`. Working tree clean. **Step 5 is NOT implemented; no body-driver baseline-red/final-green claim.** Stopped at the requested clean commit boundary for a fresh implementer. No new dependencies, TS product/bun.lock edits, X3-file edits, push or merge.

### Step 4

- GET/HEAD `/api/requests/:id/body` authenticates with require_admin before reading. Shared new `omni-control/src/bodies.rs` projects only requestId/detailState/truncated/sizeBytes/at/artifact. Lossless JsValue artifact survives through stringify (including lone-surrogate escapes); no serde artifact conversion. Uses the existing writable control connection because reads update missing/corrupt/recovered observations.
- Frozen-code correction: GET has **no safe-request-id validation**. The validator belongs only to writes. Decoded slash, Unicode and percent ids are ordinary absent lookups; malformed escapes decode to null and return requestId:null. Frozen route adds **no cache-control**, including no `no-store`; Rust follows it. content-type is application/json;charset=utf-8. Frozen product sources checked against 1780bb39 with empty diff.
- 29 differential HTTP cells: seven initial states plus wrong-encryption-key (absent, ready, missing, corrupt, recovered, unknown state, null path, wrong key), each for admin/viewer/none, plus five decoded/malformed ids. Artifact has a foreign requestId relative to row key and lone surrogate. Rust real HTTP responses compare status, content-type, cache-control and literal body bytes against frozen adminRoutes.handle via Bun reference. Repository get builds oracle inputs, so repository read semantics themselves remain covered by s2, not independently re-proved by this route oracle. Two additional control assertions cover absent arbitrary id and lossless projection/private-field omission.
- Red first: control test failed compiling missing bodies module, then passed. Expanded route tests were added after implementation (not individually red first). Wrong-key fixture initially failed compile on usize SQL parameter, then corrected to i64. All failed logs retained. No known flaky test failure occurred.

### Gates (verbatim .exit lines)

```text
cargo test --offline -p omni-control --test body_read: 101
cargo test --offline -p omni-control --test body_read: 0
cargo test --offline -p omni-gateway --test body_route: 0
cargo test --offline --workspace: 0
cargo clippy --offline --workspace --all-targets -- -D warnings: 0
cargo fmt --all -- --check: 0
cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture: 0
cargo build --offline -p omni-gateway: 0
unshare -Urn bun --no-env-file conformance/e2e/maintenance.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a3/s5-rust-step4: 0
unshare -Urn bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a3/s5-rust-step4: 0
bash conformance/e2e/idle-timeout-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a3/s5-rust-step4 /tmp/opencode/a3/s5-idle: 0
bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a3/s5-rust-step4 /tmp/opencode/c1/w-a3s5: 0
bash conformance/e2e/antigravity-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a3/s5-rust-step4 /tmp/opencode/b4/e2e/a3s5: 0
bash /tmp/opencode/a3/s5-anthropic-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a3/s5-rust-step4 /tmp/opencode/a3/s5-anthropic: 0
bash /tmp/opencode/a3/s5-openai-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a3/s5-rust-step4 /tmp/opencode/a3/s5-openai: 0
bash conformance/e2e/connect-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a3/s5-rust-step4 /tmp/opencode/a15/a3s5: 0
unshare -Urn bash -c ip link set lo up; bun --no-env-file /tmp/opencode/a3/s5-off-burst.ts: 0
```

Sources: s5-read-red/green, s5-route-green, s5-workspace-final, s5-clippy-green, s5-fmt-green, s5-dispatch, s5-build, s5-maintenance, s5-run, s5-idle-timeout, s5-smart-router, s5-antigravity, s5-anthropic, s5-openai, s5-connect, s5-burst `.exit` and matching `.log`. Non-namespace drivers ran inside unshare with loopback up; all explicit scrubbed env/private HOME. Anthropic/OpenAI wrapper copies add --no-env-file; product wrappers unchanged. No admin-routes driver run.

Final workspace: 211 successful test-result summaries; first workspace run also passed. Dispatch 3448 bytes, unchanged ceiling 5500. Smart router 102 equal, antigravity 45 equal, anthropic 30 cases/0 failed, openai 56 rows/0 failed; connect 429 rows/0 failed with existing 17 expected divergences (5 unported-provider, 12 provider-list). run.ts all rows equal; maintenance and idle timeout PASS. These existing suites are NOT the requested body-specific black-box driver.

### Capture OFF repeated burst

Five alternating base/final pairs (10 launches), 2000 requests at concurrency 20 each plus large SSE, private loopback namespace. Evidence s5-off-burst.ts, s5-burst.log/.exit, s5-burst-measured/. Every database had zero body rows.

| Binary | median requests/s | min–max requests/s | spread |
|---|---:|---:|---:|
| e41a2ad4 base | 7103.96 | 6725.22–7197.13 | 471.90 |
| 007d00af final | 7323.04 | 7037.01–7573.54 | 536.52 |

Median final +3.08%; paired deltas +2.62%, +8.89%, +1.86%, -0.94%, +5.23%. No consistent slowdown beyond noise; no OFF-path change made. Debug-binary throughput is not a production performance claim.

Built after commit: `/tmp/opencode/a3/s5-rust-step4`, SHA256 `aeb971b2933a211e50f34ccfe37e2e05de24ac64f34e4dbc2bec9ef34cdbc693`, commit `007d00af4bb08361ed4d99da058480c5318d475a`; authoritative s5-rust-step4-binary.sha256/.commit. Build succeeded; initial copy mistakenly named target/debug/omni-gateway instead of omnigateway and failed, then correct binary copied (the earlier empty s5-rust-step4.sha256 is not authoritative). fmt passed before commit; offline Cargo prescribed flags/own target, no concurrent cargo; final free disk 19 GiB.

### Remaining for next session

**Entire step 5**: conformance/e2e/body-capture.ts and body-capture-ns.sh, TLS provider stubs, full gates/surfaces/secrets/bounds/auth-retry/abandoned-client matrix, typed cells and BOTH decrypted files via frozen reader, layout/admin-read/OFF no-write comparisons, baseline red against rust-base and final green, step-5 commit, postcommit rebuild/digest and rerun final gates/burst at that final binary. No dedicated body-driver files created yet. The route reference helper is only a frozen-handler oracle, not the step-5 driver. Independent review still required.

## s6 — step 5 black-box body capture driver

Final clean commit `a253cf0425cbd06b80642e979bec60f9ac9ff5c4`. Append-only commits:
- `df868d8c` — `fix(gateway): A3 omit client SSE capture delimiters`.
- `17918afc` — `test(e2e): A3 5/5 body-capture driver (140 rows)`.
- `da17ce05` — bound independent non-stream response oracle.
- `a253cf04` — apply frozen masking/bounding to independent wire-frame oracle.

### Driver and discovered fix

28 identical-seed TS/Rust cell pairs, 140 comparison rows (typed database metadata, frozen-reader-decrypted artifact, relative file layout, six admin-route results, independently received client bytes per cell). All three surfaces × non-stream/stream × enabled/key-opt-out/setting-off/environment-off; additional 64 KiB string bound, >512 KiB whole-artifact omission, Anthropic OAuth reactive 401→refresh→retry, and abandoned-client/provider-drain cells. Both artifacts are decoded and digest-checked with the unchanged frozen store reader. Frozen artifact/encryption source diff against 1780bb39 is empty. Ciphertext digest itself is not equated because encryption uses independent random nonces; reader validates each digest. Sizes remain plain equal. IDs (v4/v7) and generated timestamps are normalized, not arbitrary body differences. No new accepted behavioral divergence.

The driver creates its scratch directory, allows only explicit child environment variables (no inherited OMNI_*), and accepts explicit binaries. Namespace wrapper scrubs environment, installs private HOME, maps Anthropic inference/refresh hosts to loopback with locally trusted TLS, and confines all provider traffic to the network namespace. Fresh scratch required; failed attempts retained. Gateways run sequentially against identical seed copies using the same stub, with distinct ports and no shared database. No TS product/bun.lock edits, dependencies, push or merge.

The independent black-box comparison found a real capture mismatch: Rust persisted client SSE frame delimiters (`\n\n`), while frozen sseResponse passes the event/data record to onFrame *before* appending the wire delimiter. This also changed encrypted artifact sizes by two bytes per record. Added unit regression, observed assertion red (after one retained fixture compile error), fixed CaptureCompletion.frame to split off delimiters, observed unit green, committed separately. Initial trial3 JSON retains the exact mismatch; no masking was used to hide it. The pure frozen FrameSink write semantics remain untouched.

Client non-stream and stream capture is additionally checked against independently received wire output transformed by frozen mask/bound functions (necessary because Responses-generated long IDs themselves trigger frozen opaque-token masking). Special bounds cells assert truncation/omission explicitly. Cancellation polls SQLite with a 15-second deadline until capture persists, then asserts provider message_stop was drained. The stub deliberately delays the tail by 100ms to permit abandonment; readiness/persistence use bounded polling rather than fixed settle sleeps. Capture-OFF checks zero rows and zero files after graceful process shutdown. Operator/viewer/none × absent/present responses compare status, content-type, cache-control and parsed typed body. Header-only and prompt/tool-argument secrets are checked absent from decrypted plaintext.

### Final-commit gates (verbatim .exit lines)

```text
cargo build --offline -p omni-gateway: 0
cargo fmt --all -- --check: 0
cargo clippy --offline --workspace --all-targets -- -D warnings: 0
cargo test --offline --workspace: 0
cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture: 0
unshare -Urn bash -c 'ip link set lo up; bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a3/s6-final2-rust': 0
bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a3/s6-final2-rust /tmp/opencode/c1/w-a3s6: 0
bash conformance/e2e/body-capture-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a3/rust-base /tmp/opencode/a3/s6-final2-red: 1
bash conformance/e2e/body-capture-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a3/s6-final2-rust /tmp/opencode/a3/s6-final2-green: 0
```

Authoritative sources: `s6-final2-{build,fmt,clippy,workspace,dispatch,run,smart-router,red,green}.exit` and matching logs. Baseline red times out on the first enabled cell because no request_bodies row is persisted; green **140 equal / 0 failed**, 28 cells. Workspace 211 successful test-result summaries; no flaky failure/rerun. Dispatch 3448 bytes; smart-router 102 equal/0 failed/0 invalid; run.ts all rows equal. admin-routes deliberately not run. Earlier failed attempts (seed filename, initial discovered delimiter mismatch, independent-response assertion needing frozen mask/bound) retained under s6-trial*, s6-green, s6-final-green and s6-frame-red*; none replaced. fmt passed before each commit; own target, offline prescribed Cargo flags and scrubbed private HOME, one Cargo command at a time. Disk stayed >=18 GiB free.

Built AFTER final commit: `/tmp/opencode/a3/s6-final2-rust`, SHA256 `d9a0574c77611e238fcc4bfe686c3670d19ede44c44114249791084e1fd194eb`, commit `a253cf0425cbd06b80642e979bec60f9ac9ff5c4`; authoritative `s6-final2-rust.sha256/.commit`. No new performance/burst measurement in s6 (s5 repeated OFF burst remains the recorded measurement).

### Remaining

Independent review of the entire A3 branch and controller-run admin-routes. No step-5 implementation or required final gate remains. Driver uses the existing running SQLite gateway backend; this does not claim a running PostgreSQL gateway matrix. Existing X1 lossless carrier fidelity is not normalized away; the new black-box fixtures use scalar text.


## f1 — review follow-up, clean M1 checkpoint (I1/I2 remain)

Commit `660e1872c98d942d908846d95dbb9d24eb68c278` fixes **M1 only**. Stopping at this clean finding-level commit to preserve context; **A3 remains REQUEST CHANGES**. No subagents, TS product edits, new dependencies, push, merge, or admin-routes run.

### M1 frozen check and change

Verified frozen `1780bb39:apps/gateway/src/routes/proxy.ts:580–585`: capture retains incoming parsed JSON, including arbitrary client timestamp fields. Frozen proxy lines 834–837/904–907 explicitly pass requestId and generated seconds into response renderers. Replaced recursive timestamp/UUID-pattern erasure with a dedicated normalizer: substitute only the actual minted requestId (including its derived response/item/path occurrences); normalize row/artifact/operator-route `at` only at their identified locations; normalize response `created`/`created_at` only on known gateway response envelopes. SSE is parsed at data records, not regex-rewritten inside arbitrary string payloads. Client request, provider attempts, nested client/response content and unrelated UUID literals remain significant. Raw paired evidence is still saved before normalization.

Added three tests (7 assertions), including changed client `at`/`created`/`created_at`, literal UUID, nested response field and SSE content negative checks, plus known generated-field positive control. Copied the read-only review normalizer to f1 evidence. Its original two negative cases both erroneously compare equal; an assertion harness against that exact old normalizer reports **2 failed / 2**. This red harness was executed after implementing the replacement (not a red-first development sequence); no claim otherwise. First red harness failed due to Bun data-URL import/export, retained as `f1-m1-red.*`; corrected `f1-m1-red2.*` proves the intended failures. New tests **3 pass / 0 fail**. New narrow normalizer accepts the prior stored corpus **140 equal / 0 failed**, and two fresh live driver runs each produce **140 equal / 0 failed, 28 cells**, including abandonment.

### Checkpoint gates (verbatim .exit lines)

```text
bun --no-env-file /tmp/opencode/a3/f1-m1-red2.ts: 1
bun --no-env-file test conformance/e2e/body-capture-normalize.test.ts: 0
bun --no-env-file /tmp/opencode/a3/f1-m1-corpus.ts: 0
cargo fmt --all -- --check: 0
cargo build --offline -p omni-gateway: 0
bash conformance/e2e/body-capture-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a3/f1-m1-rust /tmp/opencode/a3/f1-m1-committed-live: 0
cargo test --offline --workspace: 0
cargo clippy --offline --workspace --all-targets -- -D warnings: 0
cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture: 0
```

Sources: `/tmp/opencode/a3/f1-m1-{red2,unit-final,corpus,fmt,build,committed-live,workspace,clippy,dispatch}.exit` and logs. Workspace: **211 successful test-result summaries**, no flake/retry. Dispatch **3448 bytes**, ceiling 5500. All commands in authorized worktree with explicit private HOME/scrubbed PATH, prescribed Cargo settings, offline sequential Cargo; live provider traffic in loopback namespace; every Bun invocation uses --no-env-file. Disk before builds 16 GiB free. fmt checked immediately before commit. Build ran after commit. Initial copy incorrectly assumed binary name `omni-gateway` and failed; corrected copy uses `target/debug/omnigateway` (build succeeded).

Checkpoint binary `/tmp/opencode/a3/f1-m1-rust`, SHA256 `d9a0574c77611e238fcc4bfe686c3670d19ede44c44114249791084e1fd194eb`, commit `660e1872c98d942d908846d95dbb9d24eb68c278`; records `f1-m1-rust.sha256` and `f1-m1-rust2.commit`. Identical binary hash to prior commit is expected: only conformance code changed.

### Remaining for next fresh implementer

**I1 and I2 entirely unimplemented**, including their frozen checks, red-first new regressions, driver cells, independent same-SQLite frozen handler oracle, raw-cell semantics, maintenance reader audit, and finding-level commits. No claim of product correctness or final acceptance. Read review and original task constraints before proceeding. Review tail/stall2/shutdown/probe reproductions have NOT been rerun here; live driver still has original 28 cells and cannot catch I1/I2. Required final-commit full matrix (maintenance.ts/run.ts/smart-router/anthropic/openai/antigravity/idle-timeout), new-cell a253cf04 red versus final green, paired reproductions and five alternating OFF burst pairs remain. No fresh OFF burst measurement, no waiver inferred. Current tests/clippy/dispatch are only the M1 checkpoint, not final A3 gates.
## i1 — capture lifetime bound to dispatch termination

Final commit: `55ab3a5b6527942921bd5beb32f252c2a9b81ac9` (append-only: implementation `f0ffc254`, lint cleanup `a3e2e434`, classifier-scope isolation `55ab3a5b`). Worktree clean. No I2 files, frozen TS product files, dependencies, or bun.lock changed.

Frozen check: read dispatch finally and client/deadline abort wiring, attempt finally, generator wrapper, HTTP outgoing abort/close listeners, and collector drain/text paths at frozen `1780bb39`. Normal generator completion (including non-stream clients consuming the adapter stream), final upstream failure, client cancellation, and deadline terminate the shared dispatch signal. Candidate failover/auth retry does NOT abort that signal; attempt finally releases its load/probe only. HTTP abort destroys outgoing; streaming collector catches source failure, retains bytes already received, sets attempt truncated. Buffered text already read to EOF remains complete. Capture settle has no timer. Dispatch abort therefore bounds drain settlement before finish/persistence and shutdown; it is not an independent background lifetime.

Design: an optional request-id-scoped transport guard lives in the dispatch generator, so completion or drop signals capture termination, including an unpolled generator. Classifier dispatches cannot terminate the parent's capture. Capture-only observers race socket reads against a retained watch signal; cancellation closes the owned source before finishing the observer, preserves bytes, marks truncated, and wakes settle. Persistence signals termination defensively before settle (covers pre-dispatch exits). No arbitrary timeout or writer timeout; writer callbacks no longer depend on remote EOF. Ordinary send/text/OFF transport and drain/pool behavior unchanged. Dispatch concrete state machine **3480 bytes** (was 3448; ceiling 5500).

Regressions: four scripted held-socket integration modes (delayed terminal tail, indefinitely nonclosing terminal, writer shutdown after terminal, abandonment), plus the existing independent adapter-abandonment fixture and classifier lifetime assertion. Added three black-box cells (delayed tail, held tail/persistence deadline, SIGTERM while tail held) comparing metadata, frozen-reader-decrypted artifacts, and exit timing class. Driver now 31 cells / 186 equal rows. The existing abandonment fixture still passes unchanged behavior. The integration checks collector settlement/socket release/writer closure; actual persisted rows and process SIGTERM are additionally exercised by the paired driver/probes.

Red → green: `i1-red-integration.log` fails waiting 500 ms for capture settlement before implementation; `i1-red-driver.log` fails the delayed-tail assertion against `/tmp/opencode/a3/s6-final2-rust` (reviewed a253cf04 binary), after the ordinary 24 cells pass. First failing cells short-circuit; no claim every new cell ran independently red. Green workspace includes all scripted modes; driver includes all new cells. Failed attempts retained, including initial clippy I/O-result lint failures, subsequently corrected.

Final gates (exit values quoted from corresponding `.exit` files; logs share filename stem, all under `/tmp/opencode/a3/`). Commands run with explicit scrubbed environment/private HOME, offline Cargo, two build jobs, no incremental/debug data; non-namespace drivers/tests in loopback-only namespaces. Build occurred after final commit; disk remained 15 GiB free. No known workspace flaky test failed; all three named tests passed, so no isolated retry needed.

- `cargo build --offline -p omni-gateway` — exit `"0"` (`i1-build-scope.exit`).
- `cargo test --offline --workspace` — exit `"0"` (`i1-workspace-scope.exit`).
- `cargo clippy --offline --workspace --all-targets -- -D warnings` — exit `"0"` (`i1-clippy-scope.exit`).
- `cargo fmt --all --check` (before final commit) — exit `"0"` (`i1-fmt-scope.exit`).
- `cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture` — exit `"0"` (`i1-dispatch-scope.exit`), 3480 bytes.
- `bash conformance/e2e/body-capture-ns.sh TS RUST /tmp/opencode/a3/i1-scope-driver` — exit `"0"` (`i1-scope-driver.exit`), 31 cells / 186 equal.
- `bash /tmp/opencode/a3/i1-probes/tail-ns.sh TS RUST /tmp/opencode/a3/i1-scope-tail` — exit `"0"` (`i1-scope-tail.exit`), both 2739 bytes / truncated=1, no terminal tail in decrypted artifact.
- `bash /tmp/opencode/a3/i1-probes/stall2-ns.sh TS RUST /tmp/opencode/a3/i1-scope-stall2` — exit `"0"` (`i1-scope-stall2.exit`), persistence TS 0 ms / Rust 10 ms.
- `bash /tmp/opencode/a3/i1-probes/shutdown-ns.sh TS RUST /tmp/opencode/a3/i1-scope-shutdown` — exit `"0"` (`i1-scope-shutdown.exit`), persistence TS 0 ms / Rust 10 ms, both exit within 5 s.
- `bun --no-env-file conformance/e2e/run.ts --ts TS --rust RUST` — exit `"0"` (`i1-scope-run.exit`), all rows equal.
- `bash conformance/e2e/smart-router-ns.sh TS RUST /tmp/opencode/c1/w-a3i1-scope` — exit `"0"` (`i1-scope-smart-router.exit`), 102 equal. Also passed requested exact scratch `/tmp/opencode/c1/w-a3i1` before final classifier isolation; final scratch suffixed to preserve evidence.
- `bash /tmp/opencode/a3/i1-anthropic-ns.sh TS RUST SCRATCH` — exit `"0"` (`i1-scope-anthropic.exit`), 30 cases, zero failures; copied script adds --no-env-file.
- `bash /tmp/opencode/a3/i1-openai-ns.sh TS RUST SCRATCH` — exit `"0"` (`i1-scope-openai.exit`), 56 rows, zero failures; copied script adds --no-env-file.
- `bash conformance/e2e/antigravity-ns.sh TS RUST /tmp/opencode/b4/e2e/a3i1-scope` — exit `"0"` (`i1-scope-antigravity.exit`), 45 equal. Exact requested a3i1 scratch also passed before final classifier isolation.
- `bash conformance/e2e/idle-timeout-ns.sh TS RUST SCRATCH` — exit `"0"` (`i1-scope-idle-timeout.exit`), PASS.
- `bun --no-env-file /tmp/opencode/a3/i1-scope-burst.ts` — exit `"0"` (`i1-scope-burst.exit`), five alternating OFF pairs, all body counts zero.

Review probe caveat: their unchanged scripts print `DIFFER ... routes` while reporting zero failed because they compare raw route response strings containing generated ids/times. Do not mistake that permissive summary for complete equality. The new strict driver parses/canonicalizes routes and passes; probe decrypted artifacts and typed rows match. Read-only review files untouched; namespace scripts copied into i1-probes.

OFF burst (median [min,max], base → final): burst ms 211.393 [209.968,214.655] → 222.950 [216.945,227.397] (+5.47% median); RPS 9461.044 [9317.280,9525.283] → 8970.627 [8795.172,9218.926] (-5.18%). Large SSE ms 21.050 [18.121,23.528] → 21.228 [20.804,25.531]. HWM after burst KiB 35388 [35000,35916] → 37756 [35944,39396]; after SSE 40204 [39100,40412] → 41168 [40224,41880]. This is measured variance/regression, not a claim of OFF speed parity; baseline includes all earlier A3 changes, not just I1. Burst reused the supplied s4 driver with fresh evidence root and alternating five pairs.

Binary: `/tmp/opencode/a3/i1-rust`, SHA256 `3de2eac9ab17f8573226bdc096776d267d53ba32701c645f2910e32b1a7a7d90`, built from `55ab3a5b6527942921bd5beb32f252c2a9b81ac9`; recorded in `i1-binary.txt`. TS oracle `/tmp/opencode/a8/ts`. No push/merge. No remaining I1 implementation work; controller merges independent I2.
