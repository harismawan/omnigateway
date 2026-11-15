# A8 speed investigation, rounds 1–4
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
