# C1 — committed pure-contract checkpoint (not complete)

Branch: `feat/rust-smart-router`, worktree `/home/homebrew/.local/share/opencode/worktree/1600a1/rust-postgres`.

## Commit and evidence

- `5ea5c605672dcce02c246fb897406eb377945f79` — `feat(screening): port pure contracts; 279 oracle cases`.
- 279 differential corpus entries: 24 prompt/key tuples (each checks both requests and both hashes), 60 response parses (both classifiers), 12 cache operations, 26 smart-router extractions, 156 guardrail extractions, 1 relabel sequence/log.
- Frozen sources in this checkout have no diff against `1780bb39` for the nine scoped modules or the two call-site files. All nine modules read end to end. Dispatch read end to end; relevant proxy screening and response-header call sites read.
- `screening-reference.ts` directly imports frozen functions; Rust invokes Bun with `--no-env-file`. Corpus covers numbered tool/history sections, loose case-insensitive tag fencing, citations, native payload opacity/base64 filtering, tool schemas/options/vendor bags, JS integer-key ordering, surrogate-aware smart segmentation, surrogate-bisecting guardrail caps, window clamps, separate newest-first human/tool budgets, exact TTL boundary and LRU eviction, stop reasons, whitespace and garbage verdicts, start-model and requested-model relabeling.
- Initial red attempts failed compilation for the absent module/functions (`pure-red`, `segments-red`, `relabel-red`, `judged-red`, exits 101). These are missing-contract reds, not executable behavioral baseline failures. A separate failed compile (`segments-green-attempt1`, exit 101) was a `&String` match mismatch and is retained. Earlier green log summaries mistakenly said 48 prompt tuples; final corpus correctly reports **24**.

## Design: pure versus effects

Pure: smart segments traverse all upstream-visible text in system/tools/vendor/history, exclude binary/opaque state, split at 8,000 UTF-16 units without splitting a pair, and greedily pack messages separately from system/tools. Guardrail extraction selects the last 1–10 human turns (not tool turns), includes subsequent tool results, and applies independent 8k/16k/16k head-tail caps. Guardrail caps may bisect surrogate pairs; `judged_text_json` preserves those units through the existing JS JSON writer instead of replacing them. Prompt construction uses frozen instruction bytes, loose tag-prefix fencing, no temperature, `stream:false`, maxTokens 1024. Parsing accepts only completed responses, ignores thinking, trims JS whitespace and removes exactly one trailing dot. Cache keys hash structured JS JSON arrays; smart keys omit API-key identity, guardrail keys include it. Both verdicts are cached, never failures. TTL is fixed from insertion, one hour; hits update recency, not expiry; bound 10,000. Relabel changes every start model to configured local model and preserves client requested model in the row.

Effectful (NOT implemented here): smart routing validates configured classifier/local models as local-only, bypasses already-local requests, checks caches, routes >64 uncached segments local, calls up to four classifiers concurrently through dispatch with transforms off and localOnly true, composes client/shared-stop/per-call timeout signals, stops on first confidential/failure, caches whole verdicts and aggregates all spent tokens/cost into one classifier row. Guardrail dispatches one independently logged classifier call, no transforms/body capture/admission, with composed timeout; local smart requests must use the validated local classifier instead of guardrailModel. Refusals are fail-closed with distinct unconfigured/deny/unavailable codes and fixed messages. `screenFirst` defers screening inside the stream so HTTP 200 heads/keepalives precede screening; nonstream failures use the error status, successful judged nonstream responses add x-omni-route. Parent notes, classifier rows, debit overrides, cancellation and local-only revalidation remain part of the wiring checkpoint.

## Current implementation boundary

New module: `crates/omni-gateway/src/screening.rs`. `lib.rs` only exports it. **The fail-closed dispatch::screen stub remains unchanged and active.** This binary is not a completed smart-router implementation. The new pure helpers operate on IR-shaped JSON values; next implementer must bridge typed requests/events/logs carefully. In particular, do not parse surrogate-bearing judged JSON into serde_json::Value lossily when building classifier prompts/keys. `relabel` currently provides a tested JSON rewrite contract, not a live generator wrapper. Cache uses a bounded VecDeque (linear lookup), which may warrant indexing before hot-path integration.

Dispatch size measured before and after: **3,400 bytes**, below unchanged 5,500-byte gate (this commit's Antigravity baseline is smaller than the brief's earlier 5,496). No dispatch state-machine changes.

## Binaries

- Baseline built first at `880f62dee6ed77743107275312b35fe649574622`: `/tmp/opencode/c1/rust-base`, SHA-256 `82cbaa8c9bb691bfa07928c094126d96b722ec6932ef88e51c72a2c26a447759`.
- Post-commit pure checkpoint: `/tmp/opencode/c1/rust-pure`, commit `5ea5c605672dcce02c246fb897406eb377945f79`, SHA-256 `c51277d203ebd8b5880c2fc42c62fd0856fd3c3a450046bcc23c228dea27443f`.
- Frozen executable `/tmp/opencode/a8/ts` verified SHA-256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`.
- Baseline build initially attempted copying `target/debug/omni-gateway`; actual bin name is `omnigateway`. Build itself succeeded; corrected copy retained above.

## Remaining / unverified

Stopped at a committed pure-contract checkpoint. Remaining: effectful screening wiring through adapters/deadlines/logging/debits, process-local cache ownership, streaming/cancellation integration, local-only snapshot validation, reroute/relabel/header plumbing, new smart-router driver and namespace wrapper, baseline behavioral red then final green upstream wire/rows/client comparisons, all requested E2E regression drivers. No provider gateway processes were spawned. No e2e ports selected or used. No admin driver run. No new dependencies, TS product edits, lockfile edits, push, merge, unsafe, or configuration access.

Workspace tests passed: **1,315 passed, 0 failed, 37 ignored**, 198 result summaries. No flaky rerun required. Full workspace clippy and fmt passed. New helper test passed. Final gate logs scanned for `FAILED|panicked|^error`; no matches in final gates. Expected red/failed compile logs retained, with matches disclosed above.

## Command exit evidence

Exact recorded exits follow (generated from `.exit` files). All cargo commands used `CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0`, offline and this worktree's target. Free disk checked before build/test batches (13 GiB); no cleanup performed.

- `cargo build --offline -p omni-gateway --bins` — exit `0` (quoted from `/tmp/opencode/c1/base-build.exit`; log `base-build.log`).

- `cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture` — exit `0` (quoted from `/tmp/opencode/c1/base-size.exit`; log `base-size.log`).

- `cargo test --offline -p omni-gateway --test screening` — exit `101` (quoted from `/tmp/opencode/c1/pure-red.exit`; log `pure-red.log`).

- `cargo test --offline -p omni-gateway --test screening` — exit `101` (quoted from `/tmp/opencode/c1/segments-red.exit`; log `segments-red.log`).

- `cargo test --offline -p omni-gateway --test screening` — exit `101` (quoted from `/tmp/opencode/c1/relabel-red.exit`; log `relabel-red.log`).

- `cargo test --offline -p omni-gateway --test screening` — exit `101` (quoted from `/tmp/opencode/c1/judged-red.exit`; log `judged-red.log`).

- `cargo test --offline -p omni-gateway --test screening -- --nocapture` — exit `101` (quoted from `/tmp/opencode/c1/segments-green-attempt1.exit`; log `segments-green-attempt1.log`).

- `cargo test --offline -p omni-gateway --test screening -- --nocapture` — exit `0` (quoted from `/tmp/opencode/c1/pure-final.exit`; log `pure-final.log`).

- `cargo test --offline --workspace` — exit `0` (quoted from `/tmp/opencode/c1/workspace.exit`; log `workspace.log`).

- `cargo clippy --offline --workspace --all-targets -- -D warnings` — exit `0` (quoted from `/tmp/opencode/c1/clippy.exit`; log `clippy.log`).

- `cargo fmt --all -- --check` — exit `0` (quoted from `/tmp/opencode/c1/fmt.exit`; log `fmt.log`).

- `cargo fmt --all -- --check` — exit `0` (quoted from `/tmp/opencode/c1/precommit-fmt.exit`; log `precommit-fmt.log`).

- `cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture` — exit `0` (quoted from `/tmp/opencode/c1/dispatch-size.exit`; log `dispatch-size.log`).

- `cargo build --offline -p omni-gateway --bins` — exit `0` (quoted from `/tmp/opencode/c1/final-build.exit`; log `final-build.log`).

## w- checkpoint — executable screening driver (C1 still incomplete)

Commit `de1dea4b` — `test(screening): add 102 oracle rows; 84 baseline red`. Clean worktree after commit. Only new `conformance/e2e/smart-router.ts` and `smart-router-ns.sh` changed. No Rust wiring changes: the fail-closed stub remains active. Stopping at the requested completed, committed **driver** step; next implementer must do effectful wiring, not mistake this checkpoint for C1 completion.

### w- driver contract / results

102 rows: 17 cases × three client surfaces × streaming/nonstreaming. Every row issues two identical requests in the same gateway process to test cache reuse, then terminates the process and reads all request-log rows. Cases: public, confidential, garbage, own timeout, upstream 500, settings off, already-local, >64 segments, smart unconfigured, independent guard allow/deny/garbage/timeout/500/unconfigured, combined public and combined local (guard uses the smart classifier). Checks client status/body/headers, every upstream raw header/request-body byte, all request-log columns except existing generated id/time/node masks, route selection/header, classifier rows, and cache-hit call absence. Ordinary corpus requests have one smart segment; concurrent worker racing, aggregation of multiple smart calls, disconnect, local-only revalidation/configuration mutation, truncation, non-ASCII surrogate prompt transport, per-key cache separation, and upstream captured bodies remain follow-up coverage. No new difference masks. Receipt-time normalization is essential: doing it after both full tables exceeded the mask's 120s timestamp window.

Ports selected after grep: gateway **18540**, custom stub **18541** (external OpenAI TLS stub is namespace-local 443). Wrapper enforces `/tmp/opencode/c1/w-*`, sets scrubbed PATH including Bun and `/usr/sbin`, enters loopback-only network/mount namespace, and maps only api.openai.com to loopback. Every CLI Bun invocation uses `--no-env-file`; gateway/CLI children have explicit environment and private HOME. Frozen OpenAI sends Responses upstream even for API-key requests; stub emits proper Responses events (not Chat Completions events). Classifiers/custom local use Chat Completions upstream.

- Final baseline red: **18 equal / 84 failing / 102 total**, frozen scenario invalid **0** (`w-red-5`).
- Frozen-vs-itself positive control: **102 equal / 0 failing**, frozen scenario invalid **0** (`w-self-2`).
- Post-commit binary: **18 equal / 84 failing / 102 total**, frozen scenario invalid **0** (`w-checkpoint`), as expected with stub unchanged. **No Rust green claimed.**
- Failed fixture attempts retained: `w-red-1` setup failed due to wrong credential auth spelling (`api_key`, corrected to frozen `apiKey`); `w-red-2` 12 invalid oracle scenarios because external stub used wrong event protocol; `w-red-3` zero invalid oracle but early rows failed time-window normalization; `w-red-4` correct 18/84 count, before strengthened scenario invariants. `w-self-1` was 102/0 before strengthened invariants. All logs/evidence preserved, no overwrites.

### w- verification / binary

All cargo commands offline, one at a time, with requested build environment and this worktree's target. Disk checked twice: 12 GiB available. Workspace **1,315 passed, 0 failed, 37 ignored**; no flaky rerun. Final gate logs scanned for `FAILED|panicked|^error`: no matches in workspace/clippy/fmt/build/dispatch-size. Dispatch state machine remains **3,400 bytes**, unchanged, ceiling 5,500.

Exit codes below are quoted from corresponding `.exit` files; each command and its exit are on one line. Baseline/positive-control drivers invoked using bash wrapper, so no provider traffic left loopback namespace.

- `cargo fmt --all -- --check` — exit `0` (`/tmp/opencode/c1/w-precommit-fmt.exit`; log `w-precommit-fmt.log`).
- `cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture` — exit `0` (`/tmp/opencode/c1/w-dispatch-size.exit`; log `w-dispatch-size.log`).
- `cargo build --offline -p omni-gateway --bins` — exit `0` (`/tmp/opencode/c1/w-build.exit`; log `w-build.log`; run after commit).
- `cargo test --offline --workspace` — exit `0` (`/tmp/opencode/c1/w-workspace.exit`; log `w-workspace.log`).
- `cargo clippy --offline --workspace --all-targets -- -D warnings` — exit `0` (`/tmp/opencode/c1/w-clippy.exit`; log `w-clippy.log`).
- `cargo fmt --all -- --check` — exit `0` (`/tmp/opencode/c1/w-fmt.exit`; log `w-fmt.log`).
- `bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/rust-base /tmp/opencode/c1/w-red-5` — exit `1` (`/tmp/opencode/c1/w-red-5.exit`; log `w-red-5.log`; 84 expected baseline red).
- `bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/a8/ts /tmp/opencode/c1/w-self-2` — exit `0` (`/tmp/opencode/c1/w-self-2.exit`; log `w-self-2.log`; 102 self-equal).
- `bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/w-rust-driver /tmp/opencode/c1/w-checkpoint` — exit `1` (`/tmp/opencode/c1/w-checkpoint.exit`; log `w-checkpoint.log`; 84 still-red).

Post-commit binary `/tmp/opencode/c1/w-rust-driver`, commit `de1dea4b`, SHA-256 **`c51277d203ebd8b5880c2fc42c62fd0856fd3c3a450046bcc23c228dea27443f`** (identical to pure predecessor, since no Rust edits).

### w- remains / unverified

All effectful smart-router/guardrail/cache ownership/cancellation/stream-deferred screening/logging/debits/header/relabel integration from predecessor remains. Dispatch currently lacks screening-call options (transforms off/localOnly) and server eagerly evaluates stub before SSE construction; do not simply await classification there, because frozen defers streaming screening until after heads. The surrogate-bearing judged JSON bridge warning remains. Full requested anthropic/openai/antigravity namespace regressions and default-namespace run.ts **not run at this driver-only checkpoint**; no admin-routes run, no provider processes outside namespace, no push/merge/dependencies/unsafe/product-TS/bun.lock/config changes. Next step: wire effects with red driver already committed, then reach 102 green, expand race/cancellation corpus, and run all remaining end gates.

## x- checkpoint — dispatch options (C1 incomplete)

Commit **`59a659eceedc150d6f580b82e1c7b44c1a953d20`**, `feat(screening): add dispatch options; 4 cases`. Only dispatch.rs and new tests/screening_dispatch.rs changed. Completed the dispatch-options step; stopped before effectful smart routing. Clean worktree after commit.

`dispatch_with_options` accepts explicit request_transforms/local_only/on_route options. Default dispatch preserves ordinary behavior. Local-only revalidates against dispatch's own snapshot before ranking/transport, returning frozen INTERNAL/fixed message. on_route:false suppresses pending/route writes (frozen deletes classifier callDeps.onRoute). Completed classifier rows remain caller responsibility. request_transforms is API support only: RTK/ponytail remain unported in this baseline, so neither true nor false currently transforms. Four tests: local success/no pending row, inferred external rejection, added external target rejection, ordinary pending row unchanged. Existing 31 dispatch tests pass. Dispatch concrete state machine **3,400 bytes**, ceiling unchanged 5,500.

**Streaming ordering NOT fixed**: server still eagerly invokes fail-closed stub. Next implementer must defer streaming screening until after heads while preserving nonstream HTTP errors. Smart routing, independent guardrail, cache ownership, cancellation/logging/debits, reroute/relabel/headers and surrogate-bearing judged-JSON bridging remain.

Post-commit binary `/tmp/opencode/c1/x-rust-options`, commit above, SHA-256 **`31f08b389f92c7bf3d19ccbd2ff66c780e6f025023c5027398c9fb0b59d47cfd`**. Both measured driver runs: **18 equal / 84 failing / 102 total / 0 oracle-invalid**, unchanged from stub baseline; no green claimed. Wrapper requires w-* scratch, so used w-x-options and w-x-options-repeat, logs/exits x-*. Gateway traffic confined to loopback namespace with driver explicit environments/private HOME.

### x- exits (read from corresponding .exit files)

Cargo offline, two jobs, incremental off, dev/test debug off, own target. Disk checked before builds: 12 GiB free. Final workspace **1,319 passed / 0 failed / 37 ignored**, 199 summaries. No known load-flake occurred. Final workspace/clippy/fmt/build/dispatch logs scanned for `FAILED|panicked|^error`, no matches. Failed attempts retained and disclosed:

- `cargo test --offline -p omni-gateway --test screening_dispatch` — exit `101` (`/tmp/opencode/c1/x-options-red.exit`): expected missing API compile red.
- `cargo test --offline -p omni-gateway --test screening_dispatch --test dispatch --test dispatch_size -- --nocapture` — exit `101` (`/tmp/opencode/c1/x-options-green.exit`): test moved String from Drop-bearing event; corrected to borrow.
- `cargo test --offline -p omni-gateway --test screening_dispatch --test dispatch --test dispatch_size -- --nocapture` — exit `0` (`/tmp/opencode/c1/x-options-green-2.exit`): 36 tests; dispatch 3,400 bytes.
- `cargo test --offline --workspace` — exit `101` (`/tmp/opencode/c1/x-workspace.exit`): scrubbed PATH accidentally omitted Bun; failed body_schema::tests::schemas_answer_as_frozen_ts_parse_or_throw, catalog::tests::generated_data_matches_frozen_ts_registry, http_oracle_tests::model_bodies_answer_as_frozen_ts_model_schema, http_oracle_tests::settings_bodies_answer_as_frozen_ts_put_settings with executable not found; corrected PATH, no product fix.
- `cargo test --offline --workspace` — exit `0` (`/tmp/opencode/c1/x-workspace-2.exit`).
- `cargo clippy --offline --workspace --all-targets -- -D warnings` — exit `101` (`/tmp/opencode/c1/x-clippy.exit`): explicit drop(log) test lint; replaced with lexical scope.
- `cargo clippy --offline --workspace --all-targets -- -D warnings` — exit `0` (`/tmp/opencode/c1/x-clippy-2.exit`).
- `cargo fmt --all -- --check` — exit `0` (`/tmp/opencode/c1/x-precommit-fmt.exit`; before commit).
- `cargo build --offline -p omni-gateway --bins` — exit `0` (`/tmp/opencode/c1/x-build.exit`; AFTER commit).
- `bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/x-rust-options /tmp/opencode/c1/w-x-options` — exit `1` (`/tmp/opencode/c1/x-driver.exit`; 84 expected stub failures).
- `bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/x-rust-options /tmp/opencode/c1/w-x-options-repeat` — exit `1` (`/tmp/opencode/c1/x-driver-repeat.exit`; same counts).
- `cargo test --offline --workspace` — exit `0` (`/tmp/opencode/c1/x-workspace-final.exit`; final post-commit).
- `cargo fmt --all -- --check` — exit `0` (`/tmp/opencode/c1/x-fmt.exit`; final).

### x- remaining / unverified

Remaining implementation: smart routing, guardrail, stub replacement, then green driver and full end gates. Anthropic/OpenAI/Antigravity/refresh-transport and default-namespace run.ts NOT run at this partial checkpoint. One pgrep check found active X3 x3-operator.py; no default-namespace driver launched. Audit wrappers before use: anthropic-ns.sh/openai-ns.sh invoke bare bun; anthropic.ts also spawns bare Bun CLI, requiring safe adaptation for --no-env-file. No independent review yet. No admin-routes run, dependencies, TS product/bun.lock edits, unsafe, config access, push or merge.

## s- checkpoint — smart routing (guardrail incomplete)

Commits (append-only): `c9030ec33d7cd7f939d0df33a376e0b33e79634d` (`feat(screening): smart routing core; 2 cases`), `795c490956fdf419edf717a4d24ead362171a46a` (`feat(screening): defer smart screen; 3 cases`), `0713b6f995e189e49a74955c00b2a7928a3dd84f` (`fix(screening): account classifier failures; 5 cases`). Clean worktree. Only screening.rs, server.rs, tests changed. No dependencies, product TS, bun.lock, unsafe, config access, push, merge, or regression drivers.

Implemented local-only configuration validation before already-local bypass; process-local shared bounded whole-verdict cache; >64 uncached segments local bypass; up to four classifier futures; transforms off/local_only/on_route:false dispatch options; per-call deadlines; stop/drop sibling calls on confidential/failure; one aggregate row including all started calls' observed tokens/cost, target from first routed call in call order. An RAII aggregate writes 499/interrupted on disconnect and releases child streams. Local dispatch revalidates locality; rerouted start events name the local model while parent requested_model remains the client's. Parent rows carry routing notes. The server registers classifier model rate-limit overrides; existing writer completion notifications provide debits. Four new core tests plus the existing server stub assertion updated to assert the now-correct already-local success (five cases).

### Streaming ordering

`screen_first` returns an unpolled lazy event stream and a mutable parent log, not an awaited classification. SSE construction sends HTTP 200 with frozen SSE headers before that stream performs screening; the existing SSE body provides keepalives while classification waits. Refusals become in-stream error events, never an HTTP refusal after heads. Nonstream consumers drain the same stream before rendering, so refusals have the frozen HTTP error status/body; successful judged nonstream answers alone receive `x-omni-route: local|external`. Streaming does not get that header. Disconnect drops the classification futures and aggregate owner; the ordinary parent Finisher remains responsible for its own 499 row. Guardrail-only keys intentionally retain the old stub path/order.

### Differential counts and binaries

102 rows = **54 smart-only** (including enabled-off), **36 guardrail-only**, **12 combined**. Final smart-only **54/54 equal**; guardrail-only **6/36 equal**; combined **0/12 equal**. Total **60 equal / 42 failing / 102 / 0 oracle-invalid**. All five compared columns agree for every smart-only row. Core (not yet wired) post-commit driver: 18 equal / 84 failing. Wiring and final post-commit drivers: 60 equal / 42 failing. All traffic in wrapper loopback namespaces, scratch w-s-*; explicit environments, private HOME, Bun --no-env-file.

- `/tmp/opencode/c1/s-rust-core`, commit c9030ec33d7cd7f939d0df33a376e0b33e79634d, SHA256 `ab79594242992d1d83ed1b792ba28eae7d1bf2d1f55325944c449238d09aa511`.
- `/tmp/opencode/c1/s-rust-wiring`, commit 795c490956fdf419edf717a4d24ead362171a46a, SHA256 `4c5ecfc480a48b6160430634819de1cb62e4b7f3c621a56b703ba002a7774cd5`.
- `/tmp/opencode/c1/s-rust-final`, commit 0713b6f995e189e49a74955c00b2a7928a3dd84f, SHA256 `74c5ee88d6c036cb9c7f905ddd4bd57622e960feb94bcd3e9e831f82dca87f45`.

### s- gates (exit values read from .exit files)

All cargo commands offline, own target, jobs=2, incremental=0, dev/test debug=0, CARGO_HOME=/home/homebrew/.cargo, private HOME. Disk checked before builds, 11 GiB free throughout. Final workspace **1,323 passed / 0 failed / 37 ignored**, 200 summaries. Dispatch concrete state **3,400 bytes**, ceiling unchanged 5,500. No known load-flake occurred.

- `cargo build --offline -p omni-gateway --bins` — exit `0` (`s-core-build.exit`, `s-wiring-build.exit`, `s-final-build.exit`; each after its commit).
- `cargo test --offline --workspace` — exit `0` (`s-workspace-5.exit`, `s-final-workspace.exit`).
- `cargo clippy --offline --workspace --all-targets -- -D warnings` — exit `0` (`s-clippy.exit`, `s-clippy-2.exit`, `s-final-clippy.exit`).
- `cargo fmt --all -- --check` — exit `0` (`s-wiring-fmt.exit`, `s-fmt.exit`, `s-final-precommit-fmt.exit`, `s-final-fmt.exit`).
- `cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture` — exit `0` (`s-dispatch-size.exit`), bytes=3400.
- `bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/s-rust-core /tmp/opencode/c1/w-s-core-2` — exit `1` (`s-core-driver-2.exit`; 84 failures before wiring).
- `bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/s-rust-wiring /tmp/opencode/c1/w-s-wiring` — exit `1` (`s-wiring-driver.exit`; guardrail/combined only, 42 failures).
- `bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/s-rust-final /tmp/opencode/c1/w-s-final` — exit `1` (`s-final-driver.exit`; guardrail/combined only, 42 failures).

Failed attempts retained:
- `cargo check --offline -p omni-gateway` — exit `101` (`s-core-check.exit`: private HOME initially hid cargo registry; supplied explicit CARGO_HOME), exit `101` (`s-core-check-2.exit`: missing uuid dependency reference, f64 timeout type, nonserializable collected response; fixed without dependencies).
- `cargo test --offline -p omni-gateway --test smart_routing` — exit `101` (`s-core-tests.exit`: StopReason serialization); exit `0` (`s-core-tests-2.exit`: two tests).
- `cargo fmt --all -- --check` — exit `1` (`s-core-fmt.exit`). **Process deviation:** core commit was made despite this formatting-only failure; formatting corrected in wiring commit, whose precommit and all final fmt checks pass. No history rewritten.
- `bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/s-rust-core /tmp/opencode/c1/w-s-core` — exit `1` (`s-core-driver.exit`): initial binary copy used wrong executable name, missing binary; corrected to target/debug/omnigateway and reran with fresh scratch. Original binary metadata attempt s-core-binary.txt preserved; correct metadata is s-core-binary-2.txt.
- `cargo test --offline -p omni-gateway --test smart_routing --test dispatch_size` — exit `0` (`s-wiring-tests.exit`).
- `cargo test --offline --workspace` — exit `101` (`s-workspace.exit`: obsolete fail-closed-stub server expectation); exit `101` (`s-workspace-2.exit`: corrected success expectation still expected null credential instead of c0); exit `101` (`s-workspace-3.exit`: new classifier test omitted request-ID RNG init); exit `101` (`s-workspace-4.exit`: new mock answered JSON though adapter forces SSE). These were fixture/assertion updates, not load-flakes. All corrected; final workspace passes.

### Remaining for guardrail / unverified

Implement judge effects/cache/logging and combine it with smart outcome (local requests must use the validated local classifier). Combined keys currently perform smart routing then fail closed via guardrail stub, not a real judge. Guardrail-only keys retain stub, including eager streaming ordering: fix that in the guardrail session. Run final C1 regression drivers then. Expanded concurrent finish-vs-stop/disconnect/cache-expiry/snapshot-race differential fixtures are still unverified; current driver has one segment per normal request and an oversize bypass, not a multi-call race corpus. No unavoidable oracle difference identified. Frozen `collect` defaults stopReason=endTurn, so no extra terminal-event requirement was imposed beyond the frozen parsing contract.

## g- checkpoint — guardrail judge

Commits (append-only): `4d9b5ce68147cf43120377a6de2953f7494c95c1` (`feat(screening): policy judge; 2 cases`), `82617fe3c64d030582266f88edd684aa29100543` (`fix(screening): preserve capped UTF-16; 2 cases`). Each precommit fmt check passed. Both binaries built after their commits; metadata in g-binary.txt and g-final-binary.txt. Changes confined to screening.rs, dispatch.rs (removed obsolete screen stub), server.rs call site, and tests. No dependencies, TS product/bun.lock changes, unsafe, push, merge, config access, or admin-routes run.

### g- design and combination

The policy judge dispatches independently with request transforms off, on_route false, and local_only only when smart routing selected a local outcome. A dedicated RAII row preserves dispatch target, attempts, tokens and cost, attributes it to the parent key, appends guardrail:classifier, logs 499 on disconnect, and corrects a gateway deadline to 504/TIMEOUT. No classifier admission or body capture. Server records classifier overrides for the completion/debit path. A separate process-local bounded LRU shares the pure frozen guardrail key (API-key identity, policy, model, capped system/human/tool results); 10,000 entries, fixed one-hour insertion TTL, hits update recency only, both verdicts cached, failures never cached.

Unconfigured refuses 500/INTERNAL; deny 400/CONTENT_FILTER; garbage, deadline and upstream failure 502/UPSTREAM, with fixed frozen messages and allowed/denied/unavailable/unconfigured/truncated notes. The existing pure extraction and fencing form the judge prompt. Pair-bisecting caps remain UTF-16 in the key; a per-call, collision-free marker transport restores lone-surrogate JSON escapes after ordinary provider encoding, avoiding both a serde panic and U+FFFD wire substitution. A unit test pins this wire case.

Smart routing runs first. Its refusal prevents the judge. A public outcome runs the configured guardrail model; a local or already-local outcome uses the exact local classifier validated by the smart check, not guardrailModel. The judge examines the original client request before local model relabeling. Its refusal wins after smart notes; success preserves both sets of notes and the smart route. Ordinary combined public/local cases write two classifier rows (one smart aggregate, one guardrail row); cached verdicts write none. Guardrail-only and combined screening now share lazy screen_first: SSE 200 heads/keepalives before classification, stream error after heads; nonstream drains before rendering. Smart-only response route-header behavior unchanged.

### g- differential counts and binaries

After 4d9b5ce6: **102/102 equal**, **54/54 smart-only**, **36/36 guardrail-only**, **12/12 combined**, 0 oracle-invalid (`g-driver.log`, repeated `g-driver-repeat.log`). Five compared columns agree. Binary `/tmp/opencode/c1/g-rust-judge`, SHA256 `f7d34dd0d49240f436928bc78261c13602bd7e64d5cf2b809bde42a1497e017e`, commit 4d9b5ce68147cf43120377a6de2953f7494c95c1.

Final binary `/tmp/opencode/c1/g-rust-final`, SHA256 `022e08ad5bbf351efe15d24c94dbebe3b43f33c577922ce5e6bf066c7698abff`, commit 82617fe3c64d030582266f88edd684aa29100543.

### g- gate setup and retained attempts

Explicit scrubbed environments, private HOME=/tmp/opencode/c1/g-home; Cargo offline, CARGO_HOME=/home/homebrew/.cargo, jobs=2, incremental=0, dev/test debug=0, own target, one cargo command at a time. Disk checks before builds: 10 GiB / 9.7 GiB, above 5 GiB stop threshold. Provider traffic confined to loopback namespaces. Anthropic/openai wrappers inspected: bare bun, so PATH begins /tmp/opencode/b4/reg/bin (verified wrapper adds --no-env-file). Namespace smart wrapper sets its own safe PATH and explicitly adds --no-env-file. No competing run.ts found (pgrep matched only the command's own shell); general e2e additionally ran inside an isolated loopback namespace with the same fixed ports. No output overwritten.

Retained failed attempts: g-tests.exit=101 (initial scrubbed PATH omitted Bun, pure screening test could not spawn it; corrected PATH, g-tests-2.exit=0). g-workspace.exit=101 (obsolete stub-only server assertion expected no classifier row; updated assertion and test name, g-tests-3.exit=0). Not a known load flake. g-clippy.exit, g-clippy-2.exit, g-fmt.exit, g-size.exit all 0; state machine 3400 bytes, ceiling 5500 unchanged. g-tests-4.exit=0 (three judge tests, including capped-surrogate wire); existing pure, dispatch and smart tests also pass in g-tests-2.log.

Remaining coverage limits inherited from s-: current differential corpus uses one smart segment per ordinary call plus oversize bypass, not multi-call finish-vs-stop races, disconnect during classifier, cache-expiry clock advancement, or concurrent snapshot mutation. Judge cancellation and timeout ownership are implemented, but these expanded differential race fixtures are not claimed verified. No unavoidable frozen difference identified.

### g- recorded command exits (read from .exit files)

- `cargo fmt --all -- --check (before 4d9b5ce6)` — exit `0` (`g-precommit-fmt.exit`).
- `cargo fmt --all -- --check (before 82617fe3)` — exit `0` (`g-precommit-fmt-2.exit`).
- `cargo build --offline -p omni-gateway --bins (after 4d9b5ce6)` — exit `0` (`g-build.exit`).
- `cargo build --offline -p omni-gateway --bins (after 82617fe3)` — exit `0` (`g-final-build.exit`).
- `bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-judge /tmp/opencode/c1/w-g-judge` — exit `0` (`g-driver.exit`).
- `bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-judge /tmp/opencode/c1/w-g-judge-repeat` — exit `0` (`g-driver-repeat.exit`).
- `unshare -Urn bash -c 'ip link set lo up; bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/c1/g-rust-final'` — exit `0` (`g-final-e2e.exit`).

Initial-commit regression drivers: anthropic 30 cases / 0 failed; OpenAI 56 rows / 0 failed; antigravity 45/45 equal; refresh transport 9/9 equal. Final-commit runs recorded below separately.

Frozen oracle binary reverified: `/tmp/opencode/a8/ts` SHA256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`. General e2e final binary: all client/upstream/scenario and stored-row comparisons equal (37 request_logs, 18 usage_daily, 6 usage_rollup, 4 credential_health rows); `g-final-e2e.log`.

Retained attempt command exits, quoted from their files:

- `cargo test --offline -p omni-gateway --test smart_routing --test screening --test screening_dispatch` — exit `101` (`g-tests.exit`).
- `cargo test --offline -p omni-gateway --test guardrail --test smart_routing --test screening --test screening_dispatch` — exit `0` (`g-tests-2.exit`).
- `cargo test --offline --workspace (first judge commit; obsolete fixture assertion)` — exit `101` (`g-workspace.exit`).
- `cargo test --offline -p omni-gateway --test guardrail --test server` — exit `0` (`g-tests-3.exit`).
- `cargo test --offline -p omni-gateway --test guardrail` — exit `0` (`g-tests-4.exit`).
- `cargo clippy --offline --workspace --all-targets -- -D warnings (first judge commit)` — exit `0` (`g-clippy.exit`).
- `cargo clippy --offline -p omni-gateway --all-targets -- -D warnings` — exit `0` (`g-clippy-2.exit`).
- `cargo fmt --all -- --check (first judge commit)` — exit `0` (`g-fmt.exit`).
- `cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture (first judge commit)` — exit `0` (`g-size.exit`).

Final committed diff saved as `/tmp/opencode/c1/g-final.diff`; clean worktree verified after commits.

Initial-commit regression commands (additional to final-commit gates):

- `bash conformance/e2e/anthropic-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-judge /tmp/opencode/c1/g-anthropic` — exit `0` (`g-anthropic.exit`).
- `bash conformance/e2e/openai-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-judge /tmp/opencode/c1/g-openai` — exit `0` (`g-openai.exit`).
- `bash conformance/e2e/antigravity-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-judge /tmp/opencode/b4/e2e/c1-g` — exit `0` (`g-antigravity.exit`).
- `bash conformance/e2e/refresh-transport-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-judge /tmp/opencode/c1/g-refresh` — exit `0` (`g-refresh.exit`).

### g- final Cargo gates

- `cargo test --offline --workspace` — exit `0` (`g-final-workspace.exit`).
- `cargo clippy --offline --workspace --all-targets -- -D warnings` — exit `0` (`g-final-clippy.exit`).
- `cargo fmt --all -- --check` — exit `0` (`g-final-fmt.exit`).
- `cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture` — exit `0` (`g-final-size.exit`).

Workspace: 1326 passed / 0 failed / 37 ignored, 201 summaries. No listed load-flake occurred and no standalone flake rerun was needed. Dispatch concrete state remains **3400 bytes / 5500 ceiling**.

Combined-row extraction from completed first-commit differential stored rows (`g-combined-summary.txt`): each guard-allow/guard-deny case writes 3 rows across the two identical requests (2 parents + 1 cached judge); both-public/both-local write 4 (2 parents + smart aggregate + judge, both checks cached on request two). Parent notes exactly `[smart-router:public, guardrail:allowed]` or `[smart-router:local, guardrail:allowed]`.

### g- final smart-router gates

- `bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/w-g-final` — exit `0` (`g-final-driver.exit`); {"equal":102,"failed":0,"total":102,"oracleInvalid":0}; by class {'smart-only': [54, 54], 'guardrail-only': [36, 36], 'combined': [12, 12]}.
- `bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/w-g-final-repeat` — exit `0` (`g-final-driver-repeat.exit`); {"equal":102,"failed":0,"total":102,"oracleInvalid":0}; by class {'smart-only': [54, 54], 'guardrail-only': [36, 36], 'combined': [12, 12]}.

`git diff --check 0713b6f9..HEAD` — exit `0` (`g-diff-check.exit`); `g-worktree-status.txt` empty. Final binary SHA256 rechecked in `g-final-sha256-verified.txt`, matches g-final-binary.txt.

Scope confirmation: branch `feat/rust-smart-router`, final HEAD `82617fe3c64d030582266f88edd684aa29100543`; no edits outside requested Rust modules/tests within the checkout. All evidence/report writes used /tmp/opencode/c1/g-* (driver work scratch w-g-*; antigravity-required /tmp/opencode/b4/e2e/c1-g*). No broad cleanup or deletes performed.

### g- final regression gates — completed

- `bash conformance/e2e/anthropic-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/g-final-anthropic` — exit `0` (`g-final-anthropic.exit`).
- `bash conformance/e2e/openai-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/g-final-openai` — exit `0` (`g-final-openai.exit`).
- `bash conformance/e2e/antigravity-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/b4/e2e/c1-g-final` — exit `0` (`g-final-antigravity.exit`).
- `bash conformance/e2e/refresh-transport-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/g-rust-final /tmp/opencode/c1/g-final-refresh` — exit `0` (`g-final-refresh.exit`).

Final binary regressions: anthropic **30 cases / 0 failed**; OpenAI **56 rows / 0 failed**; antigravity **45/45 equal**; refresh transport **9/9 equal**. All final requested gates completed successfully, including general e2e and smart-router twice. Failed earlier attempts remain documented above. Final binary/commit unchanged.

## f — round 1 review fixes

Commits (append-only): 9531d0d8 (1/4 aliases), a8ea6fc9 (2/4 guard pending), 473d50fe (3/4 stopped siblings), 399065bd (4/4 combined snapshot), 63daba4c (5/5 lifecycle/safety follow-up).

Alias red 0/6 -> green 6/6; post-commit drivers 1–4 each 102/102. Guard pending adds ordinary dispatch Begin/Route with parent key and one JudgeRow Finish owner, including cancellation. Begin uses the writer node_id and state=pending; A11 own/dead-node sweep therefore retires it identically to other pending requests. Committed failover/cancel test checks c1 route update, parent attribution, sweep eligibility and single stored 499 completion. Committed driver retains 102 cases and now reads a guard-only in-flight judge row with explicit non-vacuity assertions.

Pending reproduction harness defect discovered: reviewer pending.ts schedules a second-round 700ms read on a cache hit, never clears/awaits it, and captures mutable pending by reference. TS startup timing can let this timer append a completed-row snapshot while Rust has already serialized its rows. Original copy retained and rerun; f-pending-corrected.ts restricts this probe to the first (cache-miss) request, preserving the decisive pending read. Corrected post-2 run 1/1, original post-2 run 0/1 solely from the extra completed-row snapshot; final rows and first pending snapshot equal. The committed driver clears its timer and only samples round 0.

Stopped workers receive a shared watch stop and are drained, preferring complete ready replies over stop; unpolled workers cannot start after stop. A barrier-controlled scripted transport test verifies two ready replies (confidential plus public) both contribute usage, and the public sibling is cached for a later request. No wall-clock timers in this test. Black-box race probes still expose independent readiness/scheduling differences and are NOT claimed equivalent: post-3 race 4/12 and repeat 1/12; post-4 race-repeat 2/12. Final measurements follow below.

Combined public outcomes pass the pre-screen captured guardrail model (including explicit null); local outcomes retain the validated smart classifier. Guard-only calls retain judge-time selection, as frozen does.

Safety: explicit scrubbed environments/private HOME, no .env, no TS product/bun.lock edits or new dependencies. Provider probes in isolated loopback namespaces. Added --no-env-file to Anthropic/OpenAI harness child CLI calls. Prior failed attempts retained. First gate runner hit its 1200s overall timeout during refresh-transport; rerun has 2400s. Initial workspace passed; initial clippy caught must-use Result, fixed in 63daba4c. Initial fmt raced additional test edits; subsequent precommit fmt passed.

Final binary: /tmp/opencode/c1/f-rust-5, commit 63daba4c; sha256 65650147bb8d938b3ea0d48dc7a9088ed4eec441f3b2bfe3e3a3d19fc2371ef7.

The targeted follow-up tests passed 4 guardrail + 5 smart-router tests. The guardrail failover test uses 503 then a hanging c1 transport, reads the updated pending row, verifies A11 sweep recognition, then drops the judge and verifies exactly one done 499 row. The barrier test puts public first and confidential second, forcing a confidential completion while the public sibling remains queued ready. An extra pre-poll stop check prevents lazy, never-started pool entries from launching transports while draining.

Anthropic authoritative contained rerun uses f-anthropic-contained-ns.sh (a copied harness with absolute imports and scratch under /tmp/opencode/b4/e2e/c1-f) and passed 30/30. The original harness ignores its wrapper scratch for databases, so earlier Anthropic attempts used its inherited /tmp/opencode/anthropic-e2e-* location; no secrets or real HOME were used. Frozen apps/, packages/, and bun.lock diff against 1780bb39 is recorded in f-frozen-source-diff.txt.


## c- continuation — STOP: race unresolved, concurrent writer

Waited for PID 2755541 using the prescribed single blocking command before any files/Cargo. Initial HEAD 399065bd. No c- commit created. Another session unexpectedly committed all five dirty files as 63daba4c and launched f-verified-gates.sh (observed parent PID 2815803, Cargo PID 2815820). Stopped immediately on discovery; worktree clean. No push/merge/dependency/TS product/bun.lock changes.

### Race diagnosis

f-final-race-repeat: all client and upstream columns equal. Stored usage differs on 10/12. TS always attempts=4/input=20/output=6/cost=.000032; Rust=40/12/.000064 except matching rows 2 and 6. f-final-race: 5/12 equal. Nonstream confidential/4 TS=20/6, Rust=40/12; nonstream 5xx/4 TS first=10/3, retry attempts=3; Rust first=30/9, retry attempts=1. Extra completed siblings change caching as well as usage. f-race-3=4/12 and f-race-repeat-3=1/12; reviewer pre-fix=11/12 and 12/12.

Frozen check.ts parses a whole received verdict before checking stop and awaits Promise.all workers. Rust biased select polls transport before stop: available-to-poll is not necessarily already-received in frozen fetch. No speculative behavior change or new difference class added. Cannot establish deterministic equivalent of network scheduling; STOP ruling applies.

Readiness-controlled oracle: c-ready.test.ts is frozen harness copied outside checkout, absolute imports, shared promise gate releases PUBLIC and CONFIDENTIAL after both adapter sends enter (no wall clock). Frozen caches both, attempts=2/input=80/output=2 (40/1 each). Rust barrier test stopped_ready_sibling_is_counted_and_cached caches public and logs attempts=2/input=20/output=8 (10/4 each). Both pass; this proves whole-reply behavior, not network scheduling equality. Frozen check.ts and dispatch/index.ts have no diff against 1780bb39. Initial oracle import-resolution failure retained in c-ready.log/.exit; corrected absolute imports pass c-ready-2.log/.exit.

### Pending correction and dirty-edit fates

f-pending-corrected.ts only schedules the 700ms snapshot on round zero instead of both rounds. Raw f-final-pending first snapshots MATCH {requested_model:judge,status:0,api_key_id:parent key}. TS additionally serializes a completed-row second snapshot; Rust serializes before that timer. Second request is cached and finishes before 700ms. Removing this unrelated late timer is legitimate for decisive pending-3 expectation; original probe unchanged.

- anthropic.ts/openai.ts --no-env-file additions retained: pure CLI test safety; f-final-anthropic 30/0 failed, openai 56/0 failed. Separate commit attempted but private HOME lacked git identity; concurrent session then committed them mixed in 63daba4c. No amend/revert.
- guardrail.rs retained/formatted/verified: pending failover credential c1/model m1/status0/parent key; A11 sweep sees row; cancellation final one done 499 row.
- smart_routing.rs retained: PUBLIC first, CONFIDENTIAL second lets barrier's second entrant release confidential first, making public genuinely a stopped sibling. Cache-hit key unchanged.
- screening.rs explicit drop(stop.changed().await) retained: behavior-neutral must-use lint fix. Concurrent commit also adds comments.

### Predecessor f- measurements

Binary f-rust-4 SHA256 5c60212cdf980c65303752abf84e20195e3671dd66c52b9595d54c8c5bd019fd, commit 399065bd.

- cargo test --offline --workspace — exit 0 (f-final-workspace.exit)
- cargo clippy --offline --workspace --all-targets -- -D warnings — exit 101 (f-final-clippy.exit; must-use watch result)
- cargo fmt --all -- --check — exit 1 (f-final-fmt.exit)
- cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture — exit 0 (f-final-size.exit), 3400 bytes
- bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/f-rust-4 /tmp/opencode/c1/w-f-driver-4 — exit 0 (f-driver-4.exit), 102/102
- bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/f-rust-4 /tmp/opencode/c1/w-f-driver-4-repeat — exit 0 (f-driver-4-repeat.exit), 102/102
- bash /tmp/opencode/c1/f-alias-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/f-rust-4 /tmp/opencode/c1/w-f-final-alias — exit 0 (f-final-alias.exit), 6/6
- bash /tmp/opencode/c1/f-pending-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/f-rust-4 /tmp/opencode/c1/w-f-final-pending — exit 1 (f-final-pending.exit), 0/1, decisive first snapshot equal
- bash /tmp/opencode/c1/f-pending-corrected-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/f-rust-4 /tmp/opencode/c1/w-f-final-pending-corrected — exit 0 (f-final-pending-corrected.exit), 1/1
- bash /tmp/opencode/c1/f-race-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/f-rust-4 /tmp/opencode/c1/w-f-final-race — exit 1 (f-final-race.exit), 5/12
- bash /tmp/opencode/c1/f-race-repeat-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/f-rust-4 /tmp/opencode/c1/w-f-final-race-repeat — exit 1 (f-final-race-repeat.exit), 2/12
- bash /tmp/opencode/c1/f-probes4-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/f-rust-4 /tmp/opencode/c1/w-f-final-probes4 — exit 0 (f-final-probes4.exit), 60/60
- bash /tmp/opencode/c1/f-anthropic-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/f-rust-4 /tmp/opencode/b4/e2e/c1-f/anthropic — exit 0 (f-final-anthropic.exit)
- bash /tmp/opencode/c1/f-openai-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/f-rust-4 /tmp/opencode/b4/e2e/c1-f/openai — exit 0 (f-final-openai.exit)
- bash /tmp/opencode/c1/f-antigravity-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/f-rust-4 /tmp/opencode/b4/e2e/c1-f/antigravity — exit 0 (f-final-antigravity.exit), 45/45
- Original refresh-transport and run.ts have no final .exit; not claimed passing.

### c- commands (quoted .exit lines)

- cargo fmt --all -- --check — exit 0 (c-fmt.exit)
- cargo test --offline -p omni-gateway --test guardrail --test smart_routing — exit 0 (c-focused.exit), 4+5 passed
- bun --no-env-file test /tmp/opencode/c1/c-ready.test.ts -t controlled-simultaneous (loopback namespace) — exit 1 (c-ready.exit; module resolution)
- bun --no-env-file test /tmp/opencode/c1/c-ready.test.ts -t controlled-simultaneous (loopback namespace) — exit 0 (c-ready-2.exit)
- cargo fmt --all -- --check — exit 0 (c-safety-fmt.exit)
- cargo build --offline -p omni-gateway — exit 0 (c-safety-build.exit; preceding commit failed, not a c-commit artifact)
- cargo fmt --all -- --check — exit 0 (c-safety-fmt-2.exit; following commit found clean tree due to concurrent writer)

Observed f-rust-5 SHA256 65650147bb8d938b3ea0d48dc7a9088ed4eec441f3b2bfe3e3a3d19fc2371ef7 at concurrent HEAD 63daba4c; association not independently rebuilt here. Remaining: race blocker; separate safety commit requirement; all final c-prefix gates on final committed binary. No completion claim.

## r- restoration and final C1 gates

Commit `41796e6ffd6032fe218227219b6e965430a8fc5b` — `revert(router): drop undecided siblings at decision (race 11/12, repeat 12/12)`.
One append-only commit, clean worktree; no push/merge/dependencies/TS product/bun.lock changes. Commit message counts were confirmed by the binary built AFTER this commit (no amend). Only this worktree was used for execution; private HOME, explicit Cargo environment, offline builds, two jobs, no incremental/debug info. All provider probes used loopback-only namespaces; copied verified wrappers ensure --no-env-file on Bun invocations. No admin-routes. Disk before builds remained above 5 GiB (last 5.9 GiB); nothing deleted.

### Change and equivalence

Hand-restored pre-473d50fe sibling handling. The pending/decision block and classify function through EOF are byte-identical to 82617fe3 (`r-sibling-equivalence.txt`). Focused diff `r-screening-vs-82617fe3.diff` contains only the retained guardrail lifecycle, settings snapshot, and alias changes. The watch-specific must-use fix/stop-unstarted guard disappears with the watch mechanism itself; no replacement stop receiver remains to lint. Other 63daba4c changes remain intact.

Converted, not deleted, readiness test to `stopped_ready_sibling_is_dropped_without_caching`: ready undecided PUBLIC is not cached, retry invokes the classifier, usage is 10/4 rather than 20/8. Comment explicitly identifies frozen's difference. `docs/smart-router-compatibility.md` records scheduling-dependent aggregate attempts/tokens/cost/cache warmth. Focused tests 5/5.

### Artifact and measured counts

Binary `/tmp/opencode/c1/r-rust`, SHA256 `96b50dfd38f9ca3e297fd389b9a325699a164d7c3f5074cabb3ea6a5b69ed14a`, built after commit `41796e6ffd6032fe218227219b6e965430a8fc5b` (`r-binary.txt`).

Race **11/12**, race-repeat **12/12**, so the controller's stop threshold was not triggered. Race exits 1 intentionally because it requires 12/12. Remaining differing row `race/false/5xx/6`: client, stored rows, oracle and scenario equal; upstream differs on retry (TS sends 1 classifier request, Rust 4; first round both 4 identical). Full rows retained in `w-r-race/{ts,rust}.rows.json`, compact breakdown in `r-race-difference.txt`. This retry-request discrepancy is disclosed separately: it is NOT claimed covered by the narrow documented same-check usage-only difference.

Smart-router twice **102/102**; alias **6/6**; corrected pending **1/1**; probes4 **60/60**. Anthropic **30/30**, OpenAI **56/56**, Antigravity **45/45**, refresh transport **9/9**, run.ts all rows equal. dispatch_size **3400 bytes**.

Workspace, clippy -D warnings, fmt all pass. Workspace passed first attempt alone; no flaky rerun needed. All three named flaky tests appear as `ok` in r-workspace.log. No failed attempts removed (r-race.log/.exit retained).

### Commands and exits (verbatim from .exit files)

- `cargo fmt --all -- --check — exit 0` (`r-fmt-pre.exit`, log alongside)
- `cargo test --offline -p omni-gateway --test smart_routing — exit 0` (`r-focused.exit`, log alongside)
- `cargo build --offline -p omni-gateway — exit 0` (`r-build.exit`, log alongside)
- `bash /tmp/opencode/c1/f-race-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-r-race — exit 1` (`r-race.exit`, log alongside)
- `bash /tmp/opencode/c1/f-race-repeat-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-r-race-repeat — exit 0` (`r-race-repeat.exit`, log alongside)
- `cargo test --offline --workspace — exit 0` (`r-workspace.exit`, log alongside)
- `cargo clippy --offline --workspace --all-targets -- -D warnings — exit 0` (`r-clippy.exit`, log alongside)
- `cargo fmt --all -- --check — exit 0` (`r-fmt.exit`, log alongside)
- `cargo test --offline -p omni-gateway --test dispatch_size -- --nocapture — exit 0` (`r-size.exit`, log alongside)
- `bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-r-driver — exit 0` (`r-driver.exit`, log alongside)
- `bash conformance/e2e/smart-router-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-r-driver-repeat — exit 0` (`r-driver-repeat.exit`, log alongside)
- `bash /tmp/opencode/c1/f-alias-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-r-alias — exit 0` (`r-alias.exit`, log alongside)
- `bash /tmp/opencode/c1/f-pending-corrected-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-r-pending — exit 0` (`r-pending.exit`, log alongside)
- `bash /tmp/opencode/c1/f-probes4-verified-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-r-probes4 — exit 0` (`r-probes4.exit`, log alongside)
- `bash /tmp/opencode/c1/f-anthropic-verified-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/b4/e2e/c1-r/anthropic — exit 0` (`r-anthropic.exit`, log alongside)
- `bash /tmp/opencode/c1/f-openai-verified-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/b4/e2e/c1-r/openai — exit 0` (`r-openai.exit`, log alongside)
- `bash /tmp/opencode/c1/f-antigravity-verified-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/b4/e2e/c1-r/antigravity — exit 0` (`r-antigravity.exit`, log alongside)
- `bash conformance/e2e/refresh-transport-ns.sh /tmp/opencode/a8/ts /tmp/opencode/c1/r-rust /tmp/opencode/c1/w-r-refresh-transport — exit 0` (`r-refresh-transport.exit`, log alongside)
- `unshare -Urn bash -c ip link set lo up; bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/c1/r-rust — exit 0` (`r-run.exit`, log alongside)
