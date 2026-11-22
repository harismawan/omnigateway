# Independent review, round 5 — 54d73636

**Verdict: REQUEST CHANGES.** Review evidence: `/tmp/opencode/cli-fix5-review/`. Product files unchanged; old dirty report untouched. No commits or subagents.

Independent `cargo build --offline -p omni-cli`, after touching every Rust source, produced SHA256 `3d6a26560244dcefa892165e2b885608e69048e0bc7825a427442fe5098102ea`. Binary copied before workspace builds. Own target; requested jobs/debug/incremental settings; initial disk 6.1 GiB, subsequent check 6.0 GiB. Five corpus copies redirect evidence paths only (including targeted's nested neighbor source); originals and earlier evidence remain read-only. No corpora masks added.

## Findings first

**Critical: none. Important: I1 setup target coercion; I2 models-show eager table-cell coercion/error precedence; I3 status JSON BLOB quota loss. Minor: M1 inherited long-radix helper rounding (not demonstrated observable by expiry).**

Wider nested-target probes demonstrate Important findings below, outside both accepted differences. Supplemental direct helper test already establishes that arbitrary long radix strings are not rounded identically by `string_to_number` (97/1,000 deterministic hexadecimal inputs). This is not yet a demonstrated CLI observable difference: the only two `scalar_number` callers compare expiry against current epoch, far below these magnitudes. Do not interpret it as proof of arbitrary ToNumber exactness.

### Important I1 — setup silently narrows cell-derived target properties

Minimal exact SQL (seed id `v`, targets affinity-free TEXT, see `target-probes.py`):

```sql
UPDATE virtual_models SET targets='[{"provider":"openai","model":"gpt-4o","contextWindow":{"toString":5}}]';
```

Command on both executables: `--root <scratch>/root setup claude` (also with `--json`; also `setup opencode --dir <scratch>`). Both exit **1**, stdout **empty**, database exact/unchanged. Frozen stderr **`No default value\n`**; Rust stderr **`Default model [v]:  — refusing without a terminal\n`** (two spaces after colon). Same mismatch for `maxOutputTokens`; provider `{ "toString":5 }` also bypasses frozen property-key coercion. Complete targets with pricing/capabilities reproduce it too (`repro.py`, eight mismatches total).

Frozen `packages/control/src/modelLimits.ts:44–49,102–106,169–175`: nullish fallback followed by `Math.min` on every non-undefined value. Frozen provider property access `:91` and `:198` requires ToPropertyKey. Rust `crates/omni-cli/src/setup.rs:293` maps string-conversion failure to empty; `:342–347` ignores non-Number overrides; `:366–369` narrows only Number. The sweep's setup row calls this preserved behavior but omits these narrowings. **Do not implement open-ended JS here without a ruling; stop/report this additional consumer as required.** Neither quota human rendering nor `models put` credentials covers setup target JSON.

### Important I2 — models show eagerly ToStrings raw table cells

Exact minimal SQL:

```sql
UPDATE virtual_models SET targets='[{"provider":"openai","model":{"toString":5}}]';
```

Command: `--root <scratch>/root models show v`. Both exit **1**, stdout empty, DB unchanged. Frozen stderr **`undefined is not an object (evaluating 'target.costPerMTok.input')\n`**; Rust stderr **`No default value\n`**. Same for `credentialId:{"toString":5}` with string model. For a complete target (tier 1, weight 1, input 0/output 1 pricing, tools/images/reasoning booleans), frozen instead errors **`text.replace is not a function. (In 'text.replace(/\\u001b\\[[0-9;]*m/g, "")', 'text.replace' is undefined)\n`**, while Rust still errors **`No default value\n`**. JSON mode agrees.

Frozen `apps/cli/src/commands/models.ts:79–90` carries raw model/account cells through row construction and only then table width invokes `output.ts:69,81–95`. Rust `crates/omni-cli/src/models.rs:360–368` eagerly calls `text(...)` before cost/property errors and before eventual table type checking at `:414–429`. Fix must preserve evaluation order, not just change one error string. This is not inside accepted `models put` credential exception.

### Important I3 — status --json corrupts quota BLOB cells (NOT accepted human quota difference)

Exact seed: credential `q/openai/quota/oauth`; affinity-free `quota_windows(credential_id,window_type,starts_at,used,limit_value,resets_at,observed_at,window_ms)` row `('q','fiveHour',0,1,10,NULL,0,NULL)`.

```sql
UPDATE quota_windows SET used=X'0102';
```

Command: `--root <scratch>/root status --json`. Both exit **0**, stderr **empty**, DB unchanged. Full streams are in `wide-hdre555i/wide.json` under review evidence. All JSON fields are identical except `credentials[0].quota[0].used`: frozen prints the object `{"0":1,"1":2}` (pretty-printed); Rust prints the string `"\u0001\u0002"`. Empty BLOB is `{}` vs `""`; X'ff' is `{"0":255}` vs `"�"`. These are not just formatting differences. The same three cases reproduce independently for window_type, starts_at, limit_value, resets_at, observed_at and window_ms: **21 JSON mismatches**. No mask: quota probe exits 1.

Frozen `packages/store/src/sqlite/credentials.ts:361–372` passes raw cells; status emit uses JSON.stringify, preserving Uint8Array indexed properties. Rust `crates/omni-control/src/credentials.rs:24–30,345–373` uses `sql_value`, conflating BLOB with UTF8 TEXT. Human quota/burn exception does **not** authorize loss in `--json`. Shared typed/health consumers of sql_value must not be loosened to repair terminal output.

### Minor M1 — long-radix ToNumber helper is not exact

`scalar_number` calls `omni_ir::js::string_to_number`; `crates/omni-ir/src/js.rs:150–157` accumulates radix digits in f64 and rounds at each step rather than once. Of 1,000 seeded hexadecimal inputs, 903 equal / 97 different (`radix-{input,diff}.json`, Bun/Rust text). Example TEXT `0xce14db0699202bd90872129b6f237adc0cc56aca3b736998252d572dd7df79d82a5d04395d6a3a21f42`: Bun **7.042997472015862e+99**, Rust **7.042997472015861e+99**. This direct helper issue is inherited, not a proven current CLI output mismatch: both expiry sites compare to current epoch and both values remain future. No unrelated gateway/shared helper edit is authorized by this review. The claimed arbitrary JS ToNumber exactness must be qualified. For the current-epoch expiry comparison, hexadecimal strings representing integers below 2^53 accumulate exactly, while the demonstrated larger positive values are all future (negative signed-radix strings are NaN on both sides). No current expiry-state discrepancy was found.

## R1–R5 dispositions — all five CLOSED in their original scope

- R1 CLOSED: carrier retains ±Infinity, and serialization is deferred. Own focused 24/24 pairs cover ±Infinity label interpolation/table error and expiry/revoked state, human/JSON.
- R2 CLOSED (10/10 own focused pairs): status provider and label both call `table_text`, `status.rs:193–196`.
- R3 CLOSED (10/10 own focused pairs): guardrail uses exact Null branch then scalar interpolation, `mutations.rs:340–345`.
- R4 CLOSED (20/20 own focused pairs): both expiry consumers use `partial_cmp != Greater`, retaining NaN-as-not-future semantics. Direct Bun comparison passed all 51 selected Number/relational/arithmetic cases (see scalar table below).
- R5 CLOSED (2/2 own successful revoke pairs plus live-record bite): `typed_state.py:18–36` is column-scoped, only successful paired `keys revoke`, matching TEXT id, only `api_keys.revoked_at`, INTEGER timestamp inside each side's own [started−1,000, ended+1,000]. Every other cell exact typeof/hex. Scratch snapshot bite rejects mutations of created_at, id, revoked_at storage class and out-of-window clock (`bite.json`); permits only legitimate clock drift. Snapshot rows compare in query order, with no sorting/masking.

## Boundary result

Independent function extraction: `read_key` and `operator_rows` identical to 21348e06 (`boundary.json`). Store diff is only `parse_stored_limits` visibility. Requested row/error/pg/api/gateway/gateway-core diff is empty (`boundary.diff`). Call sites retained in `callers.txt`; CLI-only readers are separate from typed `models::list/get/put`, credential readers and `api::list_keys`.

## Accepted differences — narrow scope

1. Human quota/burn rendering in `omni status` for malformed `quota_windows` cells, including coercion/ordering/window-label/arithmetic consumers. This does **not** exempt status provider/label tables, credential cells, JSON output, normal quota windows, HTTP or routing. Concrete accepted fixture: used INTEGER 1, limit_value TEXT '10', observed_at/starts_at INTEGER 0, fiveHour, resets_at/window_ms NULL: frozen `5h 10% (20773d ago)` versus Rust `unknown`; JSON equal for that fixture. The exact age is invocation-date-dependent.
2. `models put` credential-resolution/validation involving pinned/custom credentials with non-string stored id/provider/label/authType. This does **not** exempt `models list/show/rm`, setup's own model/credential consumption, ordinary string credential fields, provider_data parsing, status, keys, or gateway typed readers. No blanket approval for arbitrary malformed credentials.

## Execution status

The own five-corpus sequence is complete (wide/extra after the disclosed timeout/restart). Final results and decoded stderr counts are appended below. No claim of all-stored-cell exhaustiveness or controller 53-driver rerun.


## Sweep-table cross-check (18 independently inspected sites)

Abbreviations: frozen paths relative to `apps/cli/src` unless prefixed; W=own wide corpus; E=own extra; P=own 800 wider scalar probes; T=own 360 target probes. Source files under apps/packages are byte-identical to frozen commit (`frozen.exit=0`).

| Rust site | Frozen line | classification / action | pinning row checked |
|---|---|---|---|
| control/keys.rs:13–76,620 | packages/store/src/sqlite/keys.ts:74–91; output.ts:113 | raw storage/JSON: preserve carrier and insertion order | W api_keys × --json |
| output.rs:159–161 | commands/keys.ts:445–448; output.ts:69 | direct table cell: table_text (not stringify) | W label/id/prefix; P label/prefix |
| mutations.rs:287–289 | commands/keys.ts:680–683; output.ts:101 | template string coercion | P label/prefix limits/models/guardrail |
| mutations.rs:340–345 | commands/keys.ts:745–750 | exact-null guardrail then scalar string | W guardrail; P every scalar class |
| output.rs:148–153 | commands/keys.ts:414–419; packages/store/src/types.ts:735 | relational ToNumber and NaN-not-future | P 50 SQL expiry values × 4 |
| mutations.rs:319–322 | commands/keys.ts:685–688 | same relational ToNumber | P same 200 pairs |
| output.rs:9 finite filter | output.ts:125–133 | intentional Number.isFinite, no TEXT ToNumber | W/E dates, P numeric TEXT |
| status.rs:193 | commands/status.ts:119,124; output.ts:69 | direct provider table cell | W provider, P all five storage classes |
| status.rs:196 | commands/status.ts:118,124 | direct label table cell | W label; P label |
| control/credentials.rs:100–104 | packages/store/src/sqlite/credentials.ts:157 | exact ===1 (not truthiness) | W enabled INTEGER/REAL/TEXT/NULL/BLOB |
| control/keys.rs:34–38 | packages/store/src/sqlite/keys.ts:82,91 | exact ===1 flags | W flags |
| control/models.rs:34–37 | packages/store/src/sqlite/config.ts:74 | exact ===1, intentionally typed boolean | W virtual_models is_alias; targeted Real1 |
| models.rs:707–708 | commands/models.ts model list; output.ts:69 | id/strategy direct table | W strategy/id, E model-edges, P |
| models.rs:360–368 | commands/models.ts:79–90 | **missed eager text coercion: I2** | T model/credentialId object-toString |
| setup.rs:121–124 | commands/setup.ts:95 | null-aware array join | W/E non-string ids |
| setup.rs:293,342–347,366–369 | packages/control/src/modelLimits.ts:44–49,91,102–106 | **missed Number-only/property-key narrowings: I1** | T overrides/provider objects; complete-target repro |
| control/credentials.rs:126–130 | packages/store/src/sqlite/credentials.ts:162 | JSON.parse ToString via terminal cell; strict HTTP branch separate | W provider_data; stored-cells |
| control/models.rs:124–134 | packages/control/src/models.ts:44–49,119–164 | non-string credential -> empty: accepted scoped models-put difference only | code inspection; pinned/custom not fully enumerated |

Also inspected: status quota `.as_f64/.as_str/unwrap_or` sites are precisely accepted human quota difference, not general approval; credentials status_quota BLOB UTF8 conversion belongs to that review scope only. `keys.rs:161/163/189` are validated limits mutation inputs, not raw cells. `keys.rs:523,528,617,623` serde lossiness is repaired by exact limits/usage/carrier output; date finite filter is intentional. Setup `string(...).unwrap_or_default()` is **not** globally harmless (I1). `models.rs` numeric format expects follow internally generated decimal strings; mutation result/created-key expects follow constructed structures. Projection field expects require named SQL fields produced unconditionally; changing schema columns is not certified. Full search captures are `narrowings.txt`, `all-cli-narrowings.txt`, `other-narrowings.txt`; grep command for the latter disclosed a nonexistent connect.rs (connect implementation is elsewhere), so this is a manually traced inventory, not an automated proof that every consumer is covered.

## Scalar-number direct Bun comparison

51 selected inputs: **51 equal / 0 different**, through actual compiled helper linked to worktree rlibs; Bun `--no-env-file`. Each row compares Number text, `>100`, `<100`, subtraction by 1, multiplication by 2, division by 2 (no `+`, which is concatenation-sensitive and not used by either expiry consumer). Actual CLI consumers separately exercised by 50 SQL inputs × keys list/expiry × human/JSON = **200/0**. SQL covers NULL, INTEGER, REAL±Infinity, TEXT and BLOB. Uint8Array bytes are decimal bytes, not decoded UTF8 (`[5]`→5, `[53]`→53).

| Input | Number / >100 / <100 / −1 / ×2 / ÷2 |
|---|---|
| `null` | `0 / false / true / -1 / 0 / 0` |
| `0` | `0 / false / true / -1 / 0 / 0` |
| `1` | `1 / false / true / 0 / 2 / 0.5` |
| `-1` | `-1 / false / true / -2 / -2 / -0.5` |
| `1.5` | `1.5 / false / true / 0.5 / 3 / 0.75` |
| `Infinity` | `Infinity / true / false / Infinity / Infinity / Infinity` |
| `-Infinity` | `-Infinity / false / true / -Infinity / -Infinity / -Infinity` |
| `new Uint8Array([])` | `0 / false / true / -1 / 0 / 0` |
| `new Uint8Array([5])` | `5 / false / true / 4 / 10 / 2.5` |
| `new Uint8Array([1, 2])` | `NaN / false / false / NaN / NaN / NaN` |
| `new Uint8Array([53])` | `53 / false / true / 52 / 106 / 26.5` |
| `new Uint8Array([0])` | `0 / false / true / -1 / 0 / 0` |
| `new Uint8Array([255])` | `255 / true / false / 254 / 510 / 127.5` |
| `""` | `0 / false / true / -1 / 0 / 0` |
| `" "` | `0 / false / true / -1 / 0 / 0` |
| `"0x10"` | `16 / false / true / 15 / 32 / 8` |
| `"0b10"` | `2 / false / true / 1 / 4 / 1` |
| `"0o10"` | `8 / false / true / 7 / 16 / 4` |
| `"Infinity"` | `Infinity / true / false / Infinity / Infinity / Infinity` |
| `"-Infinity"` | `-Infinity / false / true / -Infinity / -Infinity / -Infinity` |
| `"+Infinity"` | `Infinity / true / false / Infinity / Infinity / Infinity` |
| `"infinity"` | `NaN / false / false / NaN / NaN / NaN` |
| `"NaN"` | `NaN / false / false / NaN / NaN / NaN` |
| `"1e13"` | `10000000000000 / true / false / 9999999999999 / 20000000000000 / 5000000000000` |
| `"1e-3"` | `0.001 / false / true / -0.999 / 0.002 / 0.0005` |
| `".5"` | `0.5 / false / true / -0.5 / 1 / 0.25` |
| `"1."` | `1 / false / true / 0 / 2 / 0.5` |
| `"+1"` | `1 / false / true / 0 / 2 / 0.5` |
| `"-0"` | `0 / false / true / -1 / 0 / 0` |
| `"1_0"` | `NaN / false / false / NaN / NaN / NaN` |
| `"0x"` | `NaN / false / false / NaN / NaN / NaN` |
| `"+0x1"` | `NaN / false / false / NaN / NaN / NaN` |
| `"1,2"` | `NaN / false / false / NaN / NaN / NaN` |
| `"null"` | `NaN / false / false / NaN / NaN / NaN` |
| `"true"` | `NaN / false / false / NaN / NaN / NaN` |
| `"9999999999999"` | `9999999999999 / true / false / 9999999999998 / 19999999999998 / 4999999999999.5` |
| `"1e309"` | `Infinity / true / false / Infinity / Infinity / Infinity` |
| `"1e-400"` | `0 / false / true / -1 / 0 / 0` |
| `"01"` | `1 / false / true / 0 / 2 / 0.5` |
| `"0b2"` | `NaN / false / false / NaN / NaN / NaN` |
| `"1e+"` | `NaN / false / false / NaN / NaN / NaN` |
| `"."` | `NaN / false / false / NaN / NaN / NaN` |
| `"0Xff"` | `255 / true / false / 254 / 510 / 127.5` |
| `"0O77"` | `63 / false / true / 62 / 126 / 31.5` |
| `"0B11"` | `3 / false / true / 2 / 6 / 1.5` |
| `" 5 "` | `5 / false / true / 4 / 10 / 2.5` |
| `"\t5\n"` | `5 / false / true / 4 / 10 / 2.5` |
| `"\ufeff5\u00a0"` | `5 / false / true / 4 / 10 / 2.5` |
| `"\u00855"` | `NaN / false / false / NaN / NaN / NaN` |
| `"\u20285"` | `5 / false / true / 4 / 10 / 2.5` |
| `"\u200b5"` | `NaN / false / false / NaN / NaN / NaN` |

The supplemental 1,000 long-radix probe invalidates universal exactness; see M1, not masked from these measurements.


## Independent gates completed

Read verbatim from evidence `.exit` files:

```text
cargo build --offline -p omni-cli exit=0
cargo test --offline --workspace exit=0
cargo clippy --offline --workspace --all-targets -- -D warnings exit=0
cargo fmt --all -- --check exit=0
git diff --exit-code 1780bb39 -- apps packages exit=0
```

Workspace test log sums **1,265 passed / 0 failed / 19 ignored** across test-result lines (includes child harness results); no failed compile, runtime flake, retry or warning suppression. Disk remained above cutoff (5.9 GiB). Gate environment exactly CARGO_BUILD_JOBS=2 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0; no concurrent Cargo commands. `touch crates/**/*.rs` was implemented by find before first build. The direct Rust helper probes use rustc, not a second Cargo build; binaries/rlibs reside in requested target, helper outputs in review scratch.

## Wider probe counts

All supplemental wide-derived comparisons include exact stdout/stderr/exit and typed-state equality (only successful revoke clock exception); no JSON semantic normalization. The original stored-cells corpus checks streams/exit only, and original neighbors-targeted checks streams/exit plus unchanged-state flag; do not attribute typed-state coverage to those two original harnesses. Each probe assertion intentionally remains red on differences. Counts are **equal / different**, not claims of complete input-domain coverage.

| Probe | pairs | equal | different | disposition |
|---|---:|---:|---:|---|
| scalar columns/expiry | 800 | 800 | 0 | expiry 200; guardrail/label/prefix 240; credential id/provider/label/authType 240; model strategy/id 120 |
| nested targets | 360 | 346 | 14 | I1 12, I2 2 |
| setup empty-string pins across openai/anthropic/custom | 528 | 528 | 0 | nonterminal; NOT proof of generated config parity |
| complete-target isolated repro | 20 | 12 | 8 | I1 6, I2 2; additional runs, not unique bug classes |
| quota all columns | 144 | 99 | 45 | 24 accepted human-only differences; 21 unaccepted JSON BLOB differences I3 |

**Total supplemental paired runs: 1,852; 1,785 equal / 67 different. Of the 67: 24 fall inside accepted human quota scope; 43 are unaccepted mismatches (includes eight additional complete-target reproductions).** Separate accepted quota proof has 2 pairs (one differing human, one equal JSON), not added to this total.

| Probe | NULL equal/diff | INTEGER | REAL | BLOB | TEXT / stored JSON |
|---|---|---|---|---|---|
| scalar columns | 64/0 | 136/0 | 136/0 | 204/0 | 260/0 |
| setup pin columns | 48/0 | 96/0 | 144/0 | 144/0 | 96/0 |
| targets (all TEXT JSON) | — | — | — | — | 346/14 |
| complete targets | — | — | — | — | 12/8 |
| quota columns | 14/2 | 15/1 | 40/8 | 18/30 | 12/4 |

Class counts are by injected SQLite class (REAL±Infinity included); nested JSON values remain SQLite TEXT. Repro SQL, full child streams, storage-class snapshots and invocation windows preserved under review wide-* directories, per-run paths in corresponding `.log`. `probe-counts.json` breaks these down by column. Status quota proof was independently rerun against reviewer binary (`quota-proof.exit` 0); human mismatch confirmed, JSON equals for the numeric-TEXT example only.

## Boundary call graph (completed)

- HTTP admin keys: `omni-gateway/src/admin_routes.rs:453` → `omni_control::api::list_keys` → api.rs:159 → unchanged strict store `operator_rows`.
- HTTP models: `api.rs:604,616,955` → typed `models::list/put`; `put_with(...terminal=false)` uses `operator_credentials`, not terminal cli_rows. `cli_get/list/put` only called by omni-cli (and cli_put's terminal subpath).
- CLI status/setup → credentials::cli_rows → rows_with(terminal=true); typed credentials::rows/list → terminal=false and strict provider_data parser. Shared Cell code is guarded by terminal branch; scalar_number/table_text/scalar_string call sites are CLI-only.
- Gateway snapshot: `omni-gateway-core/src/snapshot.rs:211–216` → `Store::snapshot_reads`; routing reads store's validated snapshot, not control CLI reader. Postgres remains pg/rows typed readers, with no cli_cell call site.
- cli_cell module is public and coercion helpers compile into libraries; boundary claim concerns actual in-tree call reachability, not type-level prevention of future misuse.
- Independent extracted read_key/operator_rows exact function bytes match base. Only store delta is parse_stored_limits visibility. `boundary.diff` zero bytes; no HTTP/routing/snapshot/Postgres product changes. Two attempted grep paths (control/snapshot.rs, CLI/connect.rs) do not exist; corrected inventory covers all CLI source files and locates gateway snapshot explicitly. No path silently skipped as proof.

## Inherited frozen behavior (not new exceptions)

Non-string direct table cells throw Bun text.replace errors rather than stringify. Guardrail NULL alone means none; any other cell interpolates. Invalid/odd JSON.parse inputs can error before another command-specific consumer; invalid key limits fail closed. JSON.stringify turns nonfinite numbers to null while relational/interpolation must retain Infinity. Date display uses Number.isFinite, so numeric TEXT is em dash even though expiry relational comparison coerces it. Flags are exact ===1, not truthiness. BLOB is Uint8Array, with comma-decimal-byte ToString and indexed-property JSON. These remain frozen requirements, not waivers.

## Remaining limits of verification

No controller 53-driver independent rerun; controller's matrix result is not passed off as mine. No exhaustive interactive terminal config-generation proof; setup pin probes generally stop at nonterminal prompt, so passing 528 does not certify downstream persisted limits. No full arbitrary pinned/custom credential combinations for models put (accepted scope only). No proof for schema-column deletion/renaming, arbitrary concurrent writers, every possible nested JSON shape, or every arithmetic ToNumber input. No additional product JS emulation proposed: I1 requires a new explicit stop/ruling, not silent expansion. Long radix strings have a direct helper gap M1. Review is REQUEST CHANGES across all rounds even if old R1–R5 close; green existing corpora are not enough to exempt I1–I3.


### Sweep omissions and remaining expects

Additional search in `limits.rs:56,63–65,77–78`: raw stored limits have first been parsed by `parse_stored_limits` into validated finite limits, and `api::limit_usage` constructs dimension/window fields; these are not arbitrary raw quota_windows values. `output.rs:135` and `mutations.rs:148` serialize normalized/validated limits for human consumers; exact JSON paths use retained JS matrices/readings. `settings.rs:109,123` process parsed settings values and JS key ordering, not scalar SQLite `value` before JSON.parse. `lib.rs` narrowings are argv/env/help paths. Full grep inventory includes all `.as_str/.as_f64/.as_i64/.as_u64/.as_bool/.is_string/unwrap_or/unwrap_or_default/lossy` hits, not only selected files (`full-narrowing-inventory.txt`). There is no `omni-cli/src/keys.rs`; mutations/output own those consumers.

The implementer table is **not a completed sweep**. At least setup's `if let Number`/`narrow` and swallowed conversion error were missing substantive consumers, despite a row labelled "existing ... retained"; table-formatter raw values in models show were not actually preserved until their consumer. Quota BLOB narrowing was listed but classified as human rendering only; its earlier JSON projection is separately observable (I3). The two user waivers do not close these omissions.

The original neighbors harness has six **preexisting explicit exclusions**, not parity passes: 2 `keys create` random outputs (both exit 0 asserted), 4 unimplemented `credentials set/disable` cases (Rust nonzero asserted). Own review adds no exclusions. These six are neither additional newly accepted differences nor evidence of CLI equivalence. Scope ruling for this stored-cell branch does not erase those prior implementation gaps.


### Live revoke comparator bite

`r1-r5.py` **66 equal / 0 different**, split R1=24, R2=10, R3=10, R4=20, R5=2. `r1-r5.exit` is 0. From an actual successful paired revoke run in `wide-e6wx82f1/wide.json`, restored tuple representation after JSON read, mutated **only Rust target api_keys.created_at** to INTEGER99 in a scratch snapshot copy: comparison rejected it. Restore made it pass again (`real-revoke-bite.json`). Additional scratch SQLite `bite.db` proves the same via real DB storage-class snapshots; bound/class/id rejection tests are in `bite.json`. No actual corpus DB or product comparison code modified.

### Full I3 stdout, minimal BLOB fixture

Both exit 0, stderr empty; exact example is `UPDATE quota_windows SET used=X'0102'` and `status --json`. Paths below are literal evidence fixture paths, equal on both sides; output includes trailing LF.

ts:

```json
{
  "process": {
    "supervisor": "none",
    "running": false,
    "pid": null,
    "state": null,
    "unitPath": null,
    "logFile": "/tmp/opencode/cli-fix5-review/wide-hdre555i/fixture/state/omnigateway/gateway.log"
  },
  "adminConfigured": false,
  "credentials": [
    {
      "id": "q",
      "provider": "openai",
      "label": "quota",
      "enabled": true,
      "quota": [
        {
          "credentialId": "q",
          "windowType": "fiveHour",
          "startsAt": 0,
          "used": {
            "0": 1,
            "1": 2
          },
          "limit": 10,
          "resetsAt": null,
          "observedAt": 0,
          "windowMs": null
        }
      ]
    }
  ],
  "storeError": null
}
```

rust:

```json
{
  "process": {
    "supervisor": "none",
    "running": false,
    "pid": null,
    "state": null,
    "unitPath": null,
    "logFile": "/tmp/opencode/cli-fix5-review/wide-hdre555i/fixture/state/omnigateway/gateway.log"
  },
  "adminConfigured": false,
  "credentials": [
    {
      "id": "q",
      "provider": "openai",
      "label": "quota",
      "enabled": true,
      "quota": [
        {
          "credentialId": "q",
          "windowType": "fiveHour",
          "startsAt": 0,
          "used": "\u0001\u0002",
          "limit": 10,
          "resetsAt": null,
          "observedAt": 0,
          "windowMs": null
        }
      ]
    }
  ],
  "storeError": null
}
```

Controller evidence verification (read-only): 54 `.exit` files currently present in ctl/matrix, all contain 0 (`controller-exits.json`); the task named 53 driver lines, so 54 files is not asserted to mean 54 distinct drivers. Captured manifest identifies commit 54d73636 and same CLI SHA256. I did not independently execute those drivers.

## Panic hunt (intermediate, updated after corpus completion)

Decoded stderr for **50638 children** across reviewer completed corpora/probes plus implementer final five and controller evidence paths; **0 panic markers/exit 101/134/−6**. Both TS and Rust checked for `panicked` and `thread 'main'`; `panic-scan.json` lists per-file counts. Final own sequence still pending, so this count is not final. All-class attacks in W inject every existing column of api_keys/credentials/virtual_models; stored-cells covers JSON carrier columns/settings value; reviewer quota probes attack all eight quota columns with NULL/INTEGER/REAL/TEXT/BLOB. Arbitrary nested JSON is not certified panic-free; tests are evidence, not proof.

Boundary gate `.exit`: `git diff --exit-code 21348e06..HEAD -- row.rs error.rs pg api.rs gateway gateway-core exit=0`.

## Representative own R1–R5 reproductions

Each SQL applied separately to affinity-free scratch seed. Command below follows `--root <scratch>/root`. Full pair state and times in `wide-e6wx82f1/wide.json`; both sides byte-identical streams/exit in each case.

### R1

SQL: `UPDATE api_keys SET label=1e999`; command: `keys guardrail k`. Frozen exit 0; Rust exit 0.

Both stdout:

```text
id      k
label   Infinity
prefix  p…
policy: none; requests are not judged
```

Both stderr: empty.

### R2

SQL: `UPDATE credentials SET provider=2`; command: `status`. Frozen exit 1; Rust exit 1.

Both stdout:

```text
```

Both stderr: 

```text
text.replace is not a function. (In 'text.replace(/\u001b\[[0-9;]*m/g, "")', 'text.replace' is undefined)
```

### R3

SQL: `UPDATE api_keys SET guardrail_policy=X'0102'`; command: `keys guardrail k`. Frozen exit 0; Rust exit 0.

Both stdout:

```text
id      k
label   k
prefix  p…
policy:
1,2
```

Both stderr: empty.

### R4

SQL: `UPDATE api_keys SET expires_at='9999999999999'`; command: `keys expiry k`. Frozen exit 0; Rust exit 0.

Both stdout:

```text
id      k
label   k
prefix  p…
expires: —
```

Both stderr: empty.

### R5

SQL: `SELECT 1`; command: `keys revoke k --yes`. Frozen exit 0; Rust exit 0.

Both stdout:

```text
k revoked
```

Both stderr: empty.

R5 `SELECT 1` means no injected mutation before the revoke; only target revoked_at changes, confirmed typeof INTEGER and each side in its invocation window.

### Corpus invocation/provenance caveat

All five original scripts hardcode the implementer evidence prefix. Executing them unchanged would write into read-only evidence. Scratch copies change only `/tmp/opencode/cli-fix5/` (and legacy cli-fix2, if present) to review evidence; targeted additionally reads the scratch neighbors.py instead of original. No case, comparator, histogram or exception changed. Each run receives clean env, PATH, isolated HOME, PYTHONDONTWRITEBYTECODE=1, CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN, copied OMNI_CLI_BIN and PYTHONPATH pointing at original conformance helpers. Child CLI env has own root/HOME and `bun --no-env-file`. Original sources stay frozen. No `.env` or real config read.

`boundary-no-coercion.log` is empty and grep exits 1: no cli_cell/cli_rows/cli_operator_rows/scalar_number symbols in pg/router/gateway-core/gateway. This supplements, rather than replaces, call-chain inspection.

## Reproduction entry points (review scratch only)

From the rust-cli worktree, full frozen entry point is `bun --no-env-file "$PWD/apps/cli/src/index.ts"`; Rust is `/tmp/opencode/cli-fix5-review/omni`. Both receive `--root <case fixture>/root` before the command. Case runners create isolated HOME/XDG_STATE_HOME, NO_COLOR=1, OMNI_ENCRYPTION_KEY=review-secret-long-enough, BUN_RUNTIME_TRANSPILER_CACHE_PATH=0, PATH only; no inherited OMNI secrets. Each target/field SQL above is applied to a fresh seed independently on both sides. Existing reports/evidence not modified.

To rerun Important findings without changing any product file:

```sh
env -i PATH="$PATH" HOME=/tmp/opencode/cli-fix5-review/home-reproduce PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$PWD/conformance/cli" CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/cli-fix5-review/omni python3 /tmp/opencode/cli-fix5-review/target-probes.py
env -i PATH="$PATH" HOME=/tmp/opencode/cli-fix5-review/home-reproduce PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$PWD/conformance/cli" CLI_CONFORMANCE_ALLOW_OMNI=OMNI_CLI_BIN OMNI_CLI_BIN=/tmp/opencode/cli-fix5-review/omni python3 /tmp/opencode/cli-fix5-review/quota-probes.py
```

Recorded `.exit` contents:

```text
env -i [isolated] python3 review/probes.py exit=0
env -i [isolated] python3 review/target-probes.py exit=1
env -i [isolated] python3 review/pin-probes.py exit=0
env -i [isolated] python3 review/repro.py exit=1
env -i [isolated] python3 review/quota-probes.py exit=1
env -i [isolated] python3 review/quota-proof.py exit=0
env -i [isolated] python3 review/r1-r5.py exit=0
diff scalar Bun/Rust Number,>,<,-,*,/ exit=0
```

The literal `[isolated]`/`review/` strings in `.exit` files abbreviate command context; full runner source and commands above identify actual paths. Nonzero probe exits are asserted parity failures, not crashes. Child stderr is stored hex and decoded separately; a driver assertion backtrace is not a Rust child panic.

### Incomplete predecessor history is not hidden

The reviewed range includes the measured ead63b7d regression followed by restoration, not a rewritten clean history. I inspected its final diff, not rebuilt every intermediate commit: I do not independently certify predecessor counts or repaired history step counts. Current frozen source tree matches 1780bb39; current copied reviewer binary matches final hash. The earlier failed compiler/clippy/stale-binary attempts in implementer report are not presented as passing gates. Current own gates pass from touched sources. Report remains uncommitted and is ignored by repository .gitignore (verified with git check-ignore); old dirty e1-e5-report.md is still the only tracked dirty file.


## Own five-corpus attempt 1 / timeout disclosure

The 1,200-second timeout applied to the **whole sequential five-command chain**, not each corpus. Stored-cells, neighbors and neighbors-targeted completed successfully; wide was interrupted by parent timeout, shell exit **143**, without its normal `.exit` write or final results JSON; extra had not started. This is neither a Rust panic nor a passing run. I retained empty/incomplete `wide.log`, its scratch fixture and `wide-interrupted.exit`; the latter explicitly records the harness-observed parent 143, not a fabricated driver exit. The interrupted wide child's captured streams existed only in Python memory and cannot all be retrospectively decoded: that attempted run is an explicit panic-audit coverage gap. Complete wide/extra restarted sequentially with a 3,600-second parent timeout and separate `*-rerun.{log,exit}`. No evidence deleted.

Completed `.exit` files, verbatim:

```text
env -i [isolated HOME/PATH/PYTHONPATH] OMNI_CLI_BIN=review/omni python3 conformance/cli/stored-cells.py [scratch evidence-prefix copy] exit=0
env -i [isolated HOME/PATH/PYTHONPATH] OMNI_CLI_BIN=review/omni python3 conformance/cli/neighbors.py [scratch evidence-prefix copy] exit=0
env -i [isolated HOME/PATH/PYTHONPATH] OMNI_CLI_BIN=review/omni python3 conformance/cli/neighbors-targeted.py [scratch evidence-prefix copy] exit=0
env -i [isolated] python3 review/wide.py exit=143 (parent chain 1200s timeout; incomplete, not parity failure)
```

Completed first three counts: stored-cells **1,045/0**; neighbors **3,806/0**, **six preexisting exclusions** (raw equal stream count 3,800); targeted **8/0**. No broad timestamp/state mask; neighbors typed state comparison invoked on all nonexcluded rows. Exit histograms match checked-in values. Combined original corpus total if last two complete is 9,275 paired cases, not 9,275 exact-equivalence passes because of the six exclusions.

### Column-class attack inventory

The all-column corpus does not restrict attacks to schema-affinity-valid values: tables are rebuilt without affinity and every listed column is assigned NULL, INTEGER 2, REAL 1.5, TEXT '1', BLOB X'80ff' and invalid UTF8 TEXT (plus separate scalar edge cases).

- `api_keys`: `id`, `label`, `prefix`, `hash`, `model_allowlist`, `created_at`, `revoked_at`, `body_logging_opt_out`, `limits`, `expires_at`, `guardrail_policy`, `smart_routing`.
- `credentials`: `id`, `provider`, `label`, `auth_type`, `enabled`, `tier`, `weight`, `expires_at`, `account_email`, `provider_data`, `access_token`, `refresh_token`, `api_key`, `id_token`, `created_at`, `updated_at`, `disabled_reason`, `disabled_at`, `token_version`.
- `virtual_models`: `id`, `targets`, `strategy`, `is_alias`.
- `quota_windows`: credential_id, window_type, starts_at, used, limit_value, resets_at, observed_at, window_ms; own supplemental probe supplies all storage classes plus ±Infinity. Settings value and raw JSON columns additionally use stored-cells parse/error inputs. Missing/deleted columns are not represented as a scalar storage class.


## Required follow-up (review only; no implementation authorization)

- **I1** `setup.rs:293,342–347,366–369`: do not discard non-Number overrides or swallow ToPropertyKey conversion errors. Report this newly reached open-ended model-limit consumer for explicit scope/ruling; existing two differences do not cover it.
- **I2** `models.rs:360–368`: retain raw target model/account table values until table width consumes them, while preserving frozen earlier property/method error precedence. Pin both incomplete-target and complete-target cases; no blanket JS-emulation expansion is implied.
- **I3** `credentials.rs:345–373` terminal status quota projection: carry BLOB cells to exact JSON as Uint8Array indexed objects; do not change shared typed HTTP/health readers to achieve terminal parity. Human quota arithmetic remains the already accepted difference.
- **M1** `js.rs:150–157`: disclose non-universal radix ToNumber precision. No demonstrated expiry regression or authorization to alter shared router coercion; arbitrary arithmetic consumers would need exact rounding and separate boundary review.

No Critical finding. Existing R1–R5 repairs and strict-reader restoration are accepted on their measured/code-inspected scope, but do not override these new Important findings. Request changes does not demand fixing the two expressly accepted differences.

### Inventory search scale and assurance limit

The requested nine existing models/mutations/output/setup/status/control-keys/control-credentials/control-models/cli_cell files contain **99 lines matching the narrowing search** (machine line inventory in sweep-search-counts.json; full CLI grep separately). A matching line may contain more than one operation. Eighteen representative sites were independently cross-referenced above; source tracing distinguishes flags/env/catalog/generated fields from cell-derived values. This is not a formal proof of every use, especially open-ended nested model targets; the concrete missed sites I1/I2 are why the sweep cannot be certified complete.

### Supplementary radix boundary check

A separate 1,500-input direct Bun/Rust probe compares hexadecimal/octal/binary representations of 101 current-epoch-neighborhood integers and 399 seeded integers below 2^53 (500 × 3): **1,500 equal / 0 different**, `radix-small.exit` = `diff 1500 sub-2^53 radix ToNumber values including current-epoch neighborhood exit=0`. This supports closing R4 for present-epoch relational consumers without pretending the arbitrary-long-radix arithmetic discrepancy M1 is exact. No shared helper was changed.

Focused R1–R5 66/0 is **additional** to the 1,852 supplemental table, so broader+focused paired runs total **1,918: 1,851 equal / 67 different** (43 unaccepted, 24 accepted human-only); the separate accepted-quota proof 2 pairs remains excluded from those totals. Direct helper inputs total 51 + 1,000 + 1,500 = **2,551 inputs; 2,454 equal / 97 differing**, counted separately from end-to-end CLI pairs.


### Exploratory PTY runs — separated, not folded into certified pair totals

Six extra PTY invocations (`pty-probes.py`, `pty-probes.log`, scratch `wide-q2zpo068/pty.json`) exercised setup numeric-string/boolean/array/null overrides and a throwing provider object. Captured merged terminal streams are decoded in that JSON. Five frozen invocations abort at the second blank optional prompt (`The operation was aborted`, exit1), while Rust completes (exit0); this direct Bun readline/PTY result **does not establish generated-config parity or isolate a stored-cell regression**. They are explicitly **inconclusive for model-limit output**, not treated as passing or added to the main 1,918 pair count. The sixth provider-object case fails before prompts with frozen `No default value`, while Rust completes; it confirms I1 but is also left out of the certified count to keep the main reproducible nonterminal count stable. No masks or gate claims depend on these runs. No panic markers in any decoded terminal stream. Driver exits 0 merely mean the exploratory capture completed, not equivalence. This is why interactive config generation remains unverified.


### Exact I1/I2 seed schema recipe

Initialize only the scratch root with frozen `status --json`. Insert credential `('q','openai','quota','oauth',created_at=1,updated_at=1)`; key `('k','k','p','h',created_at=1)`; `virtual_models('v','[]','weighted',0)`. Recreate api_keys/credentials/virtual_models/settings with their original named columns but **without affinity**, retaining id/key PRIMARY KEY (runner source enumerates PRAGMA table_info), so malformed stored cells survive SQLite coercion and match hand-altered-table ruling. Then apply one exact UPDATE from the finding to each fresh copy before invoking its command. Ordinary schema TEXT targets also preserve all I1/I2 JSON examples: affinity-free tables are not the cause of their mismatch. No credential data from real HOME is required.

### Accepted difference wording is not a blanket

Quota **human renderer only** includes the user's numeric-TEXT example and malformed-window burn percentages/ages/labels. Its upstream raw JSON projection is outside that exception (I3). `models put` **pinned/custom credential resolution only** may retain non-string id/provider/label/authType behavior differences; no exemption for all model commands, all credential columns, provider_data JSON parse, setup model-limit coercion, or arbitrary CLI output. If either scope is meant broader than the stated ruling, that requires a new explicit ruling, not reviewer inference.

### Search counts by file

| File | matching lines |
|---|---:|
| `crates/omni-cli/src/models.rs` | 11 |
| `crates/omni-cli/src/mutations.rs` | 7 |
| `crates/omni-cli/src/output.rs` | 5 |
| `crates/omni-cli/src/setup.rs` | 12 |
| `crates/omni-cli/src/status.rs` | 23 |
| `crates/omni-control/src/keys.rs` | 12 |
| `crates/omni-control/src/credentials.rs` | 22 |
| `crates/omni-control/src/models.rs` | 5 |
| `crates/omni-control/src/cli_cell.rs` | 2 |

This tally does not include `if let Number`, `matches!`, or eager `text()` as regex hits; they were found by following value flows and are covered by the explicit findings. Grepping only the prescribed method spellings would miss them.


### Audit-to-finding connection

- Raw `.as_f64()` in expiry was repaired by scalar_number; original R4 closed. New setup Number-only `if let` is a **different consumer**, not reopening expiry.
- `.as_str().unwrap_or("")` in models-put terminal credential tuple is the expressly accepted pinned/custom difference, not a finding on this branch.
- `setup::string(...).unwrap_or_default()` remains observable when provider object's ToString throws; upstream frozen property-key coercion throws, Rust silently picks no catalog/provider (I1).
- `models::text()` is a conversion rather than an `as_*` call, but eager conversion of raw model/account table values changes error precedence (I2).
- `sql_value` is lossy BLOB/TEXT conflation. It is listed in the sweep but its effect reaches `status --json`, which the human quota waiver does not cover (I3). Repair cannot loosen HTTP health projections.

The report distinguishes executable-byte equivalence from intended user semantics: even both-exit1 stderr differences are Important under the frozen exact-byte contract. No finding depends on dynamic timestamp text or JSON property-order normalization.


### Normal-schema confirmation (I1/I2 are not hand-altered-schema artifacts)

`repro-normal-schema.py` skips all affinity-free table reconstruction, retaining stock migrated schema. The same 20 complete-target pairs produce **12 equal / 8 different**: setup contextWindow/maxOutputTokens/provider object errors and models-show model/account raw-table precedence. Evidence `wide-pz_n2feu`, log/exit `repro-normal-schema.*` (exit1 asserted mismatch). Frozen/Rust streams and codes are the same as complete-target I1/I2 reproductions above. This is an additional independent run, not eight new finding classes.

**Updated supplemental CLI count including focused R1–R5 and normal-schema confirmation: 1,938 pairs = 1,863 equal + 75 different; 24 differences inside accepted human quota scope, 51 unaccepted mismatches (including repeated reproductions).** Six exploratory PTY pairs and two accepted-quota proof pairs remain separately disclosed, not folded into certified comparison counts. Original five corpora are separate again. Earlier subtotal tables remain valid for their explicitly named groups.


### Current verdict summary

REQUEST CHANGES remains warranted at 54d73636 despite green wide/extra reruns. Three Important consumer families have **51 unaccepted paired mismatches in 1,938 supplemental runs**; 24 additional human quota differences are allowed. M1 is an inherited direct-helper arithmetic-precision limitation, not demonstrated current expiry output regression. Neither green R1–R5 focused checks nor existing corpus histograms cover these new consumers. Exact frozen code hashes/source diff, exact Rust binary hash, no product edits, strict-reader byte comparison and Cargo gates are independently established. No claim of total branch/CLI equivalence or approval.


## FINAL measured results — all requested runs finished

**Final verdict: REQUEST CHANGES at 54d73636.** No Critical findings; **3 Important (I1–I3)** and **1 Minor (M1)**. Original R1–R5 are closed within their precise scopes. Two accepted differences remain scoped exactly as above, not extended by inference.

### Own five corpora (sequential, reviewer-built copied binary)

| Corpus | pairs | nonexcluded failures | exclusions | exit |
|---|---:|---:|---:|---:|
| stored-cells | 1,045 | 0 | 0 | 0 |
| neighbors | 3,806 | 0 | 6 preexisting | 0 |
| neighbors-targeted | 8 | 0 | 0 | 0 |
| wide (complete rerun) | 4,236 | 0 | 0 | 0 |
| extra (complete rerun) | 180 | 0 | 0 | 0 |
| **Total** | **9,275** | **0** | **6** | |

These are 9,269 nonexcluded passes plus six exclusions, not universal equivalence. Original histograms match; stored-cells and targeted have the state-coverage limits disclosed above. No exclusions were added to any corpus or supplemental probe. The initial interrupted wide attempt is retained and not counted as completed or passing.

Exit-file lines quoted verbatim:

```text
env -i [isolated HOME/PATH/PYTHONPATH] OMNI_CLI_BIN=review/omni python3 conformance/cli/stored-cells.py [scratch evidence-prefix copy] exit=0
env -i [isolated HOME/PATH/PYTHONPATH] OMNI_CLI_BIN=review/omni python3 conformance/cli/neighbors.py [scratch evidence-prefix copy] exit=0
env -i [isolated HOME/PATH/PYTHONPATH] OMNI_CLI_BIN=review/omni python3 conformance/cli/neighbors-targeted.py [scratch evidence-prefix copy] exit=0
env -i [isolated HOME/PATH/PYTHONPATH] OMNI_CLI_BIN=review/omni python3 conformance/cli/wide.py [scratch evidence-prefix copy] exit=0
env -i [isolated HOME/PATH/PYTHONPATH] OMNI_CLI_BIN=review/omni python3 conformance/cli/extra.py [scratch evidence-prefix copy] exit=0
cargo build --offline -p omni-cli exit=0
cargo test --offline --workspace exit=0
cargo clippy --offline --workspace --all-targets -- -D warnings exit=0
cargo fmt --all -- --check exit=0
git diff --exit-code 21348e06..HEAD -- row.rs error.rs pg api.rs gateway gateway-core exit=0
git diff --exit-code 1780bb39 -- apps packages exit=0
```

### Final panic audit

`scan.py` rerun after both corpora finished: **59,538 decoded child records; 0 panic markers; 0 exit 101/134/−6**. This equals three complete five-corpus sets (reviewer, implementer final, controller final: 9,275 × 2 sides × 3 = 55,650 records), plus own supplemental/focused/normal-schema runs (1,938 × 2 = 3,876), plus six exploratory PTY pairs (12). Decoder scans both TS and Rust `err` hex and checks panic markers/codes; PTY captures are merged terminal text. Paths/counts in final `panic-scan.json`. Separate accepted-quota proof's four plain-text outputs also contain no panic markers and exit0. Workspace test log has no FAILED/panicked/error and all gates0. The interrupted first wide attempt's in-memory child outputs cannot be recovered, so **that incomplete attempt is not fully panic-auditable**; the complete rerun is fully decoded. No claim that unexecuted arbitrary inputs cannot panic.

### Final counts and limitations

- Five original corpora: **9,275 pairs**, **0 nonexcluded failures**, **6 inherited exclusions**.
- Certified supplemental/focused/normal-schema probes: **1,938 pairs**, **1,863 equal / 75 different**; **51 unaccepted differences** (reproductions included), **24 accepted human-quota differences**. All 21 quota JSON mismatches remain Important I3, not waived. Six exploratory PTY pairs are separate/inconclusive for generated limits; one confirms provider I1. Separate accepted-quota proof: 2 pairs, 1 equal/1 accepted human difference.
- Direct helper comparison: **2,551 inputs**, **2,454 equal / 97 different**, with the 97 long-radix arithmetic discrepancies classified M1; 51 broad scalar inputs and 1,500 safe-integer radix/current-epoch-boundary inputs match Bun.
- Cargo workspace: **1,265 passed / 0 failed**, summed 19 ignored; no retry. Clippy/fmt/build0. Typed functions byte-identical; boundary diff empty.
- **Unverified:** exhaustive interactive generated-config limits (exploratory frozen PTY aborted at blank prompt), arbitrary nested JSON/all SQLite domains, full pinned/custom credential combinations within accepted models-put scope, independent rerun of controller's 53-driver matrix, every intermediate historical binary, and all stderr from interrupted wide attempt. Controller exit files were verified read-only, not represented as my reruns.

Final copied binary still SHA256 `3d6a26560244dcefa892165e2b885608e69048e0bc7825a427442fe5098102ea`; HEAD still 54d73636. Disk at final check **5.1 GiB** (above cutoff); no more builds started and no evidence deleted. Only tracked dirty file remains the old e1-e5-report.md; review4.md exists as a new ignored/uncommitted file. No product edits or commits. The accepted exceptions do not justify I1/I2/I3, so branch-wide approval is withheld across all rounds.
