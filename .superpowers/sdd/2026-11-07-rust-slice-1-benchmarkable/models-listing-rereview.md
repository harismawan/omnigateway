# Re-review — a49bfa0a

Verdict: **APPROVE**. Prior Important finding **closed** by independent measurement. Critical / Important / Minor findings: **0 / 0 / 0**. Workspace caveat: initial full run hit the specifically disclosed unrelated WAL-reader flake, isolated rerun passed; a full rerun is still running and is not yet claimed green. Clippy, fmt, e2e and listing-specific checks passed. Subject worktree remains read-only; experiments use archived scratch sources.

## Finding closure: same fixture, new measurement

The original review's `latency/seed.db` was backed up into four private roots, unchanged: 5,000 enabled OpenAI credentials, alternating API/OAuth, 500 models × four catalog targets. Private HOME, scrubbed explicit environment, ports 19710–19713; no provider traffic. Each binary: 20 warmups, 100 sequential measured HTTP requests; all four gateways stopped after measurement. Debug binaries on shared host, not a release/concurrency benchmark.

| Binary | Median ms | p95 ms | Body bytes |
|---|---:|---:|---:|
| Original baseline | 0.958 | 3.788 | 72,578 |
| Previous reviewed final | 355.983 | 447.901 | 95,578 |
| New final | **4.996** | **5.422** | **95,578** |
| Frozen TS | 90.236 | 121.227 | 95,578 |

New is **71.3× faster than previous** and **18.1× faster than frozen** median. It legitimately does more work and emits more fields than original baseline; the avoidable 350+ ms credential-scaling cost is gone. `latency/results.json`, per-binary body files and DB copies preserve evidence. `latency.exit`: `python3 measure.py: 0`; `latency-body.exit`: `cmp new/frozen HTTP body: 0`. New binary SHA256 in `final.sha256` (matches implementer's prefix 984a7ea4).

## Index semantics, line-by-line

* `model_limits.rs:8–17`: request-local maps borrow snapshot facts. No DB/state/cache reads. Keys are string contents, not pointer identity. HashMap iteration order is irrelevant: only keyed lookup and ordered Vec traversal occur.
* `:19–35`: one traversal, disabled rows excluded before both indexes. Per-provider bool Vec retains **first auth behavior occurrence order** (OAuth vs every non-OAuth spelling), matching frozen Set order for API/OAuth. Unknown auth spellings also behave like API in frozen `choiceLimits`; collapsing them cannot change these pure minimum/override results. No catalog model-auth, endpoint, token, quota or expiry filtering added to provider-wide auths.
* Pin buckets include all **enabled** credentials with the same id in input order. SQL ids are primary keys, so real routing snapshots cannot contain duplicates from one credentials table. Synthetic duplicates remain correct: later valid same-id account is still reachable if an earlier same-id account has wrong provider/endpoint. Disabled/omitted rows cannot shadow an enabled row.
* `:65–75`: target's present pin chooses only the same-id bucket, then first `serves_target` success. This is equivalent to previous `.find(c.enabled && serves_target(...))`: `serves_target` already requires matching id for a pinned target. Provider, endpoint, unusable endpoint, lone identity checks are unchanged. Empty pin id remains a real id, not “unpinned”. No pin means no bucket search.
* `:76–86`: resolved pin supplies its own one auth. Disabled/missing/wrong-provider/wrong-endpoint pin falls back to the **target provider's enabled auths**, never all providers and never the disabled pin's auth. No auths gives original API default. Routing-omitted metadata rows are absent from both maps; behavior with remaining snapshot facts is unchanged from previous code.
* `:87–115`: catalog lookup, whole-object OAuth override, saved per-field override and independent target narrowing unchanged. Absent is no constraint; NaN propagates; ±Infinity becomes null on wire; ±zero becomes 0. Deduplicating API-equivalent paths cannot affect minimum except possibly zero sign, unobservable in listing JSON. Retained order plus idempotence/commutativity of serialized minima covers absent/NaN cases.
* `models.rs:13`: index built **once before model loop**; each model borrows it. No response field/order, allowlist, headers/status, cursor or auth/error-path change.

Cost/safety note: index construction is O(snapshot credentials) in time and borrowed-entry storage, even when the visible listing is empty (previously no per-model work in that case). This is a bounded extra pass, not the former O(models × targets × credentials) duplicate narrowing. With SQL-unique credential ids, pin bucket search visits at most one account; synthetic duplicates preserve semantics but can lengthen that bucket. No snapshot-triggerable unwrap/expect/indexing/panic was introduced. Test-only Cell counters do not exist in production builds.

## Independent differential checks

Archived `a49bfa0a` router sources were compiled with rustc against fingerprint-matched warm dependency rlibs, then linked to a harness using archived gateway models.rs. No separate Cargo target or product edits. All commands/actual JSONL files retained here; original inputs/oracles retained in parent review directory.

* Original two seeds (`0x12345678`, `0xcafef00d`): **7,000 equal / 0 different**, each seed 3,500. All prior classes retained; byte `cmp`: 0.
* Original injected NaN/±Infinity/negative-zero cases, one/two targets: **8 equal / 0 different**; byte `cmp`: 0.
* Additional synthetic catalog projection matrix: **196 equal / 0 different**, testing each API/OAuth field pairing over absent, NaN, ±Infinity, ±zero and fractional values, both auth visitation orders and duplicate auth paths. This invokes frozen `resolveModelLimits` and archived Rust `resolve_model_limits` with matching synthetic descriptors, projecting context/output to a JSON tuple (absent/nonfinite become null). Evidence `auth-values-*`, `auth-values-compare.exit`: 0. The retained eight full-body cases separately distinguish omission from nonfinite null.
* New synthetic pin/index matrix: **960 equal / 0 different** against frozen function. All ordered pairs of eight credential variants sharing an id or using another id; enabled/disabled, wrong provider, API/OAuth/unknown auth, absent/named/null credential endpoint; five target endpoint forms; present/missing/absent pins. Input, frozen expected and Rust actual JSONL retained here. Includes duplicate-id ordering that cannot occur in the SQL table.
  The same 960 also match the **previous Rust implementation** byte-for-byte (`index-previous-compare.exit`: 0), directly checking that the first-match optimization itself does not change pin resolution.
* Implementer's current corpus independently executed through the new harness: **473 equal / 0 different** (`corpus-summary.json`).
* Previous future-data proof repeated on the new index: scratch-only antigravity catalog loading, **18 equal / 0 different** (`future-compare.exit`: 0). Same round-1 inputs and full frozen antigravity expected bodies; data-loading experiment restored afterward.

## Guard mutation experiment

Both new tests pass unmodified (`guards.exit`: 0). Restored **old per-target algorithm** in scratch only, adapting signature to retrieve original input Vec and incrementing the same visit counters; archived mutant is `old-model_limits.rs`.

* `one_request_pass_then_two_auths_or_one_pin_per_target` fails: **10,000,000 auth visits vs expected 4,000** (`old-guards.exit`: 101).
* Bypassing only earlier auth-count assertions to reach pin assertion fails: **9,998,000 pin comparisons vs expected 2,000** (`old-pin.exit`: 101).
* `narrowing_order_and_dedup_do_not_change_special_number_bytes` **passes old and new**. It is a semantic algebra guard, **not a complexity guard**. Thus “two complexity guards” is imprecise if it means two test functions; there are two demonstrated complexity assertions inside one test, plus a semantic test. No product correctness concern.

Limitation: iterator `visited` proves one enumeration by construction, not that a later resolver cannot rescan a stored source; auth/pin counters provide the old-algorithm regression detection. They do not automatically detect arbitrary future uncensored scans or moving index construction back inside model loop. Code audit confirms neither occurs now. Scratch restored to archived indexed implementation after mutations.

## Gates and evidence boundaries

* e2e independently passed: `.exit` contains `bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/models-listing/r1/final (scratch ports 19740/19741): 0`; log ends **all rows equal**, including request/usage/credential-health DB rows. One-time `pgrep -af 'conformance/e2e'` before run found only the checking shell's own command text, no other driver (`e2e-process-check.txt`). Scratch driver port remapping only; no committed edits.
* Dispatch test independently printed **5,496 bytes** (`dispatch.log`, `dispatch.exit`: `warm dispatch_size test binary --nocapture: 0`). This is a retained shared-target executable, not claimed as a new build; the pending workspace run separately executes its current dispatch test.
* `clippy.exit`: `cargo clippy --offline --workspace --all-targets -- -D warnings: 0`.
* `fmt.exit`: `cargo fmt --all -- --check: 0`.
* Initial `workspace.exit`: `cargo test --offline --workspace: 101`. The **disclosed known WAL-reader flake** failed at `omni-store/tests/writer.rs:1259`: `reused after the reader left: 2513232 > 1190712`. Initial run reached 170 summaries, 1,273 passes / 1 failure / 16 ignored before stopping, so it is not claimed green. Isolated one-time rerun passed: `workspace-flake-rerun.exit` contains `cargo test --offline -p omni-store --test writer a_pinned_reader_lets_the_wal_grow_past_the_trigger -- --exact: 0` (1 passed). Full-workspace rerun result pending at this update. No listing test failure.
* Commands used offline/shared-target/two-job/no-debug/no-incremental settings, one cargo command at a time. No polling or sleep used for background completion.

Namespace suites were not independently rerun in round 2. Implementer's r1 `.exit` files read 0 and logs report Anthropic 30 / OpenAI 56, both zero failures; these are corroborating artifacts, not my execution. The fix changes only the pure listing module, its export, and index construction in the existing listing writer, with no provider/codec or routing dispatch changes; prior source-based consumer audit still applies. No new DB read, external provider traffic, commit, product edit or subagent. All gateway processes started by this review used explicit environment/private HOME and ports 19700–19799. Final scratch source comparison against `git show a49bfa0a` is true for all three changed source files (`scratch-source-check.txt`); subject status remains clean. Lowest observed free disk so far 5.9 GiB, above 5 GiB stop threshold.

Approval rests on: request-local single-pass index placement; preserved first-enabled-serving pin order and fallback; **8,655 equal / 0 different** across the corpora above; large-fixture cost restoration; green clippy/fmt/e2e/listing checks; and treating the disclosed known WAL-reader failure as unrelated after its isolated pass. The pending full rerun will be recorded separately, not silently treated as already green. Remaining scope limits from round 1 persist: debug/shared-host rather than release/concurrent performance, no exhaustive malformed schema/plugin compatibility, namespace suites not independently rerun. Future antigravity data loading was rechecked on this index. None of these boundaries is expanded or regressed by this index.
