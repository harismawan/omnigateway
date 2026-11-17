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
