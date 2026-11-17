# X3 checkpoint: remeasurement and committed RED corpus

Stopped at the completed, committed first step. No product fixes attempted. Next implementer should continue from `d280b15d` on `fix/x3-operator-cells` in `/home/homebrew/.local/share/opencode/worktree/1600a1/rust-cli`.

## Commit and corpus

- `d280b15d` (`test(e2e): add red X3 operator-cell corpus`): adds only `conformance/e2e/x3-operator.py` (241 lines).
- Committed driver: 2,995 pairs; 2,697 equal; 188 unexpected failures; exactly 95 accepted routing/auth-strict differences and 15 accepted `/v1/models` frozen-JSON failures.
- Final committed RED evidence: `/tmp/opencode/x3/operator-uzjowln9/{results,summary}.json`, with full response bytes (hex), content types, statuses, typed per-cell mutation states, private gateway logs.
- Unexpected statuses: 167 frozen-200/Rust-500, 10 frozen-400/Rust-500, 6 both-200 payload differences, 5 frozen-500/Rust-200. The five frozen-only **admin** refusals remain unexpected, not CLI exemptions.
- Includes all existing-route matrix cases, mutations, supplemental new-model and last-used cases, two shipped-schema confirmations, and two healthy-client quota cases with an unrelated corrupt credential. No removed route gaps are accepted by the driver.
- Uses fresh paired DB copies, fixed 19500/19501, explicit private HOME/config/env; frozen compiled binary invoked with `--no-env-file`. No external provider requests.
- Existing JSON order/volatile masks retained. Mutation updated_at/revoked_at clocks are masked while preserving SQLite class. Seed node heartbeat removed before DB cloning so expiry cannot change node-array length during this long run.
- Initial driver attempt had 225 failures due to revocation clocks; rerun had 189 due to seed-node expiry; corrected rerun and post-commit rebuild run both have 188. All attempts retained. No accepted-class count changed.

## Remeasurement vs original

Copied `/tmp/opencode/x3-probe/*.py` to `/tmp/opencode/x3/probe/`, changed only artifact root and Rust binary path. Original evidence untouched. Ran probe.py, run.py, supplement.py, shipped.py, analyze.py against gateway built at `487feadd`.

| Outcome | Original | Current |
|---|---:|---:|
| Matrix+supplement pairs |4093|4069|
| Equal |2721|2697|
| Baseline missing-route gaps |1078|1078|
| i Rust-only refusal |241|241|
| ii both fail differently |14|14|
| iii frozen-only refusal |20|20|
| v success-payload |19|19|

The original result artifact contains four extra equal mutation requests for each of six `api_keys.id` classes (24 total); current supplied generator selects only key mutations for that table. No divergence count changed. All classification counts are unchanged after CLI merge.

Shipped-schema confirmations still both class i. Copied multirow generator, adapted paths and reran cases 121/122 separately; both still frozen-200/Rust-500 for healthy A `/api/client/quota` when B provider_data is INTEGER/REAL. Evidence `/tmp/opencode/x3/multirow/{121,122}.json`.

## Boundary

No product readers have changed. Strict auth/routing remains intact. Known call graph from probe/source: gateway auth/snapshot -> omni-store keys `find_by_hash`/snapshot loading -> `read_key_entry` -> `read_key(..., false)`; operator rows currently call strict `read_key(..., true)`. Future fixes must use separate operator projections, not weaken either path. Existing CLI Cell/JsValue helpers remain available unchanged.

`git diff --stat 487feadd..HEAD -- crates/omni-store/src/row.rs crates/omni-store/src/error.rs crates/omni-store/src/pg crates/omni-gateway-core` is empty. Entire commit changes only the new Python driver. No store changes to explain. No route stopped for JS emulation yet: implementation has not started.

## Commands / exits (literal .exit file contents)

```text
cargo build --offline -p omni-gateway => 0
python3 probe.py && python3 run.py && python3 supplement.py && python3 shipped.py && python3 analyze.py => 0
X3_CASE=121 python3 multirow/run.py && X3_CASE=122 python3 multirow/run.py => 0
cargo fmt --all -- --check => 0
cargo build --offline -p omni-gateway => 0
env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/omnigateway-d280b15d python3 conformance/e2e/x3-operator.py => 1
```

Sources: `build-baseline.exit`, `baseline.exit`, `multirow.exit`, `fmt-red.exit`, `build-red.exit`, `corpus-red-committed.exit`. Earlier failed attempts: `corpus-red.exit`, `corpus-red-rerun.exit`, `corpus-red-rerun2.exit`, each exit 1. Build env used CARGO_BUILD_JOBS=2, CARGO_INCREMENTAL=0, CARGO_PROFILE_DEV_DEBUG=0, CARGO_PROFILE_TEST_DEBUG=0; gateway only, offline. Disk checked 15 GiB before baseline build, 14 GiB before post-commit build.

`log-scan.json`: top-level logs scanned for `FAILED|panicked|^error`, zero matches. Driver scans each gateway log for `panicked` and asserts processes remain alive; no panic/startup failures. RED assertions are expected and shown in logs, not hidden by the scan pattern.

## Binaries

- Frozen `/tmp/opencode/a8/ts`, frozen commit `1780bb39`, SHA256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`.
- Baseline `/tmp/opencode/x3/omnigateway-487feadd`, built at `487feadd4d2cf7fec8adf7ada249824c5d6b3fd1`, SHA256 `b72fc8eab7f0fb90841a0213be2aa3f23611b454f70869c3963ae8c31bfea2b9`.
- Post-commit `/tmp/opencode/x3/omnigateway-d280b15d`, built after `d280b15d`, same SHA256 (test-only commit).
- No final fixed gateway or CLI binary exists for X3 yet.

## Remaining / unverified

1. Implement operator-only HTTP readers route-group by route-group using existing cli_cell/JsValue; preserve strict routing. Fix quota coercion and generic `/v1/models` internal body; stop/report any open-ended JS-emulation route.
2. Drive committed corpus to zero unexpected failures, preserve exact 95/15 boundary counts (investigate rather than silently edit accepted scope/counts).
3. Run six CLI corpora with required clean env/private roots, build CLI separately after commits, and record hash.
4. Run workspace tests, clippy, fmt, dispatch_size, frozen-vs-final e2e/run.ts and admin-routes.ts gates, preserving failed attempts and required isolated reruns.
5. Complete final route-reader call graph and boundary proof/review.

Only dirty file remaining is pre-existing e1-e5-report.md; untouched. No push, merge, TS product changes, dependency changes, real config or .env use.

## f- checkpoint: route groups 1 and 2 committed

Stopped after completed route group 2 to leave a bounded handoff. HEAD `f75e39dd` in the requested worktree/branch. No group 3 edits begun. The pre-existing dirty report remains the only dirty file, untouched.

### Commits / post-commit measurements

- `9d18c7ad` — `fix(control): operator keys (2995 pairs / 151 unexpected)`. Post-commit gateway build and corpus confirm 2,995 pairs, 2,734 equal, **151 unexpected**, accepted **95 routing-strict + 15 v1-models-frozen-json**. Evidence `/tmp/opencode/x3/operator-z7x75oxy/{results,summary}.json`.
- `f75e39dd` — `fix(control): credential reads (2995 pairs / 132 unexpected)`. Post-commit gateway build and corpus confirm 2,995 pairs, 2,753 equal, **132 unexpected**, accepted **95 + 15 unchanged**. Evidence `/tmp/opencode/x3/operator-hphxnubc/{results,summary}.json`.
- All 37 key-route failures and all 19 credential-list/health/PATCH failures removed. Remaining route counts: settings 36, models existing PUT 32, catalog 25, models new PUT 20, models GET 11, client quota 5, client history 3. No unexpected key or credential routes remain.

### Readers / boundaries

1. HTTP key `api::key_rows` now uses shared `keys::operator_rows` (renamed/generalised from CLI `cli_rows`), with `OperatorKey` retaining raw `Cell::json` projections and ToString-coerced JSON columns. `api::summary` overlays raw fields in-place, preserving field order and JsValue formatting; expiry edits replace the captured raw expiry too. CLI still uses the same projection. Strict store readers untouched.
2. Credential HTTP `rows` uses existing `rows_with` with `Cell` projections and `cli_cell::json` coercion, preserving HTTP-safe provider_data error messages. CLI's own error path unchanged. Health raw cells use `Cell::json`; last-used seeks bind the actual stored ID class and project raw MAX(at), with scalar ToPropertyKey on SQLite IDs (BLOB is Uint8Array, not an arbitrary parsed object). Source oracle checked at `packages/control/src/credentials.ts:246-255`. PATCH inherits coercing rows. `validate_client_metadata` deliberately remains unchanged for group 5.
3. Credential pre-read in models/catalog/settings: **not implemented**. Next implementer must retain typed values for strict equality, rather than the CLI model writer's current string fallback; inspect frozen code before choosing shared projection.
4. Models own cells: **not implemented**.
5. Client quota/history provider_data: **not implemented**. Generic `/v1/models` internal error body also remains to do.

No route stopped for open-ended JS emulation; groups 3–5 were not attempted. No arbitrary-object emulation added.

Boundary command `git diff --stat 487feadd..HEAD -- crates/omni-store/src/row.rs crates/omni-store/src/error.rs crates/omni-store/src/pg crates/omni-gateway-core` produced empty output. Only product changes are `crates/omni-control/src/{api,keys,credentials}.rs`. `omni-store` key `read_key`, `read_key_entry`, `find_by_hash`, routing snapshots and gateway auth remain byte-for-byte unchanged. HTTP operator key call graph is now admin -> api::key_rows -> control keys::operator_rows; it does not enter strict store key readers. Client-summary reader was only given an empty raw-overlay field to satisfy the shared struct; its actual reader remains unchanged. Exact 95 accepted routing/auth differences remain present after both commits.

### Evidence / literal exit files

All files below are under `/tmp/opencode/x3/`; logs have matching stems. Literal `.exit` contents:

```text
f-keys-fmt.exit: cargo fmt --all -- --check => 1
f-keys-build-pre.exit: cargo build --offline -p omni-gateway => 101
f-keys-build-pre2.exit: cargo build --offline -p omni-gateway => 0
f-keys-corpus-pre.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/f-gateway-keys-pre python3 conformance/e2e/x3-operator.py => 1
f-keys-fmt-rerun.exit: cargo fmt --all -- --check => 0
f-keys-build-committed.exit: cargo build --offline -p omni-gateway => 0
f-keys-corpus-committed.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/f-gateway-9d18c7ad python3 conformance/e2e/x3-operator.py => 1
f-creds-build-pre.exit: cargo build --offline -p omni-gateway => 0
f-creds-corpus-pre.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/f-gateway-creds-pre python3 conformance/e2e/x3-operator.py => 1
f-creds-fmt.exit: cargo fmt --all -- --check => 0
f-creds-build-committed.exit: cargo build --offline -p omni-gateway => 0
f-creds-corpus-committed.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/f-gateway-f75e39dd python3 conformance/e2e/x3-operator.py => 1
f-control-tests.exit: cargo test --offline -p omni-control => 0
```

Failed initial fmt check retained; formatted before successful pre-commit checks. Failed initial build retained (E0509 moving JsValue object fields); fixed by borrowing/cloning, rerun successful. Both corpus pre-runs and committed runs remain red for explicitly remaining groups, with identical respective counts. `f-log-scan.json` scans every f- log for `FAILED|panicked|^error`: only matches are the two compiler error lines from the disclosed failed initial build. No matches in successful builds/control tests. No sleeps/polling or parallel cargo commands. Disk checked before gateway builds, minimum observed 13 GiB; no deletion.

### Binaries

Built **after** each corresponding commit, copied before driving:

- `/tmp/opencode/x3/f-gateway-9d18c7ad`, commit `9d18c7ad`, SHA256 `b9668147d77ca4c405f2204bfd7e6f5574df9e0854d0ca0cda3e86052e7cac9a`.
- `/tmp/opencode/x3/f-gateway-f75e39dd`, current HEAD `f75e39dd`, SHA256 `1a0b5752ab0b7dd789f2d329234f25f7fd3fdff450dec124bc6b8ccea52f1861`.
- Machine-readable hashes `f-binaries.json`. No CLI binary built in this checkpoint.

### Remaining / unverified

Continue requested groups 3, 4, 5, one commit each with corpus counts and post-commit gateway rebuild/rerun. Resolve generic `/v1/models` error body; reach zero unexpected, keep 95/15. All six CLI corpora, final CLI build/hash, workspace tests, clippy, dispatch_size, e2e/run.ts and admin-routes.ts remain **unrun** here. Only `omni-control` tests and pre-commit fmt checks passed; do not treat this checkpoint as final completion. Final gates must follow the original brief, including private HOME/explicit env and `bun --no-env-file`. Independent review remains outstanding.

## g- completion: remaining operator groups

HEAD `0dad4a82`, branch `fix/x3-operator-cells`, requested rust-cli worktree. No subagents, push/merge, dependencies, TS product edits, .env use, or real configuration access. Pre-existing dirty e1-e5 report untouched.

### Commits and measurements

- `ee3a22e2` credential pre-read: **2,995 / 38 unexpected**, post-commit evidence `operator-pnf` is not assumed: exact evidence path is in `g-group3-corpus-committed.log`.
- `29f04060` model own cells: **2,995 / 8 unexpected**, exact evidence path in `g-group4-corpus-committed.log`.
- `ca3831a5` quota JSON + generic models 500: **2,995 / 0 unexpected**, `operator-lwxt30ra`.
- `0dad4a82` test-only follow-up: update key_identity's old /v1/models parser body expectation to generic internal error.
- Final post-HEAD build/corpus: `operator-_w0zr2xp`: **2,995 pairs, 2,885 equal, 0 unexpected, 95 routing-strict + 15 frozen-JSON unchanged**.

### Readers and ruling

3. Models PUT now reads credentials through control `credentials::rows` (HTTP) / `cli_rows` (CLI), preserving raw Cell/JsValue identities for provider/id/authType strict equality. Label is scalar_string only when interpolated. Catalog/settings `api::accounts` reads the same HTTP projection, parses every credential before filtering non-string providers (which cannot strictly equal any catalog provider id). No omni-store tuple reader changes.
4. Models GET/PUT use existing `models::cli_list` raw Cell/json projection via `list_with`; HTTP wraps parse failures in a generic operator-row diagnostic. Strict routing `omni-store::models::list/read_model` untouched.
5. Client quota/history metadata validation uses cli_cell::json, including JSON.parse ToString for INTEGER/REAL/NULL/BLOB. It still parses every credential as frozen credentials.list does; malformed unrelated rows fail the whole list, valid numeric rows do not. No arbitrary object ToPrimitive/ToPropertyKey added. No routes stopped.

/v1/models logs original detail, then replaces only 500 wire errors with `internal error`. Both admin-routes.ts and key_identity.rs pinned old parser-body behavior and were updated; admin-routes.ts was NOT run. The first group-5 corpus observed 108 accepted rather than 95 because 13 previously equal 500s became generic; the first comparator correction observed 91 because it also absorbed four genuine strict-class refusals. Final comparator validates the exact generic Anthropic envelope for 500/500, preserves raw evidence, and keeps those four model_allowlist INTEGER/REAL/BLOB/blobnum strict-reader cases in routing-strict. This is an explicit ruling normalization, not expanded accepted scope; final counts remain 95/15.

### Boundary proof

`g-boundary.txt` is empty: `git diff --stat 487feadd..HEAD -- crates/omni-store/src/row.rs crates/omni-store/src/error.rs crates/omni-store/src/pg crates/omni-gateway-core`. No omni-store changes at all. Admin paths now go admin -> control models/api -> control credentials::rows / models::cli_list -> raw SQLite cells. Auth still goes authenticate -> snapshots/store keys find_by_hash -> read_key_entry -> read_key(false); routing snapshot readers unchanged. server.rs change is exclusively /v1/models error response after authenticate returns, not authentication or routing.

### Gates, retained failed attempts

All command exits below quoted literally from matching .exit files (logs matching stems). Build env CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0; one cargo command at a time. Disk checked before builds, minimum 8.6 GiB. All final gates passed. Initial workspace run and isolated rerun both failed deterministically on key_identity's obsolete /v1/models body expectation, NOT a known load flake; test-only follow-up fixed expectation, full workspace passed. No listed flaky tests failed. Initial six-CLI batch hit harness timeout in wide (143 recorded), all remaining corpora rerun successfully, then all six rerun with a CLI freshly built at final HEAD.

Initial group-3 copy used the wrong binary filename (`omni-gateway` instead of `omnigateway`), so first corpus startup failed (exit 1), retained; corrected copy and all subsequent runs use omnigateway. No evidence overwritten. The two group-5 failed count attempts above retained. `g-log-scan.json` scans every g- log for FAILED|panicked|^error: only matches are the two disclosed obsolete-expectation workspace failures; successful logs clean. pgrep checked e2e drivers: only namespace drivers from C1, no competing non-namespace driver. e2e/run.ts passed with explicit clean environment, private HOME and --no-env-file.

```text
g-cli-build.exit: cargo build --offline -p omni-cli => 0
g-cli-extra-rerun.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/g-cli-ca3831a5 python3 conformance/cli/extra.py => 0
g-cli-neighbors-targeted.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/g-cli-ca3831a5 python3 conformance/cli/neighbors-targeted.py => 0
g-cli-neighbors.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/g-cli-ca3831a5 python3 conformance/cli/neighbors.py => 0
g-cli-quota-json-rerun.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/g-cli-ca3831a5 python3 conformance/cli/quota-json.py => 0
g-cli-stored-cells.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/g-cli-ca3831a5 python3 conformance/cli/stored-cells.py => 0
g-cli-wide-rerun.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/g-cli-ca3831a5 python3 conformance/cli/wide.py => 0
g-cli-wide.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/g-cli-ca3831a5 python3 conformance/cli/wide.py => 143
g-clippy.exit: cargo clippy --offline --workspace --all-targets -- -D warnings => 0
g-contract-fmt.exit: cargo fmt --all -- --check => 0
g-dispatch-size.exit: cargo test --offline -p omni-gateway --test dispatch_size => 0
g-e2e.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/x3/g-gateway-0dad4a82 => 0
g-final-cli-build.exit: cargo build --offline -p omni-cli => 0
g-final-cli-extra.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/g-cli-0dad4a82 python3 conformance/cli/extra.py => 0
g-final-cli-neighbors-targeted.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/g-cli-0dad4a82 python3 conformance/cli/neighbors-targeted.py => 0
g-final-cli-neighbors.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/g-cli-0dad4a82 python3 conformance/cli/neighbors.py => 0
g-final-cli-quota-json.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/g-cli-0dad4a82 python3 conformance/cli/quota-json.py => 0
g-final-cli-stored-cells.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/g-cli-0dad4a82 python3 conformance/cli/stored-cells.py => 0
g-final-cli-wide.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/g-cli-0dad4a82 python3 conformance/cli/wide.py => 0
g-final-corpus.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=<corresponding copied g-gateway> python3 conformance/e2e/x3-operator.py => 0
g-final-fmt.exit: cargo fmt --all -- --check => 0
g-final-gateway-build.exit: cargo build --offline -p omni-gateway => 0
g-group3-build-committed.exit: cargo build --offline -p omni-gateway => 0
g-group3-build-pre.exit: cargo build --offline -p omni-gateway => 0
g-group3-corpus-committed.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=<corresponding copied g-gateway> python3 conformance/e2e/x3-operator.py => 1
g-group3-corpus-pre.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=<corresponding copied g-gateway> python3 conformance/e2e/x3-operator.py => 1
g-group3-corpus-pre2.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=<corresponding copied g-gateway> python3 conformance/e2e/x3-operator.py => 1
g-group3-fmt.exit: cargo fmt --all -- --check => 0
g-group4-build-committed.exit: cargo build --offline -p omni-gateway => 0
g-group4-build-pre.exit: cargo build --offline -p omni-gateway => 0
g-group4-corpus-committed.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=<corresponding copied g-gateway> python3 conformance/e2e/x3-operator.py => 1
g-group4-corpus-pre.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=<corresponding copied g-gateway> python3 conformance/e2e/x3-operator.py => 1
g-group4-fmt.exit: cargo fmt --all -- --check => 0
g-group5-build-committed.exit: cargo build --offline -p omni-gateway => 0
g-group5-build-pre.exit: cargo build --offline -p omni-gateway => 0
g-group5-corpus-committed.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=<corresponding copied g-gateway> python3 conformance/e2e/x3-operator.py => 0
g-group5-corpus-pre.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=<corresponding copied g-gateway> python3 conformance/e2e/x3-operator.py => 1
g-group5-corpus-pre2.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=<corresponding copied g-gateway> python3 conformance/e2e/x3-operator.py => 1
g-group5-fmt.exit: cargo fmt --all -- --check => 0
g-workspace-tests-contract.exit: cargo test --offline --workspace => 0
g-workspace-tests-rerun.exit: cargo test --offline --workspace => 101
g-workspace-tests.exit: cargo test --offline --workspace => 101
```

### Copied binaries (built after named commit)

- c34130f80f10589670c389c45f4b6a657e7fb427e0ec9b5ba6eab1f8d7e2d1a4  /tmp/opencode/x3/g-cli-ca3831a5
- c34130f80f10589670c389c45f4b6a657e7fb427e0ec9b5ba6eab1f8d7e2d1a4  /tmp/opencode/x3/g-cli-0dad4a82
- e257a2c2ab21c30c5a914aa00d748c716b3609b0f7191a175f03fab1ea0f6155  /tmp/opencode/x3/g-gateway-0dad4a82
- d25068337332535c42810b48525d4534c5c688b76566659e52f57fe32811e716  /tmp/opencode/x3/g-gateway-ee3a22e2
- a36b750c832aad7e37edd3f6d14e4b5e7156583220ed15d8143c0e1a2c6dc7c4  /tmp/opencode/x3/g-gateway-29f04060
- e257a2c2ab21c30c5a914aa00d748c716b3609b0f7191a175f03fab1ea0f6155  /tmp/opencode/x3/g-gateway-ca3831a5

Final binaries: `g-gateway-0dad4a82` and `g-cli-0dad4a82`, both built after final HEAD `0dad4a82`. Earlier binary hashes correspond to suffix commit. Final CLI six corpora all exit 0; final workspace tests, clippy, fmt, dispatch_size, e2e all exit 0. `admin-routes.ts` remains deliberately unrun for controller; independent review remains outstanding. No other requested gate unverified.

Exact group evidence clarification: ee3a22e2 -> `/tmp/opencode/x3/operator-fe3_gzy9`; 29f04060 -> `/tmp/opencode/x3/operator-f98mxyn5`. The placeholder-looking `operator-pnf` above is not an artifact path; use these actual paths.

## h- correction: preserve frozen-equal /v1/models diagnostics

Controller RED retained verbatim as `h-admin-red.log` / `.exit` (copied from ctl/admin): **20,595 equal / 27 expected / 7 failures**, exit 1. Confirmed all seven were previously frozen-equal 500 bodies changed by the overbroad generic response.

Commit `8d0c9c13` — `fix(gateway): models errors (2995 pairs / 0 unexpected)`.

`server.rs` now preserves the two frozen auth diagnostic families: `JSON Parse error: …` and `api key configuration is unusable`. Other 500 errors, including Rust-only typed SQLite readers' table/column/storage-class details, still return generic `internal error`; original detail stays in the log. No strict reader/auth/routing change. Reverted admin-routes.ts's Rust-specific Models expectation and restored key_identity.rs's exact frozen parser body. Removed the X3 generic-500 comparison normalization and four-case forced exception: raw comparison now again produces the original 95/15 counts unaided.

Post-commit gateway build and X3: `/tmp/opencode/x3/operator-umgx1o_5`, **2,995 pairs / 2,885 equal / 95 routing-strict / 15 frozen-JSON / 0 unexpected**. Accepted-row body comparison against g-final evidence: **zero accepted Rust response bodies changed**, recorded `h-accepted-body-changes.json`. Only previously equal errors regained their frozen-equal bodies.

Final admin-routes.ts run ALONE: **20,602 equal / 27 expected / 0 failures**, exit 0. `h-pgrep.txt` before drivers showed only C1 namespace driver; no competing default-namespace driver. run.ts and admin-routes.ts ran sequentially, explicit clean env/private HOME, all Bun invocations --no-env-file (including the admin CLI argument).

### Commands / literal exit files

Logs have matching stems. Cargo environment: CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0; offline, one cargo command at a time; disk checked before builds (minimum observed 6.7 GiB).

```text
h-admin-red.exit: controller admin-routes.ts --rust /tmp/opencode/x3/g-gateway-0dad4a82 (copied ctl/admin.log + admin.exit) => 1
h-build-pre.exit: cargo build --offline -p omni-gateway => 0
h-build-committed.exit: cargo build --offline -p omni-gateway => 0
h-corpus-pre.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/h-gateway-pre python3 conformance/e2e/x3-operator.py => 0
h-corpus.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/h-gateway-8d0c9c13 python3 conformance/e2e/x3-operator.py => 0
h-tests.exit: cargo test --offline --workspace => 0
h-clippy.exit: cargo clippy --offline --workspace --all-targets -- -D warnings => 0
h-fmt-pre.exit: cargo fmt --all -- --check => 0
h-fmt.exit: cargo fmt --all -- --check => 0
h-e2e.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/x3/h-gateway-8d0c9c13 => 0
h-admin.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/g-home bun --no-env-file conformance/e2e/admin-routes.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/x3/h-gateway-8d0c9c13 --cli 'bun --no-env-file apps/cli/src/index.ts' --out /tmp/opencode/x3/h-admin => 0
```

Workspace tests passed first attempt; no flaky rerun needed. `h-log-scan.json` scans h- logs for `FAILED|panicked|^error`: zero matches. RED failures are DIFF lines retained separately, not hidden.

Gateway `/tmp/opencode/x3/h-gateway-8d0c9c13`, built AFTER commit `8d0c9c13`, SHA256 `664c321dc9ef6200ffdb7ef7628060da8bcd26f1811152288bba5354986e206a` (`h-sha256.txt`).

Boundary `h-boundary.txt` empty for requested store row/error/pg + gateway-core paths. No omni-store changes; read_key, routing snapshot, auth readers unchanged. Only /v1/models response boundary and its conformance expectations changed. Pre-existing dirty report untouched. No routes stopped. All requested h- gates verified; independent review remains outstanding. Six CLI corpora were not rerun for this HTTP-only correction (previous g-final six passed); no new CLI binary claimed.

## i- review round 1 fixes

Commit `921c3196` — `fix(control): review cells (3697 pairs / 0 unexpected)`, on requested fix/x3-operator-cells worktree. All five findings fixed; no route stopped for open-ended JS emulation.

### Red first and coverage

Expanded committed `conformance/e2e/x3-operator.py` and added exact accepted-row manifest `x3-accepted.json`. Before product fixes, `i-red.log`: 3,466 pairs / 22 unexpected against copied `h-gateway-8d0c9c13`. Added nonempty credential_health and quota_samples fixtures plus all-column scalar mutations, then `i-red-expanded-rerun.log`: **3,697 pairs / 3,566 equal / 94 routing-strict / 15 frozen-JSON / 22 unexpected** (`operator-e8teacum`). First expanded red harness timed out at 1200 seconds (143 retained); rerun with 3600-second allowance completed. RED failures: quota credential_id 8; window_type 8; observed_at BLOB arithmetic 2; integral tier/weight PATCH 2; POST tokenVersion 1; invalid-UTF8 client summary 1.

New quota_windows, credential_health and quota_samples fixtures are nonempty; each column mutated over INTEGER/REAL/NULL/TEXT (including invalid UTF8, empty and numeric)/BLOB (including empty) and health/client quota/history routes. PATCH no-affinity state checks cover tier/weight 2, 2.5, 2^53, 1e20 (tier fractional validation also compared). POST masks only generated response id/clocks and generated typed-state id/encryption/clocks, preserving storage classes and tokenVersion. Existing client summary/display cases retained and no longer hidden.

Final post-commit build/corpus `operator-yjjlp2j8`: **3,697 pairs / 3,588 equal / 94 routing-strict / 15 frozen-JSON / 0 unexpected**. Old class counts 95/15 -> new 94/15: removed exactly invalidutf model_allowlist/client-summary, now equal. Every remaining accepted row is listed by full case/request/status identity with reason in committed manifest; auth errors additionally pin exact Rust response body. No wildcard route classifier remains. Manifest reasons: key lookup/auth refusal (65 client 401 + 16 models typed/auth errors); strict-invalid model skipped by snapshot (13 models payloads); frozen snapshot throws while Rust isolates invalid rows (15). No additional accepted rows introduced.

### Readers / write-back

1. Health quota keeps raw Cell/json ids/window types in quota AND burn output; numeric scratch data no longer uses typed SQL String re-reads. Client quota/history retain existing SameValueZero join (BLOB identity never matches), unchanged and covered by nonempty fixtures.
2. Burn numeric scalar operations use cli_cell::scalar_number, including Uint8Array empty -> 0; observed_at TEXT/BLOB addition uses scalar_string + JS number suffix. BLOB observed_at X'7178' yields frozen string `113,120NaN`, empty blob suppresses burn. Only SQLite scalar conversion used, no arbitrary object emulation.
3. HTTP PATCH now binds tier/weight via shared cli_cell::bind_number: finite integral safe JS numbers -> INTEGER except -0; others REAL. `i-bun-numbers.log` records clean-env Bun oracle for -0, 0, 2, 2.5, 2^31, 2^32-1, 2^53-1, 2^53, 2^63, 1e20. Unit test pins boundary. Operator-local UPDATE preserves original columns/semantics without editing strict store APIs; CLI retains existing separate store path.
4. POST overrides tokenVersion to literal 0, as frozen create return does, independent of defaults; other response fields retain prior behavior.
5. Post-auth client summary allowlist projection now uses cli_cell::string (lossy TEXT decoding then JSON.parse), not Option<String>. Authentication/session/snapshot readers unchanged.

/v1/models predicate unchanged by this round: only Rust-emittable frozen-equal parser prefix and exact configuration-unusable diagnostic preserved; other internal errors generic. Review's distinction between that set and all theoretically possible frozen runtime exceptions remains applicable.

### Gates / evidence

Copied final binaries built AFTER 921c3196. Gateway `/tmp/opencode/x3/i-gateway-921c3196`: SHA256 `d212151d9e6dce5a9a05b49e90c41c0053c3e18180336990d41ad80dcc49cf6f`. CLI `/tmp/opencode/x3/i-cli-921c3196`: SHA256 `89aa955975db99c69e13a0001b7db81477c43ee8d6cd810df2b64e6efde4ddff`.

All final requested gates exit 0. Workspace tests passed first attempt (no flaky rerun); six CLI corpora sequential, fresh final-HEAD CLI; run.ts inside unshare -Urn private network namespace. admin-routes.ts NOT run (controller reserved). Cargo offline env CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0, one cargo command at a time. Disk checks stayed >=5 GiB (minimum observed 5.6 GiB before gateway build; later external reclamation raised availability; no deletion performed here).

Literal exits from .exit files, matching .log files retained:

```text
i-build-final.exit: cargo build --offline -p omni-gateway => 0
i-build-pre.exit: cargo build --offline -p omni-gateway => 101
i-build-pre2.exit: cargo build --offline -p omni-gateway => 0
i-cli-build.exit: cargo build --offline -p omni-cli => 0
i-cli-extra.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/i-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/i-cli-921c3196 python3 conformance/cli/extra.py => 0
i-cli-neighbors-targeted.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/i-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/i-cli-921c3196 python3 conformance/cli/neighbors-targeted.py => 0
i-cli-neighbors.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/i-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/i-cli-921c3196 python3 conformance/cli/neighbors.py => 0
i-cli-quota-json.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/i-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/i-cli-921c3196 python3 conformance/cli/quota-json.py => 0
i-cli-stored-cells.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/i-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/i-cli-921c3196 python3 conformance/cli/stored-cells.py => 0
i-cli-wide.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/i-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/i-cli-921c3196 python3 conformance/cli/wide.py => 0
i-clippy.exit: cargo clippy --offline --workspace --all-targets -- -D warnings => 0
i-corpus-final.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/i-gateway-921c3196 python3 conformance/e2e/x3-operator.py => 0
i-dispatch-size.exit: cargo test --offline -p omni-gateway --test dispatch_size => 0
i-fmt-pre.exit: cargo fmt --all -- --check => 0
i-fmt-pre2.exit: cargo fmt --all -- --check => 0
i-fmt.exit: cargo fmt --all -- --check => 0
i-pre-expanded.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/i-gateway-pre python3 conformance/e2e/x3-operator.py => 0
i-pre.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/i-gateway-pre python3 conformance/e2e/x3-operator.py => 0
i-red-expanded-rerun.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/h-gateway-8d0c9c13 python3 conformance/e2e/x3-operator.py => 1
i-red-expanded.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/h-gateway-8d0c9c13 python3 conformance/e2e/x3-operator.py => 143
i-red.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/h-gateway-8d0c9c13 python3 conformance/e2e/x3-operator.py => 1
i-run.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/i-home unshare -Urn bash -c 'ip link set lo up; bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/x3/i-gateway-921c3196' => 0
i-tests.exit: cargo test --offline --workspace => 0
```

Initial compile failed E0716 temporary String borrow (101), fixed and rebuilt successfully; failed log retained. `i-log-scan.json` scans all i- logs for FAILED|panicked|^error: only that disclosed failed compile matches. Corpus assertions and harness timeout separately disclosed above.

### Boundary / remaining verification

`i-boundary.txt` empty for row.rs/error.rs/pg/gateway-core diff from 487feadd. No omni-store product changes. Auth -> strict keys/read_key(false)/snapshot call graph untouched. Operator changes remain inside omni-control; client display adjustment happens AFTER unchanged auth. Only dirty file is pre-existing e1-e5 report, untouched. No TS product/dependency/bun.lock edits, real env/config access, subagents, push or merge. Reviewer evidence directory was only read; no scripts/artifacts there modified or executed. No routes stopped. Controller admin-routes gate and independent re-review remain unverified here; all requested implementer gates passed. This corpus is finite scalar-class coverage, not a claim of exhaustive arbitrary byte/schema/row-combination equivalence.

## j- re-review: raw burn strict equality and multi-cell branches

One commit `478a974f` — `fix(control): raw burn zero (4106 pairs / 0 unexpected)`. No manifest edits; all 109 accepted identities unchanged (94 routing-strict + 15 frozen-JSON). No routes stopped.

### Red first / multi-cell coverage

Added 409 health pairs to committed corpus: six columns used/limit_value/observed_at/starts_at/resets_at/window_ms across 17 scalar variants × four cross-cell bases (active numeric, NaN/BLOB observed_at, stale, rolled), plus one shipped-schema empty-BLOB used + BLOB observed_at case. Variants include TEXT '0', NULL, numeric integer/REAL zero and -0, nonzero INTEGER/REAL, empty/numeric/invalid UTF8 TEXT, BLOB empty/zero/number/multiple bytes and future timestamp. Frozen stores -0 REAL under this fixture, preserving the numeric-zero branch.

Against copied 921c3196 gateway, `j-red.log`, `operator-a8trymd5`: **4,106 pairs / 3,991 equal / 94+15 accepted / 6 unexpected**. Five used-raw-zero differences: NULL, empty TEXT, TEXT '0', empty BLOB under NaN observation, and shipped empty BLOB. Sixth newly exposed cross-cell difference: BLOB resets_at with BLOB observed_at requires final string/string lexical comparison (`113,120NaN` >= `113,120`), not numeric NaN comparison. Fixed with explicit scalar Uint8Array ToPrimitive string only; no open-ended object emulation.

Final post-commit gateway/corpus `operator-bzv9okim`: **4,106 pairs / 3,997 equal / 94 routing-strict + 15 frozen-JSON / 0 unexpected**. All six red cases now equal; class counts and manifest unchanged.

### Branch-by-branch frozen burn audit

- suppressed ids/windowType remain raw. observedAt <=0 and age use scalar ToNumber relational/arithmetic, not strict zero.
- rolled check is raw reset !== null (optional number represents precisely raw NULL absence), then numeric <=now. windowStart raw reset ===null remains None only for raw NULL; NaN stays Some(NaN), serialized null only at output.
- durationFor raw windowMs !==null is represented by optional; positive relational comparison coerces, subtraction coerces. Unknown windowType yields NaN nominal, as before. starts_at is intentionally unused by frozen burn.
- rate: elapsedHours null follows only missing raw reset; elapsed <=0 is numeric relational. **used ===0 now compares raw JsValue::Number(0.0)**, including +/-0 and INTEGER/REAL, never TEXT/NULL/BLOB. Division alone uses q.used ToNumber.
- limit ===null remains raw optional absence; limit<=0/rate<=0 numeric, Math.max/subtraction numeric; observedAt +delta numeric for numeric/NULL cells, concatenating for TEXT/Uint8Array strings.
- survives: derived exhausts null and raw reset null handled before relational comparison; ToPrimitive yields lexical comparison only when both primitives strings, including reset BLOB, else numeric comparison. No typeof/undefined branch in burnFor/windowStartOf/durationFor/quotaRolledOver requires arbitrary values; SQLite SELECT columns always exist.
- stale/rolled suppression and window start on rolled path preserved; output null-vs-NaN distinction maintained internally.

### Gates / binaries

Both binaries built AFTER `478a974f`, CLI separately. Gateway `/tmp/opencode/x3/j-gateway-478a974f`, SHA256 `d7c9f855b1b4bc09880ec931a8b4902015a9a2790f358d0062b94544ce87cdb4`. CLI `/tmp/opencode/x3/j-cli-478a974f`, SHA256 `368be9f5a9d22f787dec044e61eed8b0e185cbffe5510492a473b837108a2c2a`.

All final requested gates exit 0; workspace first attempt, no flaky retries. Six CLI corpora sequential with final-HEAD CLI; namespace run.ts passed, no default-namespace collisions. admin-routes.ts NOT run (controller reserved). Cargo offline, jobs=2/incremental=0/dev+test debug=0, one command at a time. Disk before builds >=6.4 GiB observed, no deletion. Every j- log scanned for FAILED|panicked|^error in `j-log-scan.json`: zero matches; RED assertion is separately retained and disclosed. No failed build/timeout attempts this round.

Literal command exits from matching .exit files:

```text
j-build-final.exit: cargo build --offline -p omni-gateway => 0
j-build-pre.exit: cargo build --offline -p omni-gateway => 0
j-cli-build.exit: cargo build --offline -p omni-cli => 0
j-cli-extra.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/j-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/j-cli-478a974f python3 conformance/cli/extra.py => 0
j-cli-neighbors-targeted.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/j-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/j-cli-478a974f python3 conformance/cli/neighbors-targeted.py => 0
j-cli-neighbors.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/j-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/j-cli-478a974f python3 conformance/cli/neighbors.py => 0
j-cli-quota-json.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/j-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/j-cli-478a974f python3 conformance/cli/quota-json.py => 0
j-cli-stored-cells.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/j-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/j-cli-478a974f python3 conformance/cli/stored-cells.py => 0
j-cli-wide.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/j-home PYTHONDONTWRITEBYTECODE=1 CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/x3/j-cli-478a974f python3 conformance/cli/wide.py => 0
j-clippy.exit: cargo clippy --offline --workspace --all-targets -- -D warnings => 0
j-corpus.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/j-gateway-478a974f python3 conformance/e2e/x3-operator.py => 0
j-dispatch-size.exit: cargo test --offline -p omni-gateway --test dispatch_size => 0
j-fmt-pre.exit: cargo fmt --all -- --check => 0
j-fmt.exit: cargo fmt --all -- --check => 0
j-pre.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/j-gateway-pre python3 conformance/e2e/x3-operator.py => 0
j-red.exit: env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/x3/i-gateway-921c3196 python3 conformance/e2e/x3-operator.py => 1
j-run.exit: env -i PATH="$PATH" HOME=/tmp/opencode/x3/j-home unshare -Urn bash -c 'ip link set lo up; bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/x3/j-gateway-478a974f' => 0
j-tests.exit: cargo test --offline --workspace => 0
```

Boundary `j-boundary.txt` empty for requested row/error/pg/gateway-core paths from 487feadd. No omni-store/auth/routing/snapshot edits; only operator health burn and corpus changed. Reviewer evidence read-only, no execution/modification. Pre-existing dirty report untouched. Controller admin-routes and independent re-review remain outstanding; all requested implementer gates verified. Finite branch/scalar matrix is not an all-bytes/all-schemas guarantee.
