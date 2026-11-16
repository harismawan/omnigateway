# A11 final re-review at b155f90b

Verdict: **APPROVE A11 at b155f90b**, within the documented differences/unverified scope below. All ranked Important findings from rounds 1–2 are closed; no remaining Critical/Important/Minor finding raised in this narrow final round. All own final gates passed.

Initial HEAD b155f90b968544114ed1d7d35b9f646658e63e3c, clean; disk 10 GiB free. Required Rust touch, offline/jobs=2/incremental=0/debug=0/lent target environment. One pgrep check found no competing conformance driver, so maintenance.ts followed by run.ts launched serially, explicit private HOME and no inherited environment; no waiting/polling. Final binary SHA256 independently verified e586eeb972b1ed50d85bdf9c4c62009b18cb17e890b1928ec19a018e4abc57c8.

## Source audit

maintenance.rs now uses lossless jsjson::parse_js without serde_json conversion. Object properties compare exact UTF-16 names; reverse search uses final value (parser also replaces duplicates). Missing/non-object/invalid JSON returns defaults; numeric infinities and signed zero preserved. UTF-16 strings decode only for StringToNumber; malformed surrogate becomes NaN, which is correct since it cannot satisfy numeric grammar. Null/bool/scalar number branches match frozen coercion. Raw array/object log value still STOP/refused intentionally. Body retention remains literal integer-number 1..3650/default 1. Explicit NaN propagation avoids f64::min's NaN suppression.

parse_js validates via iterative jsc_json::parse_error, then builds via explicit Frame stack; JsValue Drop is iterative. Neither source contains a serde depth=128 bound or explicit nesting ceiling. Unrelated nesting at 128/1024/2000/10000/100000 arrays, plus 1000/10000 objects, matched parse acceptance + resulting horizon + full typed-table/count prune comparison. **No X1/depth-class discrepancy observed** through those depths; no depth-policy ruling made.

Prior queue loss and boot RTK findings were closed in round 2. Recovery remains one direct IMMEDIATE completion transaction per persisted row; shared boot/hourly reader, no lossy bounded admission, idempotent done-row claim, daily/hourly rollup atomicity. Round-2 independent live-writer race totaled exactly 50 completions (35 recovery wins); two recovery threads 50 total claims; partial failure 1 committed then retry 2; queue capacity 1/prefilled recovered 3, repeat 0. Missing commit sink callbacks match frozen store sweep bypassing gateway completion callbacks; no quota/metrics/stream consumer of that channel. Own-node retired rows may be active, contrary to original implementer prose, but oracle also uses that predicate.

## Gates available so far

Reviewer maintenance.exit=0; reviewer run.exit=0 on exact final binary. run.ts log: 37 request_logs, 18 usage_daily, 6 usage_rollup, 4 credential_health rows equal; all rows equal. No conflicting driver at launch check. No reviewer gateways outside prescribed drivers this round. Bun commands always --no-env-file, drivers supply private HOME/explicit env to gateway subprocesses.

workspace.exit=0: **1323 passed, 0 failed, 37 ignored**; all three specified known flakes passed first run, no retry. Temporary reviewer target was added after workspace target discovery and does not appear in workspace log; it runs separately. workspace-summary.json contains aggregate and exact named flaky test lines. Disk remained ~9.8 GiB free after test run, above 5 GiB floor.

Independent Bun depth probe confirms JSON.parse accepts unrelated nested arrays through 100000 and frozen getSettings still reads logRetentionDays=0 (depth-ts.json). Rust paired parse/horizon/prune checks all matched. Parse/default checks in full pair comparison rule out vacuous equal-default results when both should read explicit 0.

## Complete retained differences / limitations for final disposition

1. Raw **array/object logRetentionDays** deliberately STOP/refused instead of JS ToPrimitive. This approved boundary is NOT applied to unrelated nested objects/arrays, top-level non-object settings, or body values (body validates/defaults).
2. Gateway boot still uses fresh process-local **MemoryCoord**, so no actual multi-process lease arbitration. Lease name/2-hour TTL/reacquisition/not-released match; no whole-job mutex, same-holder jobs can overlap. Redis multi-node runtime/lease expiry failures remain unverified.
3. **Coord bool API** maps coordination failures to false (skip), losing frozen failure distinction and `maintenance lease failed` log. Other message/level/field shapes statically match; exhaustive injected reason-string/error/log comparisons remain unverified.
4. **Tokio Skip timer phase** differs from Bun setInterval after stalls (no backlog Burst in either); first ticks remain 10 seconds/one hour, no immediate hourly prune. Stalled compiled-oracle event-loop full integration unverified; prior scaled Bun timer probe establishes phase behavior.
5. **Blocking-thread overlap/extra connections** permit interleavings absent from frozen synchronous SQLite/event loop. Scheduled sweep jobs can overlap; files/log halves independent after pending. Rust samples time when blocking work executes rather than exactly when frozen launched pruneLogs. No exhaustive lock/concurrency schedule equivalence claim.
6. **Tracked shutdown/shared grace is best effort**, not hard full-process cutoff. Rust drains running maintenance whereas frozen only clears timers; maintenance can consume shared grace before HTTP graceful drain starts. In-flight spawn_blocking SQL/filesystem tasks cannot be forcibly cancelled, and writer/cleanup joins may outlive grace. Real SIGTERM during actual hourly sweep with contention remains unverified. Round-1/2 confirmed-lease harness showed blocked stop exceeding shortened 50 ms timeout, then draining after lock release; heartbeat stops when loop stopped.
7. **Recovery IMMEDIATE transaction lock** differs from frozen deferred transaction but prevents replay/read claim races. One completion+daily+hourly transaction per row matches frozen granularity. Actual successful-claim count vs frozen selected-row count differs if another process completes between selection and claim; no double rollup in tested live-writer/two-recovery races. No sink callbacks is parity with frozen store-level sweep, not a new difference. Raw request-path bounded-loss policy remains existing, but maintenance recovery bypasses it now.
8. **PG runtime/protocol parity unverified.** PG timestamp APIs accept f64, validate finite/integral/range then bind bigint; compile/unit tests only. No PostgreSQL gateway boot/worker integration in A11 (running boot SQLite-only). Actual Bun bigint conversion/refusal, fractional/nonfinite horizons, multi-process PG concurrency not established.
9. **SQLite cost/lock contention**: prior independent million-row prune single samples Rust debug ~4.68 s vs frozen ~2.95 s, both delete million. spawn_blocking protects async threads, not SQLite's single-writer lock or bounded request-writer queue. Concurrent HTTP/writer throughput under large cleanup unmeasured, no release benchmark guarantee.
10. **Filesystem edge coverage limited**: unscaled 99999/100000/100001 cap ties, populated body files/orphans and deterministic snapshot/staging retention/nonmatching/symlink fixture match. Not randomized snapshot policies, pre-epoch/submillisecond staging timestamps or exhaustive filesystem failures. Rust staging timestamps truncate to milliseconds/ignore pre-epoch metadata; paired extreme-mtime test not performed. Body per-step counts compared in original fixture; randomized corpus compares aggregate body count. Existing negative driver mutation catches missing retirement rows; maintenance.ts cannot externally trigger hourly prune and has empty keyed hourly rollup for its anonymous fixture.
11. **Other scope limits**: no exhaustive malformed SQL-cell types for pending recovery; source typed row mapping assumes ordinary stored types. No new gate claims for unrelated migration areas. Prior report findings/paired evidence retained; no product edits, commits or subagents in review.

Approval rests on these explicitly recorded differences/limitations, not universal frozen identity or production fleet certification.

## Independent corpus / reproducibility

Temporary `crates/omni-gateway/tests/a11_r3.rs` reruns original randomized seeds 11011/22022, 200 cases each, with six full typed tables + counts + artifact filenames. Raw-text corpus starts from implementer's 12-case fixture but includes exact original four cases, unrelated overflow/surrogate values, duplicate raw/body keys, escaped duplicate property name, prior array overridden by final scalar, top-level arrays/string/number/null/bool/infinity/surrogate strings, empty/truncated/invalid JSON, and unrelated deep arrays/objects. All values are stored **as raw text**, never passed through serde_json serialization; expected output invokes frozen source createConfigRepo/pruneLogs.

Raw cases seed ancient, 31d, 2d, 1d, now-1, now, now+1 request/body rows and rebuilt hourly rollups. Compare six typed tables/four aggregate counts, explicit parse acceptance and raw/body horizons. Signed-zero effects disappear after `now - days*DAY`, as frozen; underflow-to-zero still produces zero-day horizon. NaN/infinity horizons are string-tagged in metadata so JSON serialization does not collapse them to null. Duplicate array-first/scalar-last verifies refusal is based on final key, not first. A depth discrepancy would be recorded in mismatch-N.json and referred as X1/depth-class without ruling beyond scope.

Saved shell scripts independent.sh and gates.sh use mandated Cargo environment; run from review checkout. Test harness copied to evidence before removal; repro by copying it back to tests/a11_r3.rs and running independent.sh. Product gates run separately with temporary harness absent. Raw fixture writes per-case pair/meta files and a cases index, not just an aggregate assertion, so horizon/default mismatches remain inspectable. All subprocess Bun commands use --no-env-file and explicit env/private HOME.

## Frozen defaults and duplicate-key checks

Independent defaults-ts.json confirms valid top-level array/string/number/null/bool all return raw=30/body=1; invalid empty/truncated/NaN/trailing-comma text also defaults but JSON.parse acceptance is false. Duplicate raw keys 30→0 yields 0, 0→30 yields 30; []→0 yields 0 without array refusal. Metadata in paired corpus checks the acceptance/default distinction.

Object-depth-ts.json independently confirms unrelated object chains at 1000/10000 parse and preserve logRetentionDays=0 in frozen; array probe covers up to 100000. Tests exceed serde_json's typical recursion depth substantially without assuming an arbitrary Rust depth bound exists in parse_js. No request-parser depth ruling is inferred from these settings-only tests.

For the final remaining finding, relevant lines: frozen config.ts:99 JSON.parse, :108-110 spread stored scalar; maintenance.ts:50-57 JS arithmetic. Rust maintenance.rs:8-29 now preserves the exact parse domain; :38-50 validated body/min/horizons. Depth implementation jsjson.rs:627+ and iterative JsValue Drop :79+ avoids fixed serde recursion limits.

## Regression-test quality notes

The committed raw-text red/green fixture covers 12 cases and has real nonempty rows across horizons; reviewer extends it to 35 cases plus three explicit structured refusals. Numeric overflow and surrogate tests write raw text directly to settings rather than serializing through Value, so they would fail the previous parser. In round 2 identical raw positive-overflow and log-surrogate cases demonstrably over-deleted old rows. This is a non-vacuous regression check of the specific finding, not merely testing parser helpers or zero-row tables. Seven-age seed includes 2-day rows to distinguish unrelated-key parsing from accidental 30-day fallback.

Full frozen source paths compared unchanged against commit 1780bb39 (oracle.diff is empty). Implementer exit files were observed all zero, but reviewer verdict will rely on own reruns, not those claims. Dispatch-size is additionally included in own gates despite not repeated in the narrow ask.

## Round-by-round closure criteria

- Round 1 Important retention scalar coercion: round-2 ordinary 48-scalar and 54-body-value comparisons passed, but lossless raw parsing had remained open. Round 3 must close the raw-text boundary as well; Value-generated tests alone insufficient.
- Round 1 Important pending-retirement queue loss: closed by direct recovery, verified round 2 with full/prefilled bounded queue and repeated recovery zero.
- Round 1 Important boot RTK reset: closed by shared reader/direct pre-start recovery; nonzero six-field boot fixture and maintenance driver matched round 2 and final black-box driver again passes.
- Round 2 sole Important numeric-overflow/lone-surrogate parse fallback: exact former discrepancy cases now included in final paired prunes, including unrelated-key contamination. Approval requires no count/row/horizon discrepancy in those reruns.

No changes in this round to schedule, lease, filesystem pruning, store SQL, recovery or shutdown implementations; prior inspection and paired evidence for those remain applicable. Final disposition is for the delivered A11 commit across rounds, not merely two-line parser lint approval.

## Evidence and scope of final judgment

Preserved previous-round review files and implementer evidence; no commits, no subagents, no product edits. Only temporary reviewer harness added to review checkout. File sources for oracle untouched vs frozen; review binary path is immutable copied artifact whose hash is recorded. `maintenance.ts` and `run.ts` are independent executions this round, not read-back of implementer's .exit files. Product gate commands are serial (one cargo command at a time) and workspace command used 1200s-capable background job; no polling/wait loop used.

Explicit approval here means no remaining ranked blocking finding within A11's documented SQLite/single-node migration scope. It does not convert listed unverified items into passed checks or bless production multi-node PG behavior. The full retained limitations list above is part of the verdict. Previous raw-setting over-deletion was not excused as malformed input; exact formerly-failing raw texts now produce same horizons, rows and counts.

## Final paired results / closure

**Remaining raw JSON.parse Important CLOSED.** `raw/results.json`: **35/35 paired prunes equal**, no mismatches. Every pair compares full six typed tables/four counts plus explicit JSON.parse acceptance and both raw/body horizons; complete outputs under raw/pair-N.json and metadata under raw/meta-N.json, indexed by raw/cases.json. In particular:

- +overflow `1e309`: both raw horizon -Infinity, raw removed **0**, bodies removed **3** (validated 1-day body window).
- -overflow `-1e309`: both horizons Infinity, raw/body removed **7/7**.
- lone-surrogate raw log string: both horizons NaN, raw/body removed **0/0**.
- unrelated lone surrogate, positive/negative overflow: both retain explicit zero-day horizon, raw/body removed **5/5**, not default 30 days. Exact four previous cases all pass.
- `1e-400` and `-0`: both zero-day horizon, raw/body removed **5/5**.
- duplicate keys, including escaped key and prior array superseded by scalar, use final property. Body duplicate keys validated after replacement.
- valid non-object top levels return 30-day raw/1-day body defaults; truly invalid text defaults with parsed=false in both. Explicit top-level infinity numeric text and surrogate string parse successfully but are not settings objects.
- unrelated array depths **128/1024/2000/10000/100000**, object depths **1000/10000**: both parsed=true and explicit zero-day horizon, raw/body removed **5/5**. **No depth fallback / X1 discrepancy found** at tested depths. Larger resource-limited behavior not claimed.
- **3/3** intentional structured raw-retention STOP cases refused (including scalar-first/array-last duplicate); not mislabeled as oracle equivalence.

Original randomized differential rerun once: **seed 11011 200/200 equal; seed 22022 200/200 equal**, zero mismatches; six typed tables, returned counts, body artifact filenames. `random-results.json` and `paired-summary.json` confirm counts; explicit test assertion also rejects nonzero mismatch count. Independent harness **3 passed**, exit 0 (random pairs, raw pairs, structured refusals). Round-2 ordinary scalar 48/48 and body-validation 54/54 evidence retained; no new claim those separate 102 cases were rerun this round.

## Final gates — reviewer-owned exit files

| Gate | Exit | Result |
| --- | ---: | --- |
| cargo test --offline --workspace | 0 | **1323 passed, 0 failed, 37 ignored**; known flakes first-try pass |
| cargo clippy --offline --workspace --all-targets -- -D warnings | 0 | no warnings/errors |
| cargo fmt --all -- --check | 0 | product checkout, temporary harness removed |
| dispatch_size | 0 | 1 passed |
| maintenance.ts, final binary | 0 | nonzero boot RTK + typed-table equality + periodic heartbeat |
| run.ts, final binary | 0 | all rows equal: 37 logs / 18 daily / 6 hourly / 4 health |
| independent reviewer harness | 0 | 400 random + 35 raw pairs + 3 STOP cases |

Cargo commands used mandated environment, one command at a time; no flaky retry, no waits/poll loops. Own e2e passed in this session, not merely implementer claims. All product gates ran without reviewer harness (workspace discovered targets before harness added; lint/fmt/dispatch after removal). Frozen source oracle diff zero bytes.

## Restoration proof / final outcome

**APPROVE** for A11 delivered at **b155f90b968544114ed1d7d35b9f646658e63e3c**, resting on complete retained differences/unverified list above and previous-round evidence. Checkout restored clean: restoration.head is that exact commit, restoration.status empty, restoration.diff empty, restoration.exit=0. Temporary harness copied to `/tmp/opencode/a11-review/r3/a11_r3.rs` then removed; no product edits/commits/subagents. Final disk ~9.7 GiB free (disk-final.txt), never below 5 GiB. No real workspace/.env/user config touched, no prior evidence deleted. This report supersedes REQUEST CHANGES verdicts only for this final commit; earlier defects/reproductions remain valid for their older subjects.
