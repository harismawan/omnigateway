# A11 re-review at cad81b63 — in progress

Verdict: **REQUEST CHANGES** — one remaining Important finding in the raw JSON parsing boundary. No Critical findings.

## Findings first / closure matrix

1. **Important — valid JSON.parse scalar settings still default to 30 days and can over-delete. Original retention finding NOT fully closed.** `crates/omni-store/src/maintenance.rs:8-19` silently converts serde_json parse failures into defaults, but frozen `packages/store/src/sqlite/config.ts:99-110` accepts numeric overflow and lone-surrogate strings through JSON.parse; `apps/gateway/src/maintenance.ts:50-57` then computes their real scalar horizons. At now=1794000000000, seeded rows old(at=1), fresh(at=now): raw text `{"logRetentionDays":1e309}` returns Rust rawCount=1, remaining fresh, versus frozen rawCount=0, remaining old+fresh. Raw text `{"logRetentionDays":-1e309}` returns Rust rawCount=1/fresh retained versus frozen rawCount=2/no rows. Raw text `{"logRetentionDays":"\ud800"}` returns Rust rawCount=1 versus frozen 0. Paired real prune result: `overflow-prune.json`; horizon/selection result: overflow-rust.json vs overflow-ts.json and surrogate-ts.json. Fix the JSON.parse boundary using lossless JS representation (already available in jsjson::parse_js), preserving scalar nonfinite numbers/UTF-16 strings; do not default a valid frozen settings object because serde_json cannot represent it. Add raw-text red tests, not only Value-generated settings. This is not array/object coercion, and no new approved difference covers it.
2. **Original queue-loss finding CLOSED.** Independent capacity=1 queue prefilled with one request completion, three persisted pending rows: direct recovery=3, second recovery=0, pending=0, dropped=0 (`independent.log`). Prior fixture's lossy request sends are intentionally replaced with recovery, not rerun unchanged (unchanged harness would only retest generic lossy writer behavior).
3. **Original boot RTK finding CLOSED.** Shared reader used for boot and hourly; duplicated SELECT deleted. `boot-results.json` matches all six nonzero RTK fields, and maintenance driver full table comparison with nonzero RTK passed.

Ordinary prior malformed values (null/bool/string) ARE corrected; remaining finding is a narrower raw JSON parse acceptance defect, not failure of the tested scalar ToNumber or Math.min chain.

Workspace rerun complete: workspace.exit=0, **1322 passed / 0 failed / 37 ignored**. All three named flaky tests passed on first run; no rerun. Temporary reviewer tests were added after cargo test discovered targets and are NOT included in 1322 (separate independent command runs them).

Confirmed raw JSON numeric overflow (`{"logRetentionDays":1e309}`), unlike string `"Infinity"`, is accepted by JSON.parse as Infinity but rejected by serde_json's default number parser, which causes horizons() to default the WHOLE settings object to 30 days. Independent paired probe confirms +overflow => frozen -Infinity horizon/no rows selected, Rust 30-day horizon/old row selected; -overflow => frozen +Infinity/all finite rows selected, Rust 30-day horizon. This scalar class is not covered by ordinary serde_json::Value-generated test variants (cannot represent infinities). The same issue can discard otherwise-valid logRetentionDays when an unrelated setting contains overflow numeric text.

Frozen lone-surrogate string probe (`surrogate-ts.json`): `{"logRetentionDays":"\ud800"}` parses and yields NaN horizon, while `{"logRetentionDays":0,"unrelated":"\ud800"}` parses and retains zero-day horizon. serde_json likewise rejects such valid JSON.parse strings and defaults whole object. Paired full prune raw-text test includes both cases along with overflow literals; three of four row/count pairs differ. Fourth pair has a different horizon but seed lacks intermediate-age rows to distinguish selected set, so not counted as row mismatch.

If confirmed, fix the JSON.parse boundary, not ToNumber or SQLite binding: crate already contains `omni_ir::jsjson::parse_js` (jsjson.rs:624-627) explicitly preserving f64 infinities and lone UTF-16 surrogates. A lossy roundtrip through serde_json::Value would reintroduce the problem. Array/object refusal remains intentional and must not be confused with valid scalar/raw JSON parse acceptance.

Boot.py independently confirms nonzero RTK preserved identically: done,1,2,30,10,5,["grep"]. Signals were delivered immediately after DB claim appeared and both processes exited -15 before full boot/signal handler installation; no shutdown claim based on this boot probe. Committed maintenance driver subsequently waits for periodic heartbeat and tests nonzero RTK via full table comparison.

Initial HEAD cad81b632447df97189812b6e33c56432213bf61, clean. 11 GiB free, required Rust touch/build environment used. pgrep once found x3-operator.py PID 2121748 and implementer's pending run loop PID 2135127: reviewer run.ts SKIPPED, never waited.

## Recovery source audit

`writer/mod.rs:49-63`: selects same pending rows through shared reader; one `batch::write([Finish])` per row. `batch.rs:577` BEGIN IMMEDIATE precedes row loading, so concurrent writer/recovery transactions serialize before reading claim state. Finish ignores already-done rows (222-226), and only successful claims enter `completed_rows_by_id`; daily/hourly aggregates and row commit in that transaction. No double rollup when the live writer wins first. Count is actual new claims (unlike frozen stale.length under a concurrent external writer); one row per transaction matches frozen usage.ts:304-315/382-389. Failure aborts current row/remaining loop; previous rows already committed, as frozen; repeat sweep finds remaining pending. Busy handling is connection's 5-second busy_timeout, without writer task's additional three-batch retry loop; frozen store also has 5-second busy_timeout and no sweep retries. Raw select is outside the transaction, as frozen. Boot now recovers fully before snapshot/limiter/writer startup.

Commit sink audit: only `RateLimiter::spawn_consumer` receives gateway commit_rx (lib.rs:419; ratelimit_seed.rs:97-109 debits key/model token/cost buckets). No quota/metrics/stream-registry consumer on this channel; usage rollups are inside batch transaction, not sink. Frozen sweep calls store.complete directly, not gateway logging.ts/proxy completion lifecycle; therefore no limiter debit, plugin event, telemetry, resource invalidation or body capture side effects. Direct recovery's missing sink notification matches that frozen behavior; boot limiter seed sees already-completed recovery data. Hourly own-node pending rows CAN belong to active requests (same predicate as frozen), so “dead/boot rows are not active claims” is not generally true; nevertheless oracle sweep itself bypasses request completion callbacks, so omitting notifications is the parity choice, not a new omission. Existing request-path behavior if recovery wins the persisted claim before actual completion remains an inherited semantic risk outside this fix.

Transaction-detail caveat: frozen Bun transaction is default/deferred and first statement is the completion upsert; Rust takes IMMEDIATE before its load/replay/write. This is a stronger lock acquisition ordering, necessary to avoid stale read/claim rollup races in Rust's replay approach, not an identical SQL locking protocol. Both hold one write transaction per recovery row and permit other writers between rows. A stale selection whose row was deleted between selection and recovery may reinsert it via Finish, as frozen COMPLETE can also insert a missing row. Mid-way errors do not return partial success count; they reject/log and keep earlier commits, as frozen.

The replacement does NOT add a PG direct recovery implementation; running gateway remains SQLite-only. PG `pending_interruptions` + writer supports other callers, but cannot be claimed integrated by this new SQLite helper. PG float horizons now reject nonfinite/fractional/out-of-range before bigint binding; compiled and unit-tested, actual Bun PG parameter encoding/rejection parity remains unverified.

## Settings / shutdown audit

Frozen sqlite/config.ts:125-131 validates bodyRetentionDays: literal integer number 1..3650, otherwise default 1. New horizons duplicates that correctly; raw log value uses scalar ToNumber, missing/invalid/non-object settings defaults 30. NaN explicitly propagates through Math.min; Sqlite f64 binding maps NaN to NULL and infinities to REAL. Array/object raw log values are deliberately refused (approved STOP constraint), not claimed equivalent.

Rust lib.rs uses same shutdown_until for maintenance and HTTP drain, removing fresh second grace. Frozen lifecycle.ts stops timers synchronously then races server stop against one 5-second deadline, closes store/exits. Rust additionally tracks maintenance jobs and may consume that grace before starting HTTP graceful shutdown; writer close/join cleanup and uncancellable running spawn_blocking work can still exceed this notional grace. This is not proof of hard full-process deadline parity.

## Frozen paired failure check

Frozen partial.ts inserts a,b,c with 7 input tokens each and a BEFORE UPDATE trigger aborting b. Sweep rejects after a committed; done=1. Drop trigger, retry=2; daily/hourly requests=3/3 (`partial-ts.json`). Rust equivalent trigger/concurrency/busy checks are in the independent scalar/recovery harness. General error isolation still matches: hourly catches pending error and proceeds to the independent files/log halves; boot recovery error fails boot.

Binary SHA256 independently verified `204e47771c3ae822108ca26f533f1a0920c9861438397c12147a2b14a6ff49ae`. maintenance.exit=0. Review manual gateways used ports 19770/19771, private HOME, explicit env, bun --no-env-file for every Bun command.

Independent Bun binding probe: NaN binds SQL NULL/no matches; Infinity binds REAL/all finite rows; -Infinity binds REAL/no matches; 0.5 binds REAL/rows -1,0. JSON serialization of an Infinity result cell becomes null, so type and selected rows, not serialized cell alone, establish binding behavior (`binding-ts.json`).

Frozen source oracle paths maintenance/lifecycle/config/usage are unchanged against 1780bb39 (`oracle.diff`, zero bytes). New ordinary scalar corpus has 48 scalar values (all requested examples, null/bools/numeric variants, Unicode whitespace/non-whitespace, invalid grammar, binary/octal/hex, exponent overflow strings); body validation corpus has 54 values including object/array invalid body values. Additional raw-text corpus tests overflow numeric literals and lone-surrogate escape strings that cannot be faithfully constructed through serde_json::Value roundtrips.

## Gate command provenance

workspace: `cargo test --offline --workspace` with CARGO_BUILD_JOBS=2, CARGO_INCREMENTAL=0, CARGO_PROFILE_DEV_DEBUG=0, CARGO_PROFILE_TEST_DEBUG=0, CARGO_TARGET_DIR=/home/homebrew/code/omnigateway/target. Independent harnesses/gates have reproducible shell scripts in this evidence directory. Every command cwd is detached review checkout, never real workspace.

## Retained differences / unverified (not newly fixed by r1)

- Array/object raw log retention intentionally STOP/refused; not JS ToPrimitive parity.
- Coord boolean API suppresses backend failure distinction and cannot emit frozen `maintenance lease failed`; startup supplies process-local MemoryCoord, not multi-process Redis coordination. TTL/name/not-released unchanged; repeated same-holder acquisition renews, not a whole-job mutex.
- Tokio Skip avoids backlog bursts but keeps original timer phase unlike Bun setInterval after stalls; first ticks remain delayed.
- spawn_blocking permits true thread overlap and extra SQLite connections, unlike frozen synchronous SQLite/event-loop execution; multiple hourly sweeps can overlap, both before and after this fix. Rust tracks/drains jobs on stop; frozen stops timers without tracking background promises.
- One shutdown_until now shared, but not a guaranteed full-process hard deadline: blocking SQL/filesystem work is uncancellable and cleanup/writer.close remains outside hard global timeout. No new actual hourly-SIGTERM contention E2E was run in r2; r1's confirmed-lease blocked-stop evidence remains applicable.
- PG runtime, actual Bun SQL bigint parameter encoding, multi-node Redis, all per-step failure/log text capture, and full concurrent HTTP latency under maintenance remain unverified. PG compile/unit conversion tests do not establish protocol parity.
- One-row recovery's IMMEDIATE lock differs from deferred frozen transaction; real writer/recovery claim tests check double-counting, not exhaustive multi-process ordering. Frozen stale-count vs Rust actual-claim-count differs under competing external completions; Rust success count is intentionally truthful.
- Million-row timing repeated opportunistically by original harness: Rust debug **4680 ms**, frozen **2951.167 ms**, each removed 1,000,000 (`large-results.json`); one sequential sample, not controlled release performance gate. Request-path SQLite writer can stall for whole prune transaction; spawn_blocking only protects runtime threads, not DB lock.
- Unscaled cap boundaries 99,999/100,000/100,001 and snapshot+staging symlink fixture were rerun by original harness, all match. Prior negative driver-control remains evidence; no exhaustive randomized snapshot policy or per-step log capture claim.

## Independent results / counts

- Original randomized DB differential: **seed 11011 200/200 equal; seed 22022 200/200 equal**, zero mismatches. Includes original null/bool/string malformed settings; six full typed tables, counts, artifact filenames. Harness intentionally records mismatch counts; checked random-results.json, not merely harness exit.
- Additional **48/48** ordinary scalar ToNumber/horizons/selected-rows comparisons equal, including every specifically requested example; **54/54** body-retention validation comparisons equal; **2/2** array/object raw-log cases refused as directed.
- Additional raw-text JSON: **3/4 row/count pairs differ** (overflow numeric +/- and lone-surrogate log string). Fourth unrelated-surrogate pair has differing horizon but accidentally equal selected rows for two-row seed; direct frozen horizon probe establishes zero-day vs Rust default 30-day difference. See finding 1. Raw overflow probe additionally shows valid whole-object parse acceptance behavior; not mixed into ordinary 48-value pass count.
- Queue capacity 1, explicitly prefilled: recovered **3/3**, repeat **0**, pending **0**, drops **0**.
- Competing live writer vs recovery: recovery won **35/50** claims in this run, writer won rest, **50 daily requests total**, no double counting. Two simultaneous recovery threads: **50 total** claims across both; daily/hourly totals **53/53** including preceding 3-row partial-failure test. Ordering/winner count nondeterministic, uniqueness assertion deterministic.
- Mid-way trigger failure: both frozen and Rust committed first row, rejected b, then after trigger removal retry recovered **2**. Busy test shortened connection busy_timeout to **25 ms**, confirmed error while lock held then success after release; production source uses **5000 ms** (not time-waited separately). Live writer/recovery were real concurrent threads with SQLite IMMEDIATE serialization.
- Boot RTK paired nonzero row equal; committed black-box driver exit 0 and heartbeat observed. No claim of graceful SIGTERM from boot.py because killed before signal handler registration.
- Reviewer independent harness: **5/5** tests pass; additional scalar/recovery harness **7/7** pass. Overflow tests intentionally save paired discrepancy evidence instead of asserting equivalence; exit 0 does NOT imply those 4 cases equal.

## Final gates (exit files)

| Gate | Exit | Notes |
| --- | ---: | --- |
| workspace | 0 | 1322 passed, 0 failed, 37 ignored; named flakes all pass first try |
| clippy workspace all-targets -D warnings | 0 | offline |
| fmt --all -- --check | 0 | temporary harnesses removed first |
| dispatch_size | 0 | 1 passed |
| maintenance.ts final binary | 0 | nonzero RTK + heartbeat + typed tables |
| reviewer run.ts | skipped | competing driver at one pgrep check; never waited |
| independent harness | 0 | five tests, including 400 DB pairs |
| scalar/recovery harness | 0 | seven tests; discrepancy recording noted above |

At finishing check implementer's `/tmp/opencode/a11/r1-run.exit` existed and was **0** (copied to implementer-run-observed.exit). Its log ends “all rows equal”: request_logs 37, usage_daily 18, usage_rollup 6, credential_health 4. This is observed implementer evidence, NOT a reviewer-owned run; reviewer never waited or polled for it.

## Restoration / outcome

**REQUEST CHANGES**, one Important remaining raw JSON.parse compatibility finding; original queue and boot findings closed. No product edits/commits/subagents. Temporary reviewer tests copied to this directory and removed. Checkout clean at **cad81b632447df97189812b6e33c56432213bf61**: restoration.status empty; restoration.diff empty; restoration.exit=0. Final disk ~11 GiB free, never below 5 GiB. Evidence and all harness sources retained under `/tmp/opencode/a11-review/r2/`; no prior evidence overwritten/deleted. Reproduction: copy retained .rs harnesses to corresponding crates/omni-gateway/tests paths and run the saved run-independent.sh with the mandated build env from this checkout; raw overflow full prune fixture writes `overflow-prune.json` with frozen and Rust counts/rows. Gates ran without temporary harnesses except their own explicit independent runs.
