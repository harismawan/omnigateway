# CLI stored-cell re-review — REQUEST CHANGES

Reviewed `21348e06..e820b9da8115f435daf8e7ee9cd698c86a274ccc` independently. Evidence directory **`/tmp/opencode/cli-fix2-review/`**; filenames below are relative to it. No product edits, commits, or subagents. Existing dirty e1-e5-report.md left untouched.

## Earlier findings

| Finding | Disposition | Evidence |
|---|---|---|
| F1 credential JSON cell coercion | **Closed for the reported bug** | Original corpus independently 1,045/1,045 equal. Additional numeric/BLOB/invalid-UTF8 probes 1,404/1,404 equal, including status/setup/model writes. `cli_cell` implements JSON.parse input coercion, not raw BLOB parsing. |
| F2 setup whole-credential parse/order | **Closed for the reported bug** | Models then all credentials read before description. First/middle/last failing credential and simultaneous model+credential failures: 30/30 equal, all stdout empty; model parse error wins when both fail. Additional multirow cases24/24 equal. Nested target handling still fails separately below. |
| F3 operator-cell parity | **Not closed as a general parity claim** | All original141 mismatches fixed, but new model projection stringifies non-string identities/strategies and mishandles REAL flags; adjacent key metadata remains strict. Findings N1/N2/N4. |
| M1 inherited OMNI guard | **Closed for accidental inherited uppercase OMNI configuration** | TS/Python guards reject six tested uppercase names, allow only explicit opt-in, reject wrapper injection. Parent/current dotenv disabled by mandatory `--no-env-file`. Not a filesystem sandbox; qualifications below. |
| M2 pycache | **Closed** | `git check-ignore conformance/cli/__pycache__/example.pyc` identifies committed local ignore. |

## Findings (Important)

Reproductions use the affinity-free tables and deterministic seed in `neighbors.py`/`targeted.py`: key k, credential q, model v with `targets=[]`, `strategy='weighted'`. Primary keys retained. Every command has `--root <evidence fixture>`; TS runs `bun --no-env-file apps/cli/src/index.ts`, Rust uses copied own-build binary. Exact complete streams, SQL, argv, and per-side DB hashes/dumps are in `neighbors.json`, `neighbor-differences.md`, and `targeted.md`; no output masks.

### N1 — model scalar coercion changes identity and success/refusal
Rust `crates/omni-control/src/models.rs:22–42` coerces ID/strategy to strings; frozen `packages/store/src/sqlite/config.ts:71–74` preserves cells, and `packages/control/src/models.ts:18` uses strict equality.
- SQL `UPDATE virtual_models SET id=1`; command `models show 1 --json`: TS `(stdout="", stderr="MODEL_UNAVAILABLE: no virtual model \"1\"\n", exit=1)`; Rust `(stdout="{\n  \"model\": {\n    \"id\": \"1\",\n    \"targets\": [],\n    \"strategy\": \"weighted\",\n    \"isAlias\": false\n  }\n}\n", stderr="", exit=0)`.
- Same SQL, `models rm 1 --yes`: TS `("", "MODEL_UNAVAILABLE: no virtual model \"1\"\n", 1)`; Rust `("1 removed\n", "", 0)`. **Both DBs remain byte-identical to before**: Rust falsely reports removal of a row it did not delete.
- SQL `UPDATE virtual_models SET strategy=NULL`; command `models list --json`: both exit0/stderr empty; full outputs in targeted.md, differing value is TS `"strategy": null` versus Rust `"strategy": "null"`. Numeric/BLOB identities and strategies also differ. Preserve SQLite JS value types outside the actual JSON.parse input.

### N2 — REAL 1 is wrongly excluded from isAlias
SQL `UPDATE virtual_models SET is_alias=1.0`; command `models list --json`. TS stdout `"{\n  \"models\": [\n    {\n      \"id\": \"v\",\n      \"targets\": [],\n      \"strategy\": \"weighted\",\n      \"isAlias\": true\n    }\n  ]\n}\n"`; Rust same bytes except `false`; both stderr empty/exit0. Frozen `sqlite/config.ts:75` tests JS Number `=== 1`; new Rust `models.rs:46–49` matches only Integer(1). Existing shared row::flag already handles REAL1 correctly; keep any correction operator-only.

### N3 — finite top-level setup handling does not cover null array elements
SQL `UPDATE virtual_models SET targets='[null]'`; command `setup claude` (also opencode and both --json modes): TS `("", "null is not an object (evaluating 'target.provider')\n", 1)`; Rust `("", "Default model [v]:  — refusing without a terminal\n", 1)`. Frozen `packages/control/src/modelLimits.ts:167–173` dereferences target.provider; Rust `crates/omni-cli/src/setup.rs:286–287` treats null as absent fields. A1024-null array reproduces it. New credential ordering is correct; approximating nested target consumption is not. File model-put on `[null]` correctly fails identically and leaves bytes unchanged, so the gap is setup-specific.
Related prompt gap: SQL `UPDATE virtual_models SET id=NULL`; `setup claude`: TS `("", "Default model []:  — refusing without a terminal\n", 1)` versus Rust `("", "Default model [null]:  — refusing without a terminal\n", 1)`; frozen setup's ID join versus Rust setup.rs:119–128/string conversion. Null identity correction does not cover its consumers.

### N4 — adjacent key cells still reject valid frozen operator mutations
SQL `UPDATE api_keys SET label=1`; command `keys smart-routing k --on`: TS `("id             k\nlabel          1\nprefix         p…\nsmart routing  on\n", "", 0)`; Rust `("", "unreadable row: api_keys.label: expected text, found Integer\n", 1)`. TS writes smart_routing=1, Rust remains0; full DB dumps/hashes retained. NULL/REAL/BLOB labels and prefixes yield32 substantive byte/state mismatches across revoke/smart-routing text+JSON cases. Frozen `packages/store/src/sqlite/keys.ts:74–78` returns raw labels/prefixes; new `cli_operator_rows` still calls typed `read_key` (`crates/omni-store/src/keys.rs:450`, `read_key:326–353`). This is a remaining preexisting parity gap, not a reason to relax the gateway reader.
SQL `UPDATE api_keys SET expires_at=X'80ff'`; `keys expiry k`: TS `("id      k\nlabel   k\nprefix  p…\nexpires: — (expired)\n", "", 0)` versus Rust `("id      k\nlabel   k\nprefix  p…\nexpires: never\n", "", 0)`. Frozen raw expiresAt (`sqlite/keys.ts` toKey) is a Uint8Array; Rust operator date projection at keys.rs:441 replaces BLOB with null. JSON output similarly loses the byte object.

### N5 — adjacent credential values are silently repaired by status
SQL `UPDATE credentials SET label=NULL`; command `status`: TS `("", "null is not an object (evaluating 'text.replace')\n", 1)`; Rust exit0/stderr empty, stdout `"gateway         stopped (none)\nroot            /tmp/opencode/cli-fix2-review/neighbors-rerun1/root\nadmin password  not set\n\nACCOUNT  PROVIDER  STATE    QUOTA\n         openai    enabled  unknown\n"`. Frozen `sqlite/credentials.ts:155` preserves label and `apps/cli/src/commands/status.ts:117–126` passes it to table formatting; Rust `crates/omni-cli/src/status.rs:195` substitutes empty text. BLOB id/label also become replacement-character strings (`control/credentials.rs:29`) instead of byte-index objects in JSON. Preexisting adjacent-column gap; exact variants in neighbor-differences.md.

## Counts and independence

Copied original probe.py and catalog extension from read-only first-review evidence; only checkout, evidence/binary paths and explicit clean environment adapted. Independently built e820b9da binary. Original **1,045 pairs / 1,045 equal / 0 different**, each of11 cell classes95/95; TS histogram734 exit0/256 exit1/55 exit2. AST case/argv comparison with committed corpus:1,045 unique cases on both sides, **missing0/added0**; seed SQL, values, model input and modes also read and compared. Hex encoding in committed corpus preserves byte streams. Frozen packages/apps diff against1780bb39 is empty. Prior evidence unmodified.

Neighbor suite, text and --json for each command: **3,806 pairs / 3,503 equal / 303 raw differences**:

| Class | Pairs | Equal | Different |
|---|---:|---:|---:|
| Other columns (ids/labels/prefix/strategy/alias/tier/weight/expiry/account email/disabled reason) |2016|1735|281|
| Numeric/BLOB/invalid-UTF8 JSON cells |1404|1404|0|
| Nested targets |252|244|8|
| First/middle/last failure order |30|30|0|
| Multiple rows/errors |24|24|0|
| Additional setup/status cell values |60|60|0|
| Numeric identity command variants |4|0|4|
| REAL alias variants |4|0|4|
| Extra commands |12|6|6|

The303 raw differences include **2 random key-creation outputs (inherited, not defects)** and **4 unimplemented credential set/disable commands (outside this fix, not findings)**; remaining297 deterministic parity mismatches. Eight focused confirmations in targeted.py:1 equal/7 different, overlaps deliberately not added to neighbor count. `counts.json` and full difference files retain every case.

Numeric coverage: -0,1e21,1e-7,2^53+1,i64 extrema, ±Infinity; BLOB empty/0x80/0x3132/0x00, invalid UTF8 inside valid JSON. **SQLite does store ±Infinity as REAL** (`1e999`, binding infinities); NaN binding becomes NULL (`nonfinite.json`). Sparse arrays are not valid JSON; tested1024-null array rather than claiming arbitrary huge-array coverage. Astral/lone-surrogate strings, arrays of primitives, wrong provider/model/tier/weight objects tested. No new number/BLOB coercion divergence found.

## Mutation and gateway boundary

Captured exact post-command database SHA256 and unchanged-before flags for all3,806 pairs, supplemental dumps separately: **3,598 byte-equal / 208 different**. Of1,446 mutating invocations,1,238 byte-equal/208 different. Breakdown:32 substantive refusal/state differences above;172 successful revokes differ by wall-clock timestamp;2 key creates by random identity/key/time;2 removals of1024-null targets have identical SQL dumps but different physical SQLite bytes. No normalization applied, and physical-byte equality is not claimed for those2. No observed coerced unrelated cell written back; no observed Rust DB mutation where TS aborted. Numeric-ID remove wrongly proceeds/reports success without changing DB. Full details `db-analysis.txt`, `db-differences.json`.
Call graph read (not just diff): CLI model commands→cli_get/list/put→terminal=true→cli_rows/cli_cell; setup→cli_list then cli_rows; status→cli_list→cli_rows. CLI keys list/captured mutation/require_key→cli_operator_rows(callback); set_* callers are CLI mutations only. Gateway admin_routes imports control::api as ops; API key writes use store create_columns/edit/set_limits_encoded, model put selects terminal=false/strict list, credential routes use rows/provider_data. Routing/snapshots use typed store readers. **No present HTTP/routing/snapshot path to new CLI coercion**; public visibility does not enforce future isolation. Full grep and reasoning: callers.txt,key-callers.txt,boundary.txt.

## Guard and quality

22 guard/wrapper experiments retained in guard.json/guard-wrapper.json: uppercase injected variables refuse2, explicit allowlist passes0, mixed/lowercase passes0 (Linux config lookup is case-sensitive), cwd+parent .env with bunfig and --no-env-file passes0 without loading those variables. Every Bun invocation in this review used --no-env-file; therefore auto-loading without that flag was not separately executed. Python does not load dotenv. Wrapper sets OMNI_PORT before launching guard and is refused2. Bunfig arbitrary preload execution not tested.
Files importing neither guard nor exit-gate: pty.py/password-bytes.py/full-disk.py/db-kill-driver.py are child wrappers; setup-seam.ts/password-seam.ts/password-reader-seam.ts are CLI adapters; config-diagnostics.ts/database-state.ts/db-file-state.ts are helpers; db-preview-goldens.ts is helper/pure generator; driver-env.ts is the guard itself. db-file-state-self-test.py guards its driver branch, deliberately not its child-wrapper branch. No unguarded top-level integration driver identified.
**Cannot certify that arbitrary driver invocation can never reach real config**: guard checks only OMNI names, allows deliberate bypass via allowlist, and does not constrain HOME/root or arbitrary preload code; child adapters can be invoked directly. All review CLI children received explicit scratch HOME/root and clean environment; real configuration was never used. This is a scope/guarantee limitation, not a new defect in the specified inherited-variable guard.
cli_cell reuses database::bun_cell (visibility-only change), then JS number/BLOB string conversion; no unwrap/panic there. Fixed projection fields supply setup expect calls; malformed nested values instead expose semantic defaulting errors, not observed panics. Named SELECT* reads ignore additional columns like frozen projections, but new exposed fields require explicit updates. No schema-addition experiment conducted.

## Gates, provenance, limits

All crates/**/*.rs touched first; test.log shows14 workspace compilation lines from rust-cli; fixture-proof.txt confirms embedded rust-cli fixture path. Offline, jobs2, incremental0, debug0, own warm target, one Cargo command at a time. Disk21GiB before builds, above6GiB threshold.
- Workspace tests: **exit0,185 summaries/1,265 passes/0 failed/19 ignored**; test.log/test.exit. Neither named flaky test failed; no test rerun.
- Own build, workspace/all-target Clippy `-D warnings`, fmt check: **exit0 each**, build.log/clippy.log/fmt.log and .exit files.
- Original/catalog probes exit0. Neighbors attempt1 exit1 because Python iterdump could not decode invalid UTF8; preserved neighbors.log. Rerun1 exit0; only supplemental dump uses backslash escapes, byte hashes and CLI output comparison unchanged. No product failure hidden by rerun.
- Scan **11 log files: `FAILED|panicked|^error` count0** (`log-scan.json`); fixture traceback does not match this regex. Gate count claims are independently read, not controller claims.
- Commit e820b9da8115f435daf8e7ee9cd698c86a274ccc; own copied CLI SHA256 `2069caaefc039ca6da936ec2e3dd93bb5a1c413d37880ba9a88fa2e5f35284e9`; gateway `a3d4fa80532ca56019ff91b689f67bcfa476c8d2b1b4ef0b79604e2ab611d67e` (sha256.txt). Match controller hashes, independently built.
- Did not rerun49-driver matrix/e2e/admin routes in round2; their controller/implementer results are not treated as own verification. No live ignored-service tests, arbitrary huge/deep arrays, interactive setup success/partial output, all possible other-column combinations, or schema evolution certified. No agent-setup or keys-show command exists in frozen registry (keys-show refusal tested). Credential edits are unimplemented in Rust and excluded from findings. Cargo tests retain their inherited temporary locations; all custom evidence/CLI roots stayed under review directory.

**Verdict: REQUEST CHANGES.** Original regressions are genuinely fixed and gateways remain isolated, but newly introduced model scalar/flag projection errors and remaining adjacent operator/setup mismatches prevent exact frozen parity.
