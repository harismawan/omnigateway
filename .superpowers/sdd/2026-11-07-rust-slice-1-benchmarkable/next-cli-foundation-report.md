# Rust CLI foundation + keys list — 2026-11-10

## Fix round 3 — data-only object coercion

Implementation `58333799`, base `26912423`. R2-I1 addressed: iterative human join is fallible. JSON objects with an own `toString` cannot supply a callable method; own JSON `valueOf` is also noncallable, and inherited valueOf returns the object. Such elements return `No default value` before printing the assembled table. Objects without own toString retain inherited object rendering, including own valueOf and JSON __proto__ data properties. JSON serialization, parser, gateway admission and prior overflow/depth behavior are unchanged.

RED command: `OMNI_CLI_COLLECT_RED=1 OMNI_CLI_BIN=target/release/omni bun conformance/cli/keys-list.ts` against prior release: **8/135 differential failures**, all human coercion cases; local `/tmp/opencode/cli-r3-red.log`. Mandatory oracle covers direct/nested objects, scalar/null/object/array toString, own valueOf combinations, duplicate properties, and an earlier 1500-deep key followed by an error key. Each is checked in human and JSON modes against unchanged TS, including empty stdout on failure.

GREEN actual commands/output:
```
OMNI_CLI_BIN=target/release/omni bun conformance/cli/keys-list.ts
PASS 135 real TS/Rust golden comparisons
OMNI_CLI_BIN=target/release/omnigateway OMNI_CLI_SUBCOMMAND=1 bun conformance/cli/keys-list.ts
PASS 135 real TS/Rust golden comparisons
OMNI_CLI_BIN=target/release/omnigateway OMNI_CLI_SYMLINK=1 bun conformance/cli/keys-list.ts
PASS 135 real TS/Rust golden comparisons
```
`cargo test -p omni-control -p omni-ir -p omni-cli --lib`: **control2 + IR18 pass**, CLI0 (CLI covered by 405 process comparisons). Added 256KiB-stack test exercises 20k-deep object ownership/duplicate replacement/error teardown and KeyListing pretty output with an earlier deep array and later coercion failure. Previous deep overflow small-stack test remains passing.

`cargo clippy -p omni-control -p omni-ir -p omni-cli --all-targets -- -D warnings`, `cargo fmt --all -- --check`, scoped Biome, `git diff --check`, and release builds pass. No latency rerun: change is confined to human coercion; measured JSON listing path is unchanged. Round2 timing/hash remain evidence for the round2 binary only, not a fresh measurement of this release build. Existing public projection invariant maintenance concerns and platform/PTY/filesystem gaps remain; controller owns independent scoped re-review.

## Fix round 2 — residual operator JSON

Implementation `2033a4db`, base `848f918f`. R1-I1 and noncallable-own-join diagnostic addressed. Operator-only parser validates with existing JSC diagnostics, then constructs existing `JsValue` with an explicit container stack. IEEE overflow survives as ±Infinity until the JSON writer emits null; human array join uses an explicit traversal stack. Existing stack-growing JsValue clone/serialization and iterative destruction handle deep ownership. Gateway parsing/normalized key reads are unchanged. String decoding retains the existing documented surrogate replacement exception.

RED command: `OMNI_CLI_COLLECT_RED=1 OMNI_CLI_BIN=target/release/omni bun conformance/cli/keys-list.ts` against prior release: **14/105 failures**, local `/tmp/opencode/cli-r2-red.log`. Cases include signed/exponent overflow, depths 127/128/150/512/1500, and own join scalar values. Final goldens also include finite/overflow f64 boundaries, huge positive exponent, underflow/subnormal, duplicate join properties, and object/array diagnostic values.

GREEN: **113 raw-byte TS comparisons per entrypoint**, standalone, unified subcommand, unified symlink (339 total):
```
OMNI_CLI_BIN=target/release/omni bun conformance/cli/keys-list.ts
OMNI_CLI_BIN=target/release/omnigateway OMNI_CLI_SUBCOMMAND=1 OMNI_CLI_BENCH=1 bun conformance/cli/keys-list.ts
OMNI_CLI_BIN=target/release/omnigateway OMNI_CLI_SYMLINK=1 bun conformance/cli/keys-list.ts
```
`cargo test -p omni-cli -p omni-control -p omni-ir --lib`: control 1 / IR 18 pass (CLI zero unit tests; process goldens cover CLI). New small-stack test parses, clones, coerces, serializes and drops a **20,000-level** overflow-containing array on a 256KiB thread stack. Strict all-target clippy for CLI/control/IR, workspace fmt, scoped Biome, diff check and release builds pass.

Repeated unified release latency p50 **1.777 / 1.829 / 1.722 ms**, max **3.038 ms**, 30/30 below 15ms. Same warm seeded fixture/spawn-drain-exit-parse method. SHA256 `80418f13c3c507f9ab9e5b7d67bfdfd1255cb5f5f32912d16784415297456d88`, sources `2033a4db`. Raw artifact `/tmp/opencode/cli-r2-latency.json`.
```
1.994378 2.913158 1.694028 1.822364 1.899214 1.777469 1.784865 1.628368 1.681260 1.709187
1.582503 1.672940 1.938131 2.736467 3.037602 1.896007 1.686682 1.732825 2.265752 1.828784
1.816632 1.879637 1.721966 1.670848 1.676116 1.858539 1.838950 1.697996 1.648429 1.772719
```
Maintenance concern retained: public `OperatorKey.key` still contains auth-shaped placeholder fields; current operator projection uses raw fields correctly, but a dedicated non-auth metadata type would reduce future misuse risk. PTY/platform/exhaustive filesystem and independent migration-fixture coverage remain outstanding. No unsafe, frozen TS, gateway parser/admission changes or new commands. Controller owns scoped re-review; no full migration readiness claim.

## Fix round 1 — 2026-11-10

Implementation `0ec7ed9b`, base `aa41493d`. All four Important findings addressed in the implemented keys-list scope:

- I1: safe standard-library `std::env::home_dir()` supplies platform account fallback when HOME is absent. Actual subprocess regression unsets HOME, places misleading `.config/omnigateway/.env` under a non-installation cwd, and supplies an absolute database. No home files modified.
- I2: separate store operator projection preserves raw allowlist JSON and numeric dates; gateway normalized/fail-closed reader remains unchanged. Mixed arrays, nested arrays, objects, scalars, empty strings, length-zero objects and malformed JSON tested in both formats. Shared JSC diagnostics moved unchanged from gateway into IR, with gateway compatibility re-export; operator empty JSON uses JSON.parse EOF wording, preserving gateway Request.json empty-body behavior. Hash stays excluded.
- I3: public own-entry traversal wraps the existing JS ordering implementation and is used before assembling usage arrays/human summaries. Goldens include z/10/2/4294967295/4294967294/01 model names.
- I4: full JS Date range uses Gregorian civil-day arithmetic, TimeClip truncation, four/signed-six-digit years and exact ISO slice(0,19). Goldens cover 10000, negative year, both ±8.64e15 boundaries, both out-of-range neighbors, zero, negative milliseconds and fractional stored time.
- Local minors: short -yh/-hy accepted without triggering standalone help scan; THP policy precedes argv allocation; width removes only TS SGR syntax; config docs distinguish gateway and CLI env handling.

Evidence:
- Before fixes, expanded mandatory real-TS oracle against prior release recorded **45/71 differential failures**, including all Important findings (local `/tmp/opencode/cli-round1-red.log`). Initial mixed-array failure also observed separately. No expected-output renderer introduced.
- Final **85 raw-buffer stdout/stderr/status comparisons pass each** for standalone release, unified subcommand, and unified argv[0] symlink: 255 comparisons. TS sources unchanged. CLI/control behavior is verified by these process goldens (their library test targets contain zero unit tests).
- IR library 18 pass, including moved JSC message tests; store snapshot rows 4 + usage reads 2 pass. Usage differential now includes sumSince across 42 cases: exact partial/hour boundaries, cross-key exclusion, model narrowing, pending rows and zero windows, with rollup rebuilt from committed rows.
- Gateway config 2 pass (1 child probe intentionally ignored); gateway server/startup suite **32 pass**, including invalid JSON response, failed boot/restart and shutdown paths.
- Strict all-target clippy for CLI/control/store/IR/gateway-core/gateway passes; workspace fmt, scoped Biome and diff whitespace checks pass. Release build passes.

Repeated unified release scoped latency (same rig/method, three batches of ten): p50 **1.805 / 1.774 / 1.689 ms**, maxima **2.250 / 3.284 / 2.527 ms**. All samples below 15 ms. Binary SHA256 `5e8713bd1d3916ae384e8c02c4091a1af9cea27bd5be0f6605c7b484bccc3ae5`; built from the implementation sources in `0ec7ed9b` (subsequent precommit changes were comments and additional tests only). Raw artifact `/tmp/opencode/cli-round1-latency.json`.

Raw timings ms:
```
2.056999 1.817920 2.085282 1.804619 1.587776 2.249891 1.935511 1.747055 1.779192 1.625466
1.740078 1.757117 1.774352 2.895653 1.731896 3.283935 2.739610 1.692803 1.794355 1.936948
1.739956 1.677819 1.603728 1.720716 1.503975 2.527195 1.688683 1.687192 1.834926 1.692566
```

Remaining coverage: PTY/platform matrix and exhaustive filesystem failures remain untested; shared sequential migration fixtures remain a limitation. Existing IR handling of lone surrogates/astral diagnostic characters retains its previously documented limitation. Other CLI commands remain unported; scoped independent re-review belongs to controller. This section supersedes the original HOME/allowlist/date/symlink limitations below. No full gateway benchmark or migration readiness claim.

Implementation: `75ad6215`, base `a435d55b`. Astra implementer; independent review belongs to controller.

## Completed increment

- New `omni-cli` library and standalone development `omni` binary. Release binary dispatches `omnigateway omni ...` or argv[0] `omni` before allocating a Tokio runtime or loading gateway state.
- New lower-layer `omni-control`: shared config moved verbatim from gateway-core (compatibility re-export retained), and public key summaries. No gateway dependency from CLI. Existing SQLite migrations/key/limits readers reused; existing JS JSON writer supplies pretty JSON and JS numbers.
- `keys list`: empty/populated human and JSON output; hash excluded; allowlists, limits/unreadable limits, model overrides, committed usage, opt-out, policy, smart routing, active/revoked/expired states and dates.
- Store `sum_since`: per-model log seek; key-wide whole-hour rollup plus partial-hour log edge; excludes pending log rows. Distinct windows read once per scope.
- Root flag → OMNI_ROOT → installation cwd → HOME/.config/omnigateway; root `.env` overrides ambient values, literal quotes/no expansion; ambient database suppression warning; relative/blank/explicit database flags; full existing configuration validation.
- Relevant parser: leading/trailing globals, equals form, repeated flags, short `-y` clusters, `--` terminator, ignored positionals (TS does this), help/version pre-scan, unknown/missing/ambiguous/boolean-value error text and status 2. Operator failures status 1. `--system` deliberately rejected for this command, matching actual TS despite global help advertising it.
- Encryption config remains mandatory. Listing does not read encrypted credentials, so KDF is deferred rather than paying for an unused field key. No new crypto implementation or secret exposure.

## RED / GREEN and verification

Mandatory oracle: `conformance/cli/keys-list.ts` spawns the unchanged TS entrypoint with `bun --no-env-file`, and the Rust binary. Compares stdout/stderr/status byte-for-byte; expected formatting is never reconstructed in tooling. TS store/migrations seed disposable SQLite roots. This includes nonzero usage in multiple windows/models, pending and out-of-window traffic, unreadable limits, Unicode labels, tiny JS numbers, root/env precedence, parser and config failures.

- RED: initial scaffold returned exit 1 / `CLI not implemented`, while real TS returned exit 0 / `no api keys; create one with: omni keys create`.
- Second RED: missing database parent returned a path-bearing rusqlite error versus TS's `unable to open database file`; fixed by matching SQLite CannotOpen.
- GREEN: **35 comparisons** against standalone release; **35** against unified release subcommand.
- `cargo test -p omni-gateway-core --test config`: 2 pass, 1 child-probe intentionally ignored (executed by parent test). Includes real TS full-config parity after move.
- `cargo test -p omni-store --test usage_reads`: 2 pass.
- `cargo clippy -p omni-cli -p omni-control -p omni-store -p omni-gateway-core -p omni-gateway --all-targets -- -D warnings`: pass.
- `cargo fmt --all -- --check`, `git diff --check`, scoped Biome check: pass.
- `cargo build --release -p omni-cli -p omni-gateway`: pass.

Reproduce golden: `OMNI_CLI_BIN=target/release/omnigateway OMNI_CLI_SUBCOMMAND=1 bun conformance/cli/keys-list.ts`.

## Latency evidence

Same i5-13400 KVM rig, Linux x86_64, allowed CPUs 0–7 (CLI was not pinned separately). Like bench-gateway's CLI timing: Bun spawn → drain stdout/stderr → await exit → parse JSON, seeded SQLite, ten invocations per batch. Three repeated batches, warm filesystem; no gateway benchmark rerun. Fixture has three keys with a larger matrix than the two-key baseline, four history rows, one marked pending. This is scoped CLI evidence, not a replacement for full migration acceptance.

Command: `OMNI_CLI_BIN=target/release/omnigateway OMNI_CLI_SUBCOMMAND=1 OMNI_CLI_BENCH=1 bun conformance/cli/keys-list.ts`.

Unified binary SHA256: `432b017548c2cde0dd3801d78da506573855012ea6da278d06f03c72ade51a33`; code in `75ad6215` (built before committing the identical Rust sources).

| Batch | p50 ms | max ms |
|---|---:|---:|
| 1 | 1.725 | 2.990 |
| 2 | 1.728 | 3.301 |
| 3 | 1.700 | 2.278 |

All 30 samples below 15 ms. Raw ms samples:

```
1.981199 2.973170 1.825924 1.587615 1.579180 1.724757 1.673149 2.990295 2.805167 1.682105
1.614386 3.300958 1.755848 2.779191 1.770805 1.687858 1.763703 1.728087 1.590141 1.700084
1.681246 1.699638 1.867538 2.277635 1.703053 1.611985 1.619082 1.845269 1.719592 1.654524
```

Earlier standalone measurement: p50 1.421/1.387/1.358 ms; max 2.629/2.137/2.066 ms. SHA256 `4203c8e18adc408e92c1fe47161e5860eb65fc3a9f9fbe521a3233af595f990c`. Target was met without phase profiling/optimization. Raw machine-precision logs locally in `/tmp/opencode/cli-latency-{standalone,unified,final}.json` (last line is pass summary, not JSON).

## Remaining scope / concerns

- **Only keys list is ported.** Every mutation, credentials/connect, model management, usage/quota, service/process, settings/admin/db, setup and plugin command remains unported. Other invocations fail with unknown-command status 2, never a successful operation stub. Plugin-specific unsupported-release status 1 is still future work.
- Top-level help intentionally describes this increment; full TS registry/help is not ported. Command-specific keys-list help/version match. No full CLI readiness claim.
- Color rendering is implemented but subprocess goldens are non-TTY; PTY golden coverage remains. argv[0] dispatch needs packaging/symlink coverage beyond the subcommand goldens.
- Hand-corrupted arbitrary model-allowlist types and invalid JSON still inherit gateway-oriented store coercion/error differences; tested corrupt limits degrade identically. Date rendering uses chrono: extreme valid JS dates beyond chrono's range are not yet byte-compatible. File-read/other SQLite failure diagnostics beyond CannotOpen are not exhaustive goldens.
- Full CLI parser vocabulary grows with each command; known-command help/dispatch is currently only keys list. HOME-unset platform home lookup is not yet implemented.
- Admin API/WebSocket/background features, remaining migration scope and release packaging remain controller-owned work. No full acceptance or independent review claimed.
- Frozen TS sources, unrelated bun.lock/user specs, and stash untouched; no unsafe, subagents, push or merge.
