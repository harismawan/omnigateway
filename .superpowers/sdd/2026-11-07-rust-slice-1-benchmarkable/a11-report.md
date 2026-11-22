# A11 maintenance

Branch `feat/rust-maintenance`; clean worktree. No push/merge/dependencies/TS-product changes.

## Commits and binary
- `2b938d32` feat: maintenance timers and retention (1318 pass).
- `f70331ff` fix: preserve pending sweep RTK cells (1319 pass).
- Final workspace: **1319 passed, 0 failed, 37 ignored**. New tests: 5 (2 timing/lease unit, 2 store differential, 1 bodies differential).
- `/tmp/opencode/a11/rust-f70331ff`, built AFTER final commit.
- SHA256 `5a9892e8db8e62bb60ad33110b5987131f1e8eae0f8f2937c298cf2b0e314819`.

## Frozen oracle
Reviewed checked-out frozen TS sources (no TS edits). Heartbeat every 10s, first after 10s; live iff seen_at > now-60000; forget nodes strictly older than one day. First maintenance sweep after one hour, not at boot. Boot separately heartbeats and sweeps. No frozen env/HTTP sweep trigger found.

Hourly lease `maintenance`, TTL 7200000ms, acquired/renewed but NOT released. Await pending retirement first, then launch files and logs independently (TS does not await these two within lease callback). Files: snapshot retention then staging. Logs: settings; raw configured days; daily 400 days; quota raw horizon; bodies min(body/raw days), cap 100000 (at/request_id tie order), orphan reconciliation. Raw prune transaction rebuilds boundary-hour rollup; strict < horizons.

Logs: warn `heartbeat failed` {reason}; error `maintenance lease failed` {reason} (Rust Coord acquisition only returns bool, cannot throw); info `retired interrupted requests` {count}; error `pending sweep failed` {reason}; debug `snapshots and staging files swept` {count}; error `snapshot sweeping failed` {reason}; debug `request logs pruned` {rawCount,dailyCount,quotaSampleCount,count}; error `log pruning failed` {reason}. Existing JSON logger already allows these fields. TS stop clears timers; Rust also tracks/drains tasks within shutdown grace.

## Existing versus added
Existing Rust had boot heartbeat/sweep only, generic Store and PG sweep readers, PG body storage, and control body-clear/snapshot retention helpers. Added delayed periodic heartbeat and hourly leased worker, tracked shutdown; SQLite and PG prune/heartbeat methods; reused/refactored control artifact cleanup and snapshot pruning; staging sweep. Bodies table DOES exist in shipped migrations, so no A3 stop: pruning only, no capture feature added. PG orphan sweep is necessarily zero (inline bytes). Existing gateway remains SQLite-only (D1 backend boot integration is outside A11); worker accepts Coord but current boot supplies MemoryCoord, consistent with existing single-node host, not production Redis fleet integration.

Pending differential discovered RTK counters must survive retirement, while unknown RTK filter ids must be filtered as TS does. Fixed SQLite/PG readers and added regression seed.

## Differential evidence
- 6 SQLite prune/heartbeat scenarios (3 horizons x populated/empty), typed full cells in request_logs, usage_rollup, usage_daily, quota_samples, nodes plus returned counts. Exact horizon +/-1ms and day-old-node boundary.
- 1 pending scenario: live, exact grace boundary, older, own, absent node; 4 retirements; all 5 tables compared including RTK fields.
- 1 body scenario: horizon +/-1ms, equal-at cap tie, artifact deletion, orphan; typed rows/files/counts [1,1,1].
- Black box: both frozen binary and committed Rust retire seeded dead node at boot; compare 3 full typed tables and observe periodic heartbeat increase. Ports 18561 (unused by other drivers). Hourly pruning cannot be externally triggered; store differential + paused timers substitute as requested.

## Gates
All Cargo commands offline with jobs=2, incremental=0, dev/test debug=0; disk checked, never below 5GiB (12GiB at last build).
- `cargo test --offline --workspace` — exit `0` (`workspace-3.exit`).
- `cargo clippy --offline --workspace --all-targets -- -D warnings` — exit `0` (`clippy-5.exit`).
- `cargo fmt --all -- --check` — exit `0` (`fmt-3.exit`).
- `cargo test --offline -p omni-gateway --test dispatch_size` — exit `0` (`dispatch-size-final.exit`).
- `bun --no-env-file conformance/e2e/maintenance.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a11/rust-f70331ff` — exit `0` (`e2e-maintenance-2.exit`).
- `bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a11/rust-2b938d32` — exit `0` (`e2e-run-1.exit`).
- `cargo build --offline -p omni-gateway` — exit `0` (`build-2.exit`).

Final-commit rerun: `bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a11/rust-f70331ff` — exit `0` (`e2e-run-2.exit`). Waited for X3 operator driver PID 1961040 to exit before launch. Every row passed: 37 request_logs / 18 usage_daily / 6 usage_rollup / 4 health rows equal. Earlier broad blocking wait timed out after 1200s (no gateway launched); first-commit run.ts also passed.

`gate-scan.log` scans selected logs for FAILED|panicked|^error: no matches. Failed attempts retained: initial compile (BarrierError Display), differential-1 bad reference symbol, differential-2 missing required seed field, differential-3 number representation normalization, workspace-2 exposed unknown RTK filter normalization; fixed, workspace-3/clippy-5/fmt-3 pass. No known-flaky gate rerun was needed; workspace-2 was a real new-test failure.

## Unverified / limitations for reviewer
- No configured Postgres runtime/differential tests; existing PG tests ignored/skipped without harness, OMNI_TEST_REQUIRE_PG not set. PG implementation compiled/clippy checked only.
- No multi-process Redis gateway integration; lease contention unit shares MemoryCoord across holders.
- No snapshot/staging differential or independent failure/log-capture tests yet. Schedule test and black-box heartbeat pass, but stalled-work shutdown deadline and real multi-node sweep remain unverified.
- Pending retirement uses existing bounded writer queue; queue-full behavior remains existing gateway semantics rather than frozen synchronous complete path. Blocking filesystem/SQLite work already running cannot be cancelled by Tokio abort at shutdown deadline.
- PG horizon APIs take i64 (existing PG timestamp surface), unlike SQLite f64 horizons; fractional-day settings across PG are not differentially verified.


# r1 — review corrections

## Commits / results
- `d3e41167` test: expose retention and boot RTK drift (2 red): frozen scalar differential and boot nonzero RTK driver, observed failing against prior implementation/binary.
- `cad81b63` fix: lossless recovery and JS horizons (1322 pass).
- Workspace **1322 passed, 0 failed, 37 ignored**; no flaky retry needed.
- 400 randomized SQLite differential pairs, seeds 11011 / 22022: **200/200 equal each seed**. Each compares six typed tables, four aggregate counts, artifact filenames. Expanded scalar variants: null, false, true, numeric/invalid/whitespace/hex/Infinity/-Infinity/fractional strings; absent/numeric and malformed body setting too. Copied reviewer harnesses into `r1-harness/`, never wrote reviewer evidence. Results `r1-harness/random-results.json`.
- Queue regression: capacity 1, 3 persisted dead rows; old send path red (`r1-queue-red.exit=101`); direct recovery green, completes all 3, repeated sweep returns 0.
- Nonzero boot RTK driver red against rust-f70331ff (`r1-boot-red.exit=1`), green against r1 committed binary; full typed table comparison includes [1,2,30,10,5,["grep"]].

## Fixes / oracle details
Maintenance reads raw stored settings separately; typed Settings elsewhere unchanged. `omni_ir::js::to_number` implements scalar ToNumber including whitespace/hex strings. Math.min explicitly propagates NaN (Rust min alone does not). Arrays/objects in raw logRetentionDays STOP with a refusal, as requested; no open-ended ToPrimitive implementation added.

Important brief/oracle clarification: frozen config.ts:125–131 actually VALIDATES `bodyRetentionDays` (integer number 1..3650, else 1) before maintenance sees it. Malformed body values are therefore normalized, NOT raw ToNumber; code wins. Preserved this frozen validation in the separate maintenance reader; only raw logRetentionDays uses unrestricted scalar coercion.

`r1-bind.log` records real bun:sqlite binding: NaN -> SQL NULL, no `at < ?` matches; +Infinity -> REAL/all finite rows match; -Infinity -> REAL/none; 0.5 -> REAL, rows -1 and 0 match. rusqlite f64 binding gives identical behavior, demonstrated by frozen differential including infinities and fractional horizons.

PG maintenance horizon APIs now accept f64 and explicitly validate integer/finite/range before binding bigint. Reason: frozen Bun SQL timestamp parameter is inferred bigint from the column, and PostgreSQL bigint input rejects fractional/nonfinite number literals rather than using SQLite's NULL/REAL behavior. Unit test checks NaN, both infinities, fraction, overflow refusals and negative integer acceptance. **No PG runtime available**; this remains source/protocol reasoning + unit test, not a PG differential claim. Caller can use shared raw `horizons`; gateway PG boot integration remains outside A11.

Recovery now runs existing writer completion transactions directly, one persisted row per transaction as frozen does, never enters lossy request queue. Returns actual successful completion claims; already done rows are zero. Both boot and hourly use shared pending reader via recovery helper, removing duplicated boot SELECT and preserving RTK fields. Boot recovery finishes before writer/snapshot consumers start. Hourly pending-before-files/logs order unchanged. Recovery avoids dropped/failed barrier counters entirely. Direct completions do not emit writer commit-sink notifications (dead/boot rows are not active request-path limiter claims).

Shutdown: checked frozen lifecycle.ts: stop loops then one server-drain grace. Rust maintenance and HTTP now both use same `shutdown_until`, no fresh full HTTP grace. Already-running blocking work still cannot be forcibly cancelled, as previously documented.

## Gates
- `cargo test --offline --workspace` — exit `0` (`r1-workspace-1.exit`).
- `cargo clippy --offline --workspace --all-targets -- -D warnings` — exit `0` (`r1-clippy-2.exit`).
- `cargo fmt --all -- --check` — exit `0` (`r1-fmt-2.exit`).
- `cargo test --offline -p omni-gateway --test dispatch_size` — exit `0` (`r1-dispatch-size.exit`).
- `cargo build --offline -p omni-gateway` — exit `0` (`r1-build.exit`).
- `bun --no-env-file conformance/e2e/maintenance.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a11/r1-gateway` — exit `0` (`r1-maintenance.exit`).
- `bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a11/r1-gateway` — exit `0` (`r1-run.exit`). Waited for the non-namespace X3 operator driver before launch. All rows equal: 37 request_logs, 18 usage_daily, 6 usage_rollup, 4 credential_health.

Build AFTER `cad81b63`; binary `/tmp/opencode/a11/r1-gateway`; SHA256 `204e47771c3ae822108ca26f533f1a0920c9861438397c12147a2b14a6ff49ae`; exact commit `cad81b632447df97189812b6e33c56432213bf61`. `r1-gate-scan.log`: no FAILED|panicked|^error in completed final gates. Failed red tests and first clippy attempt (test-module placement) retained. Disk stayed above 5GiB (11GiB last build). No admin-routes run.

Known approved differences retained: Coord returns bool so cannot emit maintenance lease failed; Tokio Skip differs from Bun timer phase under stalls; spawn_blocking permits real thread overlap unlike Bun event loop; boot supplies process-local MemoryCoord. Unverified: PG runtime, Redis multi-node, exhaustive injected failure/log comparisons and true hourly-sweep SIGTERM under contention. Array/object raw log-retention coercion deliberately stopped as directed.


# r2 — lossless raw settings parsing

- `2aad8ac3` test: raw JSON retention boundaries (1 red).
- `b155f90b` fix: lossless JS retention parsing (1323 pass).

The raw stored settings text now uses `omni_ir::jsjson::parse_js` directly. No serde_json roundtrip: infinities survive, UTF-16 lone surrogates survive in unrelated properties, and only actual JSON.parse syntax failure defaults the settings object. Log-retention scalar conversion matches on JsValue numbers/null/bools/strings; an invalid UTF-16 numeric string is NaN (surrogates cannot be numeric grammar). Body-retention retains frozen integer-number 1..3650 validation. Object/array log-retention refusal remains the approved STOP boundary. Duplicate object properties use the final occurrence.

Committed frozen differential adds **12 raw-text cases**, with rows at seven ages (ancient, 31d, 2d, 1d, now-1, now, now+1), body rows and rebuilt rollups. Cases: positive/negative overflow; lone-surrogate log value; unrelated surrogate and both overflow signs; underflow 1e-400; -0; body overflow/surrogate; genuinely invalid JSON; unrelated 2000-level nested array. Six full typed tables plus all four aggregate counts compared. Red recorded 9 mismatches (`r2-raw-red.exit=101`); green **12/12 equal** (`r2-raw-green.exit=0`). Prior 400 randomized pairs still pass in workspace gate. Review evidence remains untouched/read-only.

Workspace **1323 passed, 0 failed, 37 ignored**, named flakes passed first try. Final gates (required Cargo environment: jobs=2, incremental=0, dev/test debug=0; offline):
- `cargo test --offline --workspace` — exit `0` (`r2-workspace.exit`).
- `cargo clippy --offline --workspace --all-targets -- -D warnings` — exit `0` (`r2-clippy.exit`).
- `cargo fmt --all -- --check` — exit `0` (`r2-fmt.exit`).
- `cargo test --offline -p omni-gateway --test dispatch_size` — exit `0` (`r2-dispatch-size.exit`).
- `cargo build --offline -p omni-gateway` — exit `0` (`r2-build.exit`).
- `bun --no-env-file conformance/e2e/maintenance.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a11/r2-gateway` — exit `0` (`r2-maintenance.exit`).
- `bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a11/r2-gateway` — exit `0` (`r2-run.exit`).

Full e2e all rows equal (37 request_logs, 18 usage_daily, 6 usage_rollup, 4 health). `pgrep -af conformance/e2e` found no competing driver before run.ts; no wait needed, no admin-routes invocation. `r2-gate-scan.log` scans FAILED|panicked|^error. Failed red attempt retained; all final gates exit 0.

Build AFTER final commit `b155f90b968544114ed1d7d35b9f646658e63e3c`; binary `/tmp/opencode/a11/r2-gateway`; SHA256 `e586eeb972b1ed50d85bdf9c4c62009b18cb17e890b1928ec19a018e4abc57c8`. Disk stayed at ~11GiB free, above 5GiB floor. Worktree clean.

Retained limitations: no PG runtime or Redis multi-node validation; PG bigint conversion reasoning remains unverified at Bun protocol boundary. Approved Coord bool/error-log omission, Tokio Skip phase, blocking-thread overlap, local MemoryCoord and object/array STOP unchanged. Shutdown is shared-grace best effort, not hard cancellation of blocking work. Correction to r1 prose: hourly own-node rows can be active requests; missing direct-recovery commit-sink callbacks matches frozen sweep bypassing gateway completion callbacks, not an assumption that every retired row is inactive (review r2 recovery audit).
