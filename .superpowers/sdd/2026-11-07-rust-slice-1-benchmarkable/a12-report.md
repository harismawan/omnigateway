# A12 models dry-run

Design: frozen dryRun validates a strict capabilities-only object, reads fresh routing rows, looks up only an explicitly stored virtual model (not resolve_model), then reuses rank with rand=0 and no load/recent use. HTTP requires operator, not viewer. CLI reads the local DB directly, not HTTP. Reuse omni-router, shared operation in omni-control, minimal admin route change. Project exclusions without kind. rankedAt is wall time (validated and masked by differential tests).

Base: a24941af. Base build succeeded (base-build.exit=0); binary is named omnigateway, initial copy using omni-gateway failed, corrected without rebuilding.

## Commits / evidence
- Step 1: `27da88ae`, 273 HTTP rows, base red 273 mismatches, green 0. All four frozen strategies (score, priority, weighted, roundRobin); 8 need combinations, missing/defaulted and malformed types/objects/raw JSON, anonymous/viewer/operator, concrete/unknown IDs, missing provider, kilo (unported codec but descriptor registered), disabled, expired API key (still eligible, frozen intentionally ignores expiry for API keys), expired OAuth, open/rate-limited health.
- Step 2: `0df9f1a0`, 100 CLI cases, red 100 mismatches, green 0. Local store access, no HTTP. Both human and JSON, all need combinations, missing/unknown IDs, bad flags. CLI binary built alone at final HEAD.
- No new accepted difference classes. Plugin-provider manifests use the existing CLI refusal pattern; arbitrary plugin loading remains outside the Rust runtime. This corpus seeds an unknown plugin provider ID but does not execute plugin JS.
- HTTP driver compares JSON property insertion order as well as values, status and content-type. It does not compare date or transport-generated headers. rankedAt is validated within 120 seconds then masked; CLI JSON otherwise retains output order/format via parse-normalization. Scratch roots are driver-created.
- Initial harness attempts (stdio option, seed column, invalid target defaults) are retained. Final driver uses valid cost/capability targets. Successful red evidence is http-red-final; http-green4 predates expanded health/auth rows; http-step1 is the expanded green.

## Binaries
- a24941af base gateway: `/tmp/opencode/a12/rust-base`, sha256 `d5a7725f2664997363ecdbb69c22de26eb28ff9d0de4d874978c5ae80a09a1ca`.
- 27da88ae gateway: `/tmp/opencode/a12/gateway-step1`, sha256 `4e81794ae9056bea03af7eb70b4271bd74bd817f27bdde1e4a82879a4add33e3`.
- 0df9f1a0 gateway: `/tmp/opencode/a12/gateway`, sha256 `049c0bfc514f346df9101e25624dbb7110641540ec79a0c0ec480126ad9615a9`.
- 0df9f1a0 CLI (built alone): `/tmp/opencode/a12/omni`, sha256 `b3aff20fb69c984476118c6b3144c7c9d3ed120c58775908f4d44ca62da9d9b8`.

## Scope observations
Frozen behavior overrides the broad brief: a concrete catalog model is not resolved here, and API-key model allowlists and smart-router classification do not participate in dryRun. Only virtual_models is consulted, and rank is called directly; no provider traffic, load accounting, or classifier calls occur. Kilo remains a candidate even though its Rust transport is unported: its router descriptor exists, exactly as the frozen registry. Unknown providers report provider:missing. The request neither requires nor consumes an API key.

No files owned by the body-capture implementer were edited. Only admin_routes.rs changed in the gateway. No TS product code, bun.lock, new external dependency, stash, production configuration, or source worktree was touched. Added existing local omni-router dependency to omni-control (Cargo.lock updated).

Frozen source files checked against 1780bb39: no diff. Oracle binary sha256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`.

Known validation coverage limits: this small corpus does not execute plugin manifests or unusual dynamically typed stored cells (the six existing corpora cover those for their existing commands, not the new command). HTTP headers are limited to content-type. CLI JSON comparisons normalize through JSON decoding, so whitespace-only JSON output drift is not caught. These are test coverage limits, not accepted behavior differences.

## Completed pre-gate commands (exit read from .exit files)
- `cargo build --offline -p omni-gateway (base a24941af)` — exit `0` (`base-build.exit`); log `base-build.log`.
- `bun --no-env-file conformance/e2e/models-dry-run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/rust-base` — exit `1` (`http-red-final.exit`); log `http-red-final.log`.
- `bun --no-env-file conformance/e2e/models-dry-run.ts --ts /tmp/opencode/a8/ts --rust target/debug/omnigateway` — exit `0` (`http-step1.exit`); log `http-step1.log`.
- `cargo fmt --all -- --check (step 1)` — exit `0` (`fmt-step1.exit`); log `fmt-step1.log`.
- `cargo build --offline -p omni-gateway (27da88ae)` — exit `0` (`step1-build.exit`); log `step1-build.log`.
- `python3 conformance/cli/models-dry-run.py (pre-implementation binary)` — exit `1` (`cli-red.exit`); log `cli-red.log`.
- `python3 conformance/cli/models-dry-run.py (development CLI)` — exit `0` (`cli-green.exit`); log `cli-green.log`.
- `cargo fmt --all -- --check (step 2)` — exit `0` (`fmt-step2.exit`); log `fmt-step2.log`.
- `cargo build --offline -p omni-cli (0df9f1a0; CLI alone)` — exit `0` (`cli-final-build.exit`); log `cli-final-build.log`.
- `cargo build --offline -p omni-gateway (0df9f1a0)` — exit `0` (`gateway-final-build.exit`); log `gateway-final-build.log`.

### Plugins
Plugins: out of scope by user ruling; dry-run with a loadable plugin follows the existing refuse_plugins refusal (frozen would import the JS).
- Installed loadable provider plugin `<id>` under `<root>`: stdout empty, stderr `plugin providers are not supported by this Rust CLI; <id> in <root>/plugins declares one\n`, exit 1 (multiple IDs are sorted and joined with `, `).
- Invalid manifest: no plugin warning or refusal; normal dry-run output and exit (for an existing valid model, exit 0; `--json` includes `pluginFailures: []`, and a target with no registered provider reports `provider:missing`).

Supplemental empty-pool CLI check: 12 cases (all strategies, human/no-needs/all-needs/JSON), 0 failures. `python3 <private empty-pool driver>` — exit `0` (`cli-empty.exit`); evidence path and count in cli-empty.log. This supplemental inline driver is not included in the committed 100-case count.

HTTP auth distribution (http-step1): Counter({('none', 401): 90, ('viewer', 401): 90, ('operator', 200): 36, ('operator', 400): 36, ('operator', 404): 18, (None, 400): 3}). Viewer is refused with 401 exactly like anonymous, not 403.

Build/test environment: env -i, private HOME=/tmp/opencode/a12/home, CARGO_HOME=/home/homebrew/.cargo, PATH=/usr/sbin:/usr/bin:/bin:/home/homebrew/.bun/bin:/home/linuxbrew/.linuxbrew/bin, CARGO_BUILD_JOBS=2, CARGO_INCREMENTAL=0, CARGO_PROFILE_DEV_DEBUG=0, CARGO_PROFILE_TEST_DEBUG=0. Disk checked before builds; remained >=17 GiB. Cargo commands serialized. Final CLI/gateway copies were made after commit and used for corpora.

The hard filtering/ranking algorithm is not duplicated: the operation constructs the same image/text, portable tool and adaptive-reasoning probe and invokes omni_router::rank with providers from the running gateway (HTTP) or built-ins (CLI), rand=0, no load or recent-use. Snapshot uses fresh DB rows, not the gateway's cached snapshot. Output projects candidate fields and excludes internal kind. Strict schema uses the existing zod-compatible body_schema evaluator.

## Final status pending gates
Implementation commits are append-only; final worktree clean at 0df9f1a0. HTTP and CLI built-in/no-plugin matrices passed before gates. Plugins are out of scope by user ruling, not a blocker or a new difference class. Two background gate batches are running; completion results will be appended from their .exit files.

## Final Rust gates
- `cargo test --offline --workspace` — exit `0` (`workspace-test.exit`); log `workspace-test.log`.
- `cargo clippy --offline --workspace --all-targets -- -D warnings` — exit `101` (`clippy.exit`); log `clippy.log`.
- `cargo fmt --all -- --check` — exit `0` (`fmt.exit`); log `fmt.log`.
- `cargo test --offline -p omni-gateway --test dispatch_size` — exit `0` (`dispatch_size.exit`); log `dispatch_size.log`.

Workspace tests passed on first attempt; no flaky rerun needed. Clippy failed on the new nested route condition at admin_routes.rs:254 (`collapsible_if`); suggested fix is a let-chain. Per controller instruction “no other changes”, code remains unchanged pending controller review; failed gate is not represented as passing.

## Controller-directed lint-only follow-up
The initial corpus batch hit the harness 1,200-second timeout during wide (SIGTERM 143); `cli-wide.log` retained, no `.exit` was produced for the interrupted command. No surviving corpus child process was found before editing. Remaining commands had not started.
- `python3 conformance/cli/models-dry-run.py` — exit `0` (`cli-final.exit`); log `cli-final.log`.
- `python3 conformance/cli/stored-cells.py` — exit `0` (`cli-stored-cells.exit`); log `cli-stored-cells.log`.
- `python3 conformance/cli/neighbors.py` — exit `0` (`cli-neighbors.exit`); log `cli-neighbors.log`.
- `python3 conformance/cli/neighbors-targeted.py` — exit `0` (`cli-neighbors-targeted.exit`); log `cli-neighbors-targeted.log`.
- `cargo fmt --all -- --check (precommit)` — exit `0` (`fmt-lint-precommit.exit`); log `fmt-lint-precommit.log`.

Lint-only commit `63e0ae42`: collapse route condition with a let-chain; only admin_routes.rs changed, no behavior or CLI changes. Original failed clippy.log/clippy.exit retained. Final-HEAD clippy/fmt/gateway tests/build/HTTP/X3/run.ts and resumed CLI corpora launched with no command timeout. CLI copy remains the unchanged CLI-alone 0df9f1a0 artifact; no omni-cli or shared implementation changes in 63e0ae42, so per controller no CLI rebuild.

## Resumed CLI corpus results
- `python3 conformance/cli/wide.py` — exit `0` (`cli-wide-resume.exit`); log `cli-wide-resume.log`.
- `python3 conformance/cli/extra.py` — exit `0` (`cli-extra-resume.exit`); log `cli-extra-resume.log`.
- `python3 conformance/cli/quota-json.py` — exit `0` (`cli-quota-json-resume.exit`); log `cli-quota-json-resume.log`.

## Final-HEAD results (63e0ae42)
- `cargo clippy --offline --workspace --all-targets -- -D warnings` — exit `0` (`clippy-final.exit`); log `clippy-final.log`.
- `cargo fmt --all -- --check` — exit `0` (`fmt-final.exit`); log `fmt-final.log`.
- `cargo test --offline -p omni-gateway` — exit `0` (`gateway-test-final.exit`); log `gateway-test-final.log`.
- `cargo build --offline -p omni-gateway` — exit `0` (`gateway-lint-build.exit`); log `gateway-lint-build.log`.
- `bun --no-env-file conformance/e2e/models-dry-run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/gateway-final` — exit `0` (`http-lint-final.exit`); log `http-lint-final.log`.
- `env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/a12/gateway-final python3 conformance/e2e/x3-operator.py` — exit `0` (`x3.exit`); log `x3.log`.
- `unshare -Urn bash -c 'ip link set lo up; bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/gateway-final'` — exit `0` (`run-final.exit`); log `run-final.log`.

Final gateway: `/tmp/opencode/a12/gateway-final`, commit `63e0ae42668a7be310803d617679719ce08e6c7f`, sha256 `049c0bfc514f346df9101e25624dbb7110641540ec79a0c0ec480126ad9615a9`. Hash is identical to 0df9f1a0 gateway: the let-chain lint fix changed no compiled behavior. CLI remains `/tmp/opencode/a12/omni` built alone at 0df9f1a0, sha256 `b3aff20fb69c984476118c6b3144c7c9d3ed120c58775908f4d44ca62da9d9b8`; no CLI files changed in the lint-only commit.

Final HTTP: 273 rows, zero failures. CLI: 100 cases, zero failures; all six CLI corpora passed (resumed wide/extra/quota-json after original batch timeout). X3: 4,106 pairs, zero unexpected differences; only existing 94 routing-strict + 15 v1-models-frozen-json classes. Namespaced run.ts: all rows equal. Workspace test and dispatch_size passed at implementation HEAD; gateway tests (including dispatch_size) passed again at final HEAD. No flaky retry needed. Original failed clippy gate retained; final clippy passes.

FINAL: requested scoped implementation and gates complete; plugins excluded by user ruling; worktree clean at 63e0ae42. No push or merge.

## f1 — stopped at required typed-carrier boundary (2026-11-17)

No implementation/test edits or commits. Worktree remains clean at `63e0ae42668a7be310803d617679719ce08e6c7f`. The instruction to STOP and report if omni-router's typed inputs cannot carry frozen values applies: `RankInput.model` and `RankInput.snapshot` require store `VirtualModel`/`Credential` values (`crates/omni-router/src/rank.rs:24–35`). `Target.tier: f64` and boolean `Capabilities` cannot carry frozen string tier `"2"` or numeric capability `1`; `Credential.label: String` cannot carry a BLOB-as-object label; `Credential.expires_at: Option<i64>` cannot carry fractional expiry `1.5`; `VirtualModel.strategy: Strategy` cannot carry a BLOB-as-object strategy. Converting these values to the existing types would lose required operator output or JS semantics. No new accepted-difference class invented and no strict live reader changed.

Minimal proposed carrier (requires controller approval before implementation): a separate operator ranking input/view with raw `JsValue` fields (and preserved BLOB cell identity for ToString), built using existing `credentials::rows` and `cli_cell::{Cell,json,scalar_string,scalar_number}`. Give the shared ranker an adapter/view boundary so strict live typed inputs remain unchanged, while operator inputs retain raw target tier/weight/capabilities, credential metadata/expiry, strategy and health cells. Arithmetic, truthiness, strict equality and health-key coercion must occur at their frozen use sites; raw values remain available for result projection. Merely attaching output overrides to a lossy typed snapshot is not sufficient for general stored-cell semantics. This is a carrier proposal, not an implemented design or accepted difference.

Frozen checks / red evidence (review scripts copied to `/tmp/opencode/a12/f1-*`; reviewer originals untouched):
- P1: unrelated JSON-valid `{}` row, string target tier, numeric capability and BLOB strategy reproduced. String tier retained as `"2"`, score 8.5; BLOB strategy returned as indexed numeric object, deterministic true. Added an evidence-only unrelated `not-json` target probe: both return 500 INTERNAL (whole-list JSON parsing still required). Frozen source checked at `packages/control/src/dryRun.ts:45–84`, `packages/store/src/sqlite/config.ts:65–75`.
- P2a: BLOB label, TEXT credential tier, fractional expiry/disabled timestamp, BLOB provider_data and JSON-null provider_data reproduce the review differences. Frozen source confirmed raw projection and bare JSON.parse at `packages/store/src/sqlite/credentials.ts:152–168,198–211`.
- P2b: BLOB health credential identity reproduces frozen 200 versus Rust 500. Frozen key is `credentialId + "::" + model` (`packages/router/src/snapshot.ts:5–8,20`); explicit Bun check confirms `String(new Uint8Array([97,98])) === "97,98"`, JSON projection is `{"0":97,"1":98}` (`f1-coercion.log`).
- Review probe groups: 28 pairs / 7 mismatches (`f1-probes-red`), 28 actual pairs / 1 mismatch (`f1-probes2-red`; 8 extra constraint-rejected seed records are not mismatches), 14 actual pairs / 3 mismatches (`f1-probes3-red`; 2 constraint-rejected seed records excluded): all 11 HTTP findings reproduced. Extra non-JSON probe group: 29 pairs / 7 mismatches (`f1-probes-nonjson-red`), non-JSON case itself matches.
- Live probe: frozen and Rust inference both 503; frozen dry-run 200, Rust dry-run 500 (`f1-live-red/run-*/rows.json`).

Executed commands and exit codes read from same-named `.exit` files (probe drivers collect mismatches without failing):
- `bun --no-env-file /tmp/opencode/a12/f1-probes.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/gateway --out /tmp/opencode/a12/f1-probes-red` — exit `0` (`f1-probes-red.exit`).
- `bun --no-env-file /tmp/opencode/a12/f1-probes2.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/gateway --out /tmp/opencode/a12/f1-probes2-red` — exit `0` (`f1-probes2-red.exit`).
- `bun --no-env-file /tmp/opencode/a12/f1-probes3.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/gateway --out /tmp/opencode/a12/f1-probes3-red` — exit `0` (`f1-probes3-red.exit`).
- `bun --no-env-file /tmp/opencode/a12/f1-probes.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/gateway --out /tmp/opencode/a12/f1-probes-nonjson-red` — exit `0` (`f1-probes-nonjson-red.exit`).
- `bun --no-env-file /tmp/opencode/a12/f1-live.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/gateway --out /tmp/opencode/a12/f1-live-red` — exit `0` (`f1-live-red.exit`).
- `bun --no-env-file -e <Uint8Array coercion check>` — exit `0` (`f1-coercion.exit`).

Gateways ran under `env -i` with private HOME, prescribed PATH/CARGO_HOME and `unshare -Urn` loopback. No cargo command/build, TS product edit, config access, stash operation, push or merge. Used previously supplied gateway artifact only; no new binary provenance claimed. Still outstanding: approved carrier, committed expanded red HTTP/CLI corpora (including hermetic CLI seed, stored-cell cross-product, 318 heterogeneous ranking rows and live case), all fixes, CLI red repros, all green reruns, final gates/builds/hashes/commits. Plugin manifest diagnostics remain excluded for the user's plugin list.

## f2 — narrowed crash/coercive-ranking repair (2026-11-17)

Worktree `/home/homebrew/.local/share/opencode/worktree/1600a1/rust-cli`, branch `feat/rust-models-dry-run`. Current clean commit `fb11d6132b26248c017071a9ac5ca43117115c8c`. Append-only commits: `0e499b99` test corpus, `03142c80` tolerant readers, `a79ac229` compile correction, `b79e84f8` path-constrained render manifest, `fb11d613` expanded stored-cell/live corpus and CLI JSON.parse errors. Initial two commit subjects count the initial 648 HTTP + 112 CLI = 760 rows. Final corpora enumerate 747 HTTP records (10 constraint-rejected cells, 737 actual comparisons) and 210 CLI records (10 constraint-rejected cells, 200 actual comparisons). The rejected NULL cells are explicitly recorded, NOT claimed as nullable coverage. SQLite affinity can normalize numeric TEXT/-0 inputs; these are storage mutations, not a claim that affinity preserves every supplied type.

### Finding checks / changes
- P1: frozen `packages/router/src/index.ts` (there is no rank.ts in frozen 1780bb39) switches on strategy by strict equality; BLOB matches no case, preserving arrival order. Frozen filters use JS truthiness for capabilities; tier participates in arithmetic. Dry-run now JSON.parses ALL model target cells but converts ONLY the selected row. Unrelated `{}` no longer crashes; unrelated non-JSON still returns the same HTTP 500 INTERNAL. Selected string tier becomes numeric 2, numeric tools=1 becomes true; ranking ids/order/scores/reasons/exclusions match. BLOB strategy is `Strategy::Other` with byte-list text, so it does NOT accidentally select score sorting. Review live repro and committed live case: both live 503; final both dry 200 (red Rust dry 500).
- P2a: reuse `credentials::rows` and `cli_cell::{Cell,json,scalar_string,scalar_number}`; no strict live readers touched. TEXT tier / BLOB label / REAL expiry / REAL disabledAt no longer remove rows. Frozen API-key expiry is ignored. OAuth expiry is compared as f64 BEFORE encoding the predicate in Option<i64>: expired -> MIN, future/NaN/null -> None. Thus no 1.5->1 floor eligibility boundary: e.g. expiry=1.5, now=1 remains eligible; expiry=1.5, now=1.5 expires. disabledAt does not participate in frozen rank eligibility (enabled does). Frozen BLOB provider_data and parsed JSON null still fail the whole HTTP request with identical 500 INTERNAL body; malformed JSON CLI errors now retain the shared bare JSON.parse diagnostic. No secret needs opening for frozen dry-run.
- P2b: dry-run-only health projection uses shared Cell coercion; BLOB identity String(Uint8Array) is `97,98`, preserving composite-key semantics even when that string matches a real credential. Failures/opened/until arithmetic retains the existing HealthScalars carrier. No changes to omni-router types, strict store models/credentials/list_routing/list_routing_health, gateway-core snapshot or A3 files.

### Red -> green and accepted rendering
- Original review findings on 63e0ae42 supplied artifacts: 648 initial HTTP rows / 11 failures; 112 initial CLI rows / 6 failures (`f2-http-red`, `f2-cli-red`).
- Final committed corpus on same 63e0ae42 artifacts: HTTP 747 records, 26 failures, 0 accepted (`f2-final2-http-red`); CLI 210 records, 26 failures, 0 accepted (`f2-final2-cli-red`). Final HTTP 747 / 0 unexpected / 5 accepted; CLI 210 / 0 unexpected / 3 accepted. HTTP includes the review's 318-row heterogeneous ranking/auth/schema matrix and pre-boot poison/live discrimination. CLI schema/seed is created locally by the corpus, no newest HTTP-seed dependency.
- `conformance/e2e/models-dry-run-accepted.json` defines the sole new USER-approved class `dry-run-malformed-render`. Exact identities/statuses/paths are committed: string target tier HTTP 200/200 `/body/candidates/{1,2}/tier`, CLI 0/0 `/candidates/{1,2}/tier`; BLOB strategy x73636f7265 HTTP 200/200 `/body/strategy`; BLOB strategy x6162 HTTP 200/200 `/body/strategy`, CLI 0/0 `/strategy`; BLOB label x6162 HTTP 200/200 `/body/candidates/1/credentialLabel`, CLI 0/0 `/candidates/1/credentialLabel`. HTTP repeats label once in the cross-product, hence 5 accepted observations across 4 identities. Human CLI string-tier output is exactly equal, not accepted. Everything else (including status, candidate IDs/order/scores/reasons/exclusions) must be equal, or driver fails.
- Re-ran reviewer probes unchanged with explicit output paths: probes 28 pairs / 3 render-only differences; probes2 28 actual comparisons + 8 rejected-seed records / zero differences; probes3 14 comparisons + 2 rejected-seed records / zero differences; rank 318/318 equal; live both 503/dry 200. Supplemental CLI gaps 12 / 1 JSON-tier rendering difference, human equal. Plugin probes 10 differences, all excluded plugin diagnostics/refusal. Exact classification and paths: `f2-final2-classification.json`: 4 manifest-class, 10 plugin, NONE other. Probe collector exits do not imply parity: the independent classification assertion is also exit 0.

### Artifacts / isolation
- Final gateway `/tmp/opencode/a12/f2-final2-gateway`, sha256 `b19320e5e97bea52ca8eb05dcf8945b3d1c21d201f108127304c8cbbfe3023d6`, built AFTER fb11d613.
- Final CLI `/tmp/opencode/a12/f2-final2-omni`, sha256 `e3a8a5dc317d97db4cd6fb89ebe6dfd209f7ff5100944a3576c480fe48602c86`, `cargo build --offline -p omni-cli` ALONE after fb11d613.
- Frozen binary sha256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`; red gateway `049c0bfc514f346df9101e25624dbb7110641540ec79a0c0ec480126ad9615a9`; red CLI `b3aff20fb69c984476118c6b3144c7c9d3ed120c58775908f4d44ca62da9d9b8` (supplied 63e0ae42 provenance, not rebuilt).
- Cargo serial/offline/jobs=2/incremental=0/debug=0 with private scratch HOME and CARGO_HOME=/home/homebrew/.cargo; df before builds stayed 14–15GiB free. Gateways ran in unshare -Urn with loopback; explicit scrubbed environments, every Bun invocation --no-env-file. Early scratch HOME was the pre-existing review scratch home; final commands use `/tmp/opencode/a12/f2-home`. Frozen apps/packages/bun.lock diff against 1780bb39 is empty. No stash, new dependencies, push/merge, real root/config access, or admin-routes corpus.
- Failed attempts retained: f2-build.exit=101 (ValueRef ownership/lifetime compile errors fixed by a79ac229); f2-http-green=1 before render acceptance; f2-http-cells=1 (new BLOB strategy render identity then listed); f2-cli-cells=1 (bare JSON.parse/type diagnostics then fixed in fb11d613). Initial 1200s CLI-suite wrapper timeout during wide and initial X3 wrapper timeout recorded as 143; their completed prior corpus exits preserved, reruns started with 3600000ms background commands. No flaky workspace rerun needed: named pinned-reader/WAL, pg-health reconciliation and admitted-drain tests all passed first final run.

### Final-HEAD gate commands (exit values read from .exit files)
- `cargo build --offline -p omni-gateway` — exit `0` (`f2-final2-build.exit`).
- `cargo build --offline -p omni-cli (ALONE)` — exit `0` (`f2-final2-cli-build.exit`).
- `bun --no-env-file conformance/e2e/models-dry-run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/gateway --out /tmp/opencode/a12/f2-final2-http-red` — exit `1` (`f2-final2-http-red.exit`).
- `bun --no-env-file conformance/e2e/models-dry-run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f2-final2-gateway --out /tmp/opencode/a12/f2-final2-http-green` — exit `0` (`f2-final2-http-green.exit`).
- `OMNI_CLI_BIN=/tmp/opencode/a12/omni python3 conformance/cli/models-dry-run.py` — exit `1` (`f2-final2-cli-red.exit`).
- `OMNI_CLI_BIN=/tmp/opencode/a12/f2-final2-omni python3 conformance/cli/models-dry-run.py` — exit `0` (`f2-final2-models-dry-run.exit`).
- `cargo test --offline --workspace` — exit `0` (`f2-final2-workspace.exit`).
- `cargo clippy --offline --workspace --all-targets -- -D warnings` — exit `0` (`f2-final2-clippy.exit`).
- `cargo fmt --all -- --check` — exit `0` (`f2-final2-fmt.exit`).
- `cargo test --offline -p omni-gateway --test dispatch_size` — exit `0` (`f2-final2-dispatch-size.exit`).
- `bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f2-final2-gateway` — exit `0` (`f2-final2-run-alone.exit`).
- `python3 <review cli-gaps/cli-probes/cli-plugin-valid/cli-plugin-loadable with only artifact/evidence paths redirected>` — exit `0` (`f2-final2-cli-probes.exit`).
- `python3 <exact-path/status assertion over reviewer rows.json using committed manifest>` — exit `0` (`f2-final2-classification.exit`).
- `bun --no-env-file /tmp/opencode/a12-review/probes.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f2-final2-gateway --out /tmp/opencode/a12/f2-final2-probes` — exit `0` (`f2-final2-probes.exit`).
- `bun --no-env-file /tmp/opencode/a12-review/probes2.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f2-final2-gateway --out /tmp/opencode/a12/f2-final2-probes2` — exit `0` (`f2-final2-probes2.exit`).
- `bun --no-env-file /tmp/opencode/a12-review/probes3.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f2-final2-gateway --out /tmp/opencode/a12/f2-final2-probes3` — exit `0` (`f2-final2-probes3.exit`).
- `bun --no-env-file /tmp/opencode/a12-review/rank.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f2-final2-gateway --out /tmp/opencode/a12/f2-final2-rank` — exit `0` (`f2-final2-rank.exit`).
- `bun --no-env-file /tmp/opencode/a12-review/live.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f2-final2-gateway --out /tmp/opencode/a12/f2-final2-live` — exit `0` (`f2-final2-live.exit`).

Workspace result: **1,351 passed, 37 ignored, 0 failed**; all three named flaky tests passed without rerun. run.ts alone: **49 pass rows**, exit 0; earlier combined X3/run wrappers did not reach run.ts before timeout, so `f2-final2-run-alone` is the authoritative inference gate. Fractional-expiry frozen source boundary check (now=1,1.499999,1.5,2; expiry=1.5) exactly matches predicate carrier: `bun --no-env-file -e <credentialExpired boundary check>` — exit `0` (`f2-expiry-boundary.exit`). Artifact provenance is also saved in `f2-final2-artifacts.json`.

Coverage remains deliberately bounded: no raw-JsValue router carrier; finite stored-cell/selected target tier/capability repros rather than arbitrary malformed JSON target object shapes, overflow arithmetic or exhaustive ranking numerical boundaries. No PostgreSQL, arbitrary plugin loading/transport parity, concurrency publication race, or finer-than-corpus rankedAt timing parity claimed. CLI JSON still parse-normalizes whitespace and HTTP compares content-type/parsed ordered JSON, not every transport header. Remaining visible rendering is ONLY the committed manifest class; plugin list remains out of scope. No unrelated product changes.

### Final six CLI gates completed
- `OMNI_CLI_BIN=/tmp/opencode/a12/f2-final2-omni python3 conformance/cli/stored-cells.py` — exit `0` (`f2-final2-stored-cells.exit`).
- `OMNI_CLI_BIN=/tmp/opencode/a12/f2-final2-omni python3 conformance/cli/neighbors.py` — exit `0` (`f2-final2-neighbors.exit`).
- `OMNI_CLI_BIN=/tmp/opencode/a12/f2-final2-omni python3 conformance/cli/neighbors-targeted.py` — exit `0` (`f2-final2-neighbors-targeted.exit`).
- `OMNI_CLI_BIN=/tmp/opencode/a12/f2-final2-omni python3 conformance/cli/wide.py` — exit `0` (`f2-final2-wide.exit`).
- `OMNI_CLI_BIN=/tmp/opencode/a12/f2-final2-omni python3 conformance/cli/extra.py` — exit `0` (`f2-final2-extra.exit`).
- `OMNI_CLI_BIN=/tmp/opencode/a12/f2-final2-omni python3 conformance/cli/quota-json.py` — exit `0` (`f2-final2-quota-json.exit`).
All six complete at fb11d613 with exit 0; copied full rows beneath f2-final2-*. stored-cells 1045 equal; neighbors 3806 (existing 6 exclusions, zero unexpected); neighbors-targeted 8 equal; wide 4236 equal; extra 180 equal; quota-json 196 (151 equal, existing 45 human-quota accepted, zero unexpected). X3 remains running; no success claimed yet.

### Final remaining gates completed
- `env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/a12/f2-final2-gateway python3 conformance/e2e/x3-operator.py` (inside unshare -Urn, loopback up) — exit `0` (`f2-final2-x3.exit`). Full results and summary copied to `f2-final2-x3-results.json` and `f2-final2-x3-summary.json`.
- `bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f2-final2-gateway` (inside same namespace) — exit `0` (`f2-final2-run.exit`).
All required final-HEAD gates have now completed; earlier pending notes are superseded by these results.

## f3 — round-2 numeric, human rendering and ordered acceptance repair (2026-11-17)

Worktree/branch unchanged; append-only commits. RED FIRST `1837ecb7` adds target numeric/cost and human stored-cell rows before product edits; final extra equal probes `17390203`. Frozen sources remain unchanged. No dependencies, router type changes, raw router carrier, strict reader changes, stash, push or merge.

### Findings and frozen checks
- Prices/nonfinite: `37cc5a2b` builds structural typed targets then assigns ToNumber f64 values directly (tier, weight, input, output, cacheRead); no JSON numeric round-trip. CacheRead null/absent retains frozen nullish input*0.1 fallback. `e37cff14`/`472ee013` repair pre-existing router cost predicate: frozen `ownCost <= 0` lets NaN reach ratio, while Rust's former `>0` wrongly assigned UNKNOWN, changing scores/order. Router types untouched. Frozen full score.ts + filters.ts read: arithmetic target inputs are tier, weight, costPerMTok.input/output/cacheRead; contextWindow, maxOutputTokens and cacheWrite5m/1h do not enter this dry-run request. Other arithmetic: credential weight; expiresAt versus now; health consecutiveFailures, openedAt, rateLimitedUntil; settings weights tier/health/quota/cost/latency/load, breakerThreshold/breakerCooldownMs/quotaPollIntervalMs; quota used/limit/resetsAt; request token estimates/maxTokens, runtime load/recent EWMA. Operator probe fixes maxTokens absent/load/recent absent/rand=0. Existing settings/quota/health projections unchanged.
- CLI score: `4b8e1db9`/`e37cff14` retains raw f64 score in the control JsValue result until serialization, implements exact-significand Number.toFixed(3), including NaN/Infinity/-Infinity and >=1e21 Number.toString behavior. JSON nonfinite still null.
- Echoes: `e37cff14` restores original selected target tier and raw credential label/id only in output, not router input: all new tier echoes now equal frozen (including null, '-0', [2], {}, 'oops', '1e400'). `f9a8054f` nevertheless enumerates the controller-approved NULL/'-0'/[2] HTTP, CLI JSON and precise human TIER-cell allowances, statuses 200/200 or 0/0; these new allowances are not used by final outputs. Existing seven entries retained.
- Raw human cells: shared table_text validation checks original credential label for ranked candidates and id for exclusions, before returning any stdout. Frozen models.ts constructs whole return string before printing. BLOB label exactly exit 1, empty stdout, original replace diagnostic + newline. Corpus adds human BLOB/number/NULL label/provider/id cells; provider corrupt cells produce no matching accounts, id BLOB/NULL candidates preserve raw JSON echo. Model/tier follow frozen projection; endpoint never appears in dry-run table. No plugin parity changes claimed.
- Acceptance: `f77fa945` compares insertion-ordered JSON after substituting only listed leaves, keeping status/stderr exact. Committed 7-case self-test rejects top-level and nested reorder, extra key, score/status/stderr changes, accepts only approved echo; reviewer CLI/HTTP six-case mutation drivers also rerun with CLI calling actual repaired checker.

### Red → green
Final corpora: 795 HTTP records (10 rejected constraints; 785 comparisons), 312 CLI records (14 rejected pairs; 298 actual comparisons). On fb11d613 supplied f2-final2 binaries, HTTP 26 unexpected / 9 accepted, CLI 65 unexpected / 9 accepted. Final counts and commands follow below. Earlier attempts retained: f3-http-green1 failed because initial gateway copy used wrong binary name; f3-cli-green1 exposed NaN cost predicate and NaN text; f3-final-clippy exit 101 identified collapsible_if, fixed in final style commit. No gate failures hidden.

### Isolation / scope
All actual work from designated worktree; own HOME `/tmp/opencode/a12/f3-home`, scratch/evidence `f3-*`, scrubbed explicit environments and Bun --no-env-file. Gateways namespaced; copied reviewer drivers only change artifact/evidence paths (CLI mutation driver switched to actual ordered checker). Six CLI drivers copied to private evidence directory to relocate their original shared scratch paths. X3 likewise relocates scratch only. `cargo --offline`, jobs=2, incremental=0/dev+test debug=0, CARGO_HOME fixed, one cargo command at a time; disk remained >=11 GiB. No admin-routes.

Bounded coverage: no PostgreSQL, arbitrary plugin loading/transport, malformed target structural getter semantics, exhaustive numeric/locale/PTY/concurrency sweep. Canonical CLI JSON still masks whitespace; parsed key order is enforced. No claim that dry-run predicts live load/smart routing.

Additional raw-model check: frozen number/NULL target model human returns exact table error, JSON succeeds; `3e4ff33f` converts only typed routing identity while restoring raw model on candidate/exclusion output, and adds number/NULL/object model cells. Initial isolated probe is f3-cli-model.log/rows (red before this commit). Final corpus adds six more CLI pairs.
Operational disclosure: an intermediate gateway build was inadvertently started while the previous background workspace gate still held Cargo's lock; Cargo serialized actual compilation. No simultaneous compilation occurred, but this was not the requested one-Cargo-invocation discipline. Final gates are scheduled sequentially after the background gate completes.

Intermediate supplemental probes2 startup timeout is retained under f3-final-probes2.log; later standalone namespace rerun required. Intermediate f3-last workspace/clippy/fmt/dispatch all checked separately; authoritative final-head runs use f3-end prefix.

Raw-cell review source: output.table width and line both use text.replace; no partial output because the command computes header/candidates/excluded before returning. label raw, model raw, exclusion credentialId/model/reason raw; candidate tier explicitly String, candidate index String, score toFixed; provider paint returns id unchanged without color. Corrupt provider/account IDs in corpus do not become candidate raw provider cells unless exact serving identities match. Target model number/null/object cases now JSON-success and exact human failure (whole stdout empty).

Final round-2 more.ts: all 31 pairs equal (includes original 14 HTTP findings). cli-more six equal, cli-numbers six equal; cli-render three equal and one JSON BLOB strategy manifest-accepted. Round-1 probes 28 pairs with one manifest BLOB strategy; probes2 28 pairs equal + eight rejected-update records; probes3 14 pairs equal + two rejected-update records. No plugin probes were changed or newly rerun in f3: prior plugin exclusions remain limitations rather than new success claims.

At this checkpoint, final HEAD `3e4ff33f884d9260f91b0560a152e1b2d1b65d69` has HTTP 795 / 2 accepted / 0 unexpected and CLI 312 / 2 accepted / 0 unexpected. Workspace 1,351 passed, clippy/fmt/dispatch exit 0. The three named flaky tests passed first final attempt. Six final-head CLI suites and X3 remain running; no success is claimed yet. Their completion details will be appended below.

Intermediate six CLI suites all exit 0 (f3-final-*.exit); final-head repeats remain pending. First X3 scratch-relocated attempt exit 1 (`f3-final-x3.exit`) due copied driver resolving its adjacent acceptance manifest under /tmp/opencode/a12. Fixed ONLY copied-driver acceptance path to original committed x3-accepted.json; standalone final-head retry is `f3-x3-retry`, pending. No X3 product difference inferred from setup failure.

Controller correction: scratch-relocated X3 is supplemental only. It completed 4,106 pairs / 3,997 equal / 109 pre-existing accepted / zero unexpected; `f3-x3-retry.exit` is 0. The actual gate is now running the unchanged committed `conformance/e2e/x3-operator.py` from the worktree root at `3e4ff33f`; evidence `f3-x3-committed.log` and command-labelled `f3-x3-committed.exit`. No additional product changes.

Final-head six CLI corpora completed: stored-cells 1,045, neighbors 3,806 (six existing exclusions), neighbors-targeted eight, wide 4,236, extra 180, quota-json 196 (45 existing human-quota accepted); zero unexpected, all exits 0 (`f3-end-{stored-cells,neighbors,neighbors-targeted,wide,extra,quota-json}.exit`). CLI was built alone after final commit. Copied-driver X3 from the long wrapper also exits 0 but remains supplemental only. Committed-driver X3 still pending.

### f3 final gate completion

### Final artifacts and verification

Final HEAD `3e4ff33f884d9260f91b0560a152e1b2d1b65d69`; binaries built AFTER this commit; CLI built ALONE.

````text
b39a5b331266e1c003d0332f73e719aca12f55742509d1ab4f74c19cc5233e89  /tmp/opencode/a12/f3-end-gateway
08b2993de2ad73f2f8fcc20b812446324bd108188099cf20930028f929f617d5  /tmp/opencode/a12/f3-end-omni
````
- `cargo build --offline -p omni-gateway` — exit `0` (`f3-end-build.exit`).
- `cargo build --offline -p omni-cli (ALONE)` — exit `0` (`f3-end-cli-build.exit`).
- `cargo test --offline --workspace` — exit `0` (`f3-end-workspace.exit`).
- `cargo clippy --offline --workspace --all-targets -- -D warnings` — exit `0` (`f3-end-clippy.exit`).
- `cargo fmt --all -- --check` — exit `0` (`f3-end-fmt.exit`).
- `cargo test --offline -p omni-gateway --test dispatch_size` — exit `0` (`f3-end-dispatch.exit`).
- `bun --no-env-file conformance/e2e/models-dry-run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f3-end-gateway --out /tmp/opencode/a12/f3-end-http` — exit `0` (`f3-end-models-dry-run.exit`).
- `OMNI_CLI_BIN=/tmp/opencode/a12/f3-end-omni python3 conformance/cli/models-dry-run.py` — exit `0` (`f3-end-cli.exit`).
- `bun --no-env-file conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f3-end-gateway (namespace; alone)` — exit `0` (`f3-end-run.exit`).
- `env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/a12/f3-end-gateway python3 conformance/e2e/x3-operator.py (namespace)` — exit `env -i PATH=/usr/bin:/bin OMNI_TS_BIN=/tmp/opencode/a8/ts OMNI_GATEWAY_BIN=/tmp/opencode/a12/f3-end-gateway python3 conformance/e2e/x3-operator.py: 0` (`f3-x3-committed.exit`).
- `python3 /tmp/opencode/a12/f3-classify.py` — exit `0` (`f3-end-classify.exit`).
- `python3 conformance/cli/models-dry-run-mutations.py` — exit `0` (`f3-end-mutations.exit`).
- `OMNI_CLI_BIN=/tmp/opencode/a12/f3-end-omni python3 /tmp/opencode/a12/f3-suites/stored-cells.py (scratch-relocated conformance/cli driver)` — exit `0` (`f3-end-stored-cells.exit`).
- `OMNI_CLI_BIN=/tmp/opencode/a12/f3-end-omni python3 /tmp/opencode/a12/f3-suites/neighbors.py (scratch-relocated conformance/cli driver)` — exit `0` (`f3-end-neighbors.exit`).
- `OMNI_CLI_BIN=/tmp/opencode/a12/f3-end-omni python3 /tmp/opencode/a12/f3-suites/neighbors-targeted.py (scratch-relocated conformance/cli driver)` — exit `0` (`f3-end-neighbors-targeted.exit`).
- `OMNI_CLI_BIN=/tmp/opencode/a12/f3-end-omni python3 /tmp/opencode/a12/f3-suites/wide.py (scratch-relocated conformance/cli driver)` — exit `0` (`f3-end-wide.exit`).
- `OMNI_CLI_BIN=/tmp/opencode/a12/f3-end-omni python3 /tmp/opencode/a12/f3-suites/extra.py (scratch-relocated conformance/cli driver)` — exit `0` (`f3-end-extra.exit`).
- `OMNI_CLI_BIN=/tmp/opencode/a12/f3-end-omni python3 /tmp/opencode/a12/f3-suites/quota-json.py (scratch-relocated conformance/cli driver)` — exit `0` (`f3-end-quota-json.exit`).
- `bun --no-env-file /tmp/opencode/a12/f3-review/more.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f3-end-gateway --out /tmp/opencode/a12/f3-end-more (namespace)` — exit `0` (`f3-end-more.exit`).
- `bun --no-env-file /tmp/opencode/a12/f3-review/probes.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f3-end-gateway --out /tmp/opencode/a12/f3-end-probes (namespace)` — exit `0` (`f3-end-probes.exit`).
- `bun --no-env-file /tmp/opencode/a12/f3-review/probes2.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f3-end-gateway --out /tmp/opencode/a12/f3-end-probes2 (namespace)` — exit `0` (`f3-end-probes2.exit`).
- `bun --no-env-file /tmp/opencode/a12/f3-review/probes3.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f3-end-gateway --out /tmp/opencode/a12/f3-end-probes3 (namespace)` — exit `0` (`f3-end-probes3.exit`).
- `bun --no-env-file /tmp/opencode/a12/f3-review/rank.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f3-end-gateway --out /tmp/opencode/a12/f3-end-rank (namespace)` — exit `0` (`f3-end-rank.exit`).
- `bun --no-env-file /tmp/opencode/a12/f3-review/live.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f3-end-gateway --out /tmp/opencode/a12/f3-end-live (namespace)` — exit `0` (`f3-end-live.exit`).
- `python3 /tmp/opencode/a12/f3-review/cli-more.py` — exit `0` (`f3-end-cli-more.exit`).
- `python3 /tmp/opencode/a12/f3-review/cli-numbers.py` — exit `0` (`f3-end-cli-numbers.exit`).
- `python3 /tmp/opencode/a12/f3-review/cli-render.py` — exit `0` (`f3-end-cli-render.exit`).
- `python3 /tmp/opencode/a12/f3-review/mutation-cli.py` — exit `0` (`f3-end-mutation-cli.exit`).
- `bun --no-env-file /tmp/opencode/a12/f3-review/mutation-http.ts` — exit `0` (`f3-end-mutation-http.exit`).
- RED `bun --no-env-file conformance/e2e/models-dry-run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a12/f2-final2-gateway` — exit `1` (`f3-final-http-red.exit`).
- RED `OMNI_CLI_BIN=/tmp/opencode/a12/f2-final2-omni python3 conformance/cli/models-dry-run.py` — exit `1` (`f3-end-cli-red.exit`).

Final corpus/reviewer summaries (collector exits are not parity claims; independent classification asserts exact manifest/status/path matches):

```text
models-dry-run: {"rows":795,"accepted":2,"failures":0,"work":"/tmp/opencode/a12/f3-end-http/run-D196RC"}
cli: {"cases": 312, "accepted": 2, "failures": 0, "work": "/tmp/opencode/a12/f3-cli/tmp7ic6e47e"}
more: {"rows":31,"failures":0,"work":"/tmp/opencode/a12/f3-end-more/run-1fLom9"}
probes: {"rows":28,"failures":1,"work":"/tmp/opencode/a12/f3-end-probes/run-qZE4tp"}
probes2: {"rows":36,"failures":8,"work":"/tmp/opencode/a12/f3-end-probes2/run-0AClA7"}
probes3: {"rows":16,"failures":0,"work":"/tmp/opencode/a12/f3-end-probes3/run-55ylDn"}
rank: {"rows":318,"failures":0,"work":"/tmp/opencode/a12/f3-end-rank/run-P8zyGm"}
cli-more: {"cases": 6, "failures": 0}
cli-numbers: {"cases": 6, "failures": 0}
cli-render: {"cases": 4, "failures": 1}
classify: {"differences": 2, "manifest": 2, "unexpected": 0}
x3: {"pairs": 4106, "equal": 3997, "accepted": {"routing-strict": 94, "v1-models-frozen-json": 15}, "unexpected": 0}
```

Six CLI gates (last summary lines; full rows retained at paths printed by each driver):

```text
stored-cells: cell {} | column {} | EXIT HISTOGRAM stored-cells {"exit 0": 734, "exit 1": 256, "exit 2": 55}
neighbors: Counter({'extra-commands': 6}) | evidence /tmp/opencode/a12/f3-suites/neighbors-4xmcy13f pairs 3806 failing 0 excluded {'random-create': 2, 'unimplemented-credentials': 4} | EXIT HISTOGRAM neighbors {"exit 0": 2778, "exit 1": 1026, "exit 2": 2}
neighbors-targeted: {"sql": "UPDATE api_keys SET label=1", "args": ["keys", "list", "--json"], "ts": {"code": 0, "out": "7b0a2020226b657973223a205b0a202020207b0a202020202020226964223a20226b222c0a202020202020226c6162656c223a20312c0a20202020202022707265666978223a202270222c0a202020202020226d6f64656c416c6c6f776c697374223a206e756c6c2c0a202020202020226c696d697473223a207b7d2c0a202020202020226c696d69745573616765223a205b5d2c0a20202020202022626f64794c6f6767696e674f70744f7574223a2066616c73652c0a20202020202022637265617465644174223a20312c0a202020202020227265766f6b65644174223a206e756c6c2c0a20202020202022657870697265734174223a206e756c6c2c0a2020202020202267756172647261696c506f6c696379223a206e756c6c2c0a20202020202022736d617274526f7574696e67223a2066616c73650a202020207d0a20205d0a7d0a", "err": "", "unchanged": true}, "rust": {"code": 0, "out": "7b0a2020226b657973223a205b0a202020207b0a202020202020226964223a20226b222c0a202020202020226c6162656c223a20312c0a20202020202022707265666978223a202270222c0a202020202020226d6f64656c416c6c6f776c697374223a206e756c6c2c0a202020202020226c696d697473223a207b7d2c0a202020202020226c696d69745573616765223a205b5d2c0a20202020202022626f64794c6f6767696e674f70744f7574223a2066616c73652c0a20202020202022637265617465644174223a20312c0a202020202020227265766f6b65644174223a206e756c6c2c0a20202020202022657870697265734174223a206e756c6c2c0a2020202020202267756172647261696c506f6c696379223a206e756c6c2c0a20202020202022736d617274526f7574696e67223a2066616c73650a202020207d0a20205d0a7d0a", "err": "", "unchanged": true}} | {"sql": "UPDATE virtual_models SET targets='[null]'", "args": ["models", "put", "v", "-f", "/tmp/opencode/a12/f3-suites/neighbors-ks5vvyd1/fixture/model.json"], "ts": {"code": 1, "out": "", "err": "6e756c6c206973206e6f7420616e206f626a65637420286576616c756174696e6720277461726765742e70726f766964657227290a", "unchanged": true}, "rust": {"code": 1, "out": "", "err": "6e756c6c206973206e6f7420616e206f626a65637420286576616c756174696e6720277461726765742e70726f766964657227290a", "unchanged": true}} | {"sql": "UPDATE virtual_models SET id=1", "args": ["models", "rm", "1", "--yes"], "ts": {"code": 1, "out": "", "err": "4d4f44454c5f554e415641494c41424c453a206e6f207669727475616c206d6f64656c202231220a", "unchanged": true}, "rust": {"code": 1, "out": "", "err": "4d4f44454c5f554e415641494c41424c453a206e6f207669727475616c206d6f64656c202231220a", "unchanged": true}}
wide: Counter() | evidence /tmp/opencode/a12/f3-suites/wide-pxpxh03f pairs 4236 failing 0 | EXIT HISTOGRAM wide {"exit 1": 1202, "exit 0": 3034}
extra: Counter() | evidence /tmp/opencode/a12/f3-suites/extra-5otawxa5 pairs 180 failing 0 | EXIT HISTOGRAM extra {"exit 0": 98, "exit 1": 82}
quota-json: evidence /tmp/opencode/a12/f3-suites/r6-quota-5297rxik pairs 196 classes {'equal': 151, 'human-quota': 45} failing 0 | EXIT HISTOGRAM quota-json {"exit 0": 196}
```

Workspace passed tests: 1351. Named flaky tests all passed in the final log; no rerun needed unless documented below.

Remaining differences: two manifest-only observations (HTTP BLOB strategy in round-1 probes, JSON CLI BLOB strategy); tier and BLOB label now exact. Supplemental live calls both 503; dry both 200 and identical. Rank matrix 318 equal. Plugin behavior unchanged/excluded, not claimed repaired. No other remaining difference in executed corpora. Final working tree status: `` (empty means clean).

All f3 pending checkpoints above are superseded: the COMMITTED X3 gate completed with exit 0, 4,106 pairs, 3,997 equal, 109 existing accepted and zero unexpected. Full committed-driver results/summary copied to `f3-x3-committed-results.json` and `f3-x3-committed-summary.json`; original isolated evidence `/tmp/opencode/x3/operator-44h0fpcp`. Final HEAD remains clean `3e4ff33f884d9260f91b0560a152e1b2d1b65d69`. All requested gates complete; no remaining review finding in executed corpora.
