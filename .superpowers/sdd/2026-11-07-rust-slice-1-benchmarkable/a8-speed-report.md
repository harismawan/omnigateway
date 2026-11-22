# A8 speed investigation, rounds 1–5
- R1 baseline 1k/10k/50002:2.981/31.692/187.451 ms; split read36.661/preliminary66.221/projection7.793/validation2.963/final4.723/serialization61.737.
- R1 f43a486e →135.138;c2d73919 →92.689;7805401f →78.516;bf7482f5 →71.233 ms; E2E Rust75.8/TS60.4; report48b0de37.
- R2 baseline61.738 →5112834b compact49.219 →5108fa28 ranked43.436;1k/10k .621/8.176;reportf0c5d283.
- R1 lacked observed index; R2 used rowid/no-affinity, NOT production WITHOUT ROWID. Those timings cannot establish production parity.
- R3 production standalone58.710,gateway function67.593/handler68.143;frozen function40.780/stringify12.411/combined53.190;E2E Rust75.1/TS70.3.
- R3 no production change; transport negligible (one writev/no explicit body copy); attribution uncertain; tests387 passed/clippy/fmt passed.
## R4 production baseline (milliseconds; nine measured repetitions)
- Corrected history_speed: real SqliteStore::open migrations, unique file directory under /tmp/opencode/a8/speed, second inserting connection, nine driver labels/overflow SQL, open_reader; database removed on success.
- Legacy altered-schema fixtures retained separately as ignored history_legacy_snapshots; sort_tests untouched. Production code unchanged.
- Snapshots captured ONCE as r4-production-{count}.json before experiments, then compared; frozen script verifies identical bytes at all sizes:172198/1715143/8550404.
| Samples | Rust pre-serialization | Rust serialization | Rust total split run | Frozen function | Frozen stringify | Frozen total | Rust final uninstrumented |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 1.128 | .180 | 1.354 | 1.084 | .250 | 1.589 | 1.054 |
| 10,000 | 10.423 | 1.908 | 12.535 | 9.588 | 2.663 | 12.376 | 11.231 |
| 50,002 | 58.487 | 10.649 | 69.583 | 45.878 | 14.280 | 60.192 | 61.815 |
- Independent medians do not sum. Rust pre-serialization excludes cleanup; total includes cleanup. Split timing/logging removed before final build. Host/time variation is not an optimization.
- External r3-frozen.ts extended: three sizes,warmup+nine,real createStore/accountQuotaHistory/JSON.stringify; r4-frozen.log. No repository TypeScript edited.
## Split / SQLite floor
| Samples | Bare step | Step+seven get_ref | Full compact reader | In-function read | Preliminary sort/trim | Projection/validation/final sort | Serialization |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | .493 | .893 | 1.190 | .904 | .143 | .057 | .180 |
| 10,000 | 3.636 | 5.734 | 7.350 | 7.951 | 1.740 | .601 | 1.908 |
| 50,002 | 20.383 | 31.167 | 41.842 | 45.389 | 10.539 | 2.930 | 10.649 |
- Seven-cell measurement reads borrowed cells (black_box); full compact includes ownership/interning/drop. Preliminary sorts indices, not fat rows. Cap reads50001/trims50000.
- EXPLAIN: SEARCH quota_samples USING INDEX quota_samples_observed (observed_at>? AND observed_at<?). Non-covering: observed_at+PK credential_id/window_type present; used/limit_value/resets_at/window_ms require primary-key-tree lookup. No temporary sort tree.
- Benchmark-only cache_size -2000 → -32768 KiB: total1.208/13.607/68.847;cap stepping22.195/cells31.447/compact41.549. No material cap improvement observed; no connection setup edit or query variant.
- No production optimization or before/after commit this round; typed-cell/interning hypotheses remain untested. Benchmark correction only. Logs:r4-baseline.log/r4-cache.log/r4-final-bench.log.
## Final E2E (release copy r4-release; every response200/8550404 bytes)
- Run1 TS:86.5,69.4,75.4,69.9,64.0,72.1,60.8,69.2,69.8 →69.8;Rust:78.1,80.5,78.9,78.2,75.0,80.8,80.0,80.1,69.9 →78.9.
- Run2 TS:96.7,90.9,89.5,69.7,64.3,69.8,68.2,71.9,65.8 →69.8;Rust:83.8,76.2,86.7,85.4,75.1,78.6,73.9,78.1,70.8 →78.1.
- Uptime:16d9:43 load3.10/4.16/4.27;16d9:44 load3.67/4.23/4.29. Free disk5.5GB before benchmark release/5.2GB before gateway release. Logs:r4-time-{1,2}.log/r4-uptime-{1,2}.log.
## Gates / conclusion
- r4-tests.log:68 test result: ok summaries;387 passed,11 ignored,0 failed,no FAILED line (extra ignored legacy fixture);sort_tests pass.
- r4-clippy.log:Finished dev profile [unoptimized] target(s) in3.83s;r4-fmt.log:exit=0.
- r4-client-history.log:admin-routes: 9892 equal, 11 expected divergences, 0 failures, 0 raw keys minted.
- r4-client-quota.log:admin-routes: 6081 equal, 6 expected divergences, 0 failures, 0 raw keys minted;debug binary copied outside checkout.
- Scratch instrumentation removed; driver directories/frozen scratch database cleaned; logs/snapshots/scripts/binary copies retained. No unrelated staging,push,merge,SQL/schema change.
- Rust is faster up to 10,000 samples and slower/level at the cap, because measured cap read/preliminary sort dominate Rust execution (inference: opportunity above SQLite floor). Final standalone61.815 vs60.192;E2E78.9/78.1 vs69.8/69.8. Runs varied: no production speedup or robust small-size advantage established.
## Round 5
- Each entry below: three-run median of medians [min,max], ms, sizes1k/10k/50002; uptime recorded in each r5 log under /tmp/opencode/a8/speed/. Benchmark/snapshots unchanged. Requested invocations were absent from all three named r4 logs; used the existing ignored test in compare mode and bun r3-frozen.ts directly.
- Baseline r5-before:1.006[.986,1.049]/10.826[10.779,10.984]/58.886[58.376,60.930].
- Interning trial (bounded16/direct typed equality, hashed overflow, malformed UTF-8 preserved) → .998[.955,1.020]/11.127[11.075,11.316]/60.866[59.512,60.922]; REVERTED, no demonstrated benefit; r5-intern.log/diff. Mixed-type thousands-of-cells regression test retained.
- Flat-key sort alone → .967[.899,1.042]/11.193[11.130,11.436]/58.168[57.524,62.757]; inconclusive, superseded by counting grouping; r5-flat.log.
- 006eab9d stable counting-group scatter + cached numeric per-group sort (flat-key fallback above64 ranks): baseline →1.077[.958,1.727]/10.660[10.480,11.733]/54.840[53.611,55.342]; r5-group.log. Cap improvement exceeds range widths; small-size improvement not established. Exact comparator handles mixed cells/NaN without affinity assumptions; stable ties and trim retained.
- 807b3a2f bounded LIMIT reservation: repeated before1.060[1.002,1.079]/10.854[10.632,10.920]/59.598[57.785,60.204] →after.883[.857,.892]/8.692[8.603,8.843]/47.554[46.419,48.254]; r5-reserve-{before,after}-repeat.log. Initial after .881[.873,1.356]/8.832[8.752,8.933]/47.104[46.742,101.910] had noisy outlier; repeated BOTH sides, retained all logs.
- Load averages baseline .54/.61/1.99, group3.85–5.02/2.12–2.56/2.27–2.41, reservation-repeat before5.75–6.08/3.55–4.04/2.79–3.00 and after4.89–5.47/4.06–4.12/3.04–3.11. 1eb9e029 test lint cleanup; no production change.
- New cap split: bare19.378/borrowed30.304/full-reader37.627 (r5-final, three medians); instrumented read35.640/preliminary.699/projection-validation-final2.261/serialization5.867 (r5-split, nine medians). Instrumentation removed; independent medians do not sum; serialization code unchanged.
| Samples | Final Rust total [three-run range] | Frozen function | Frozen stringify | Frozen total | Rust faster |
|---:|---:|---:|---:|---:|---:|
|1000|.910[.854,.919]|.858|.195|1.033|.123 ms (11.9%)|
|10000|8.768[8.626,8.771]|7.459|2.293|10.146|1.378 ms (13.6%)|
|50002|46.205[45.190,46.241]|39.711|13.086|53.111|6.906 ms (13.0%)|
- Final comparison same sitting:r5-final.log/r5-frozen-final.log; all three byte snapshots identical after every trial; r5-legacy.log passes untouched legacy snapshots. Standalone target met in these observations; host variability remains. Item4 gateway allocator/cold-thread investigation not reached; no E2E timing claim.
- Final gates:r5-tests.log 68 `test result: ok` summaries,389 passed,11 ignored; r5-clippy.log `Finished dev profile [unoptimized] target(s) in 4.22s`; r5-fmt.log `exit=0`; grep FAILED/panicked/^error empty for final gate logs.
- r5-client-history.log:`admin-routes: 9892 equal, 11 expected divergences, 0 failures, 0 raw keys minted`; r5-client-quota.log:`admin-routes: 6081 equal, 6 expected divergences, 0 failures, 0 raw keys minted`. Both output directories removed after saving summaries; final debug copy r5-rust.
- Release copy:/tmp/opencode/a8/speed/r5-release; r5-release.log Finished release in1m21s;5.0GB free before build. No unrelated staging, stash/worktree changes, SQL/schema edits, push, merge. Report deliberately uncommitted.
