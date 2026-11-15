# Third-round independent review — REQUEST CHANGES

Range `e820b9da..39e1fa6fcd3adb0bbc244ae4f561e257d8a7c3fc`. All evidence below is under `/tmp/opencode/cli-fix4-review/`. Product files unchanged; prior report left dirty; no commits/subagents. Findings concern exact frozen parity, not desirable behavior changes.

## Panic result and earlier findings

**No observed Rust panic.** Decoded all3,806 implementer-final hex stderr records from `/tmp/opencode/cli-fix3/neighbors-q40lct_i/neighbors.json`: zero `panicked|RUST_BACKTRACE|thread 'main'` hits, zero exit101/134. Own stored/neighbors/wide/extra runs:9,267 pairs, zero such hits/exits; targeted8 also clean. This does not certify every possible stored value. Earlier16 panics are absent from both final reruns.

| Earlier finding | Disposition |
|---|---|
| N1 scalar identity/refusal | **Closed for reported cases**: numeric/BLOB/NULL lookups refuse correctly; INTEGER1 and TEXT'1' coexistence selects only text; targeted show/remove confirmations pass. |
| N2 REAL1 alias | **Closed**: original alias4/4, targeted and wider flag probes agree. |
| N3 null target/null-id prompt | **Closed**: original nested252/252, first/middle/last wrong-element shapes96/96, targeted null failure and null-ID prompt agree. |
| N4 key metadata/state | **Closed for reported cases**, wider consumers still fail below. Original other-column2016/2016; all32 former state mismatches now agree cell-by-cell except legitimate revoke times. |
| N5 label/credential projection | **Closed for reported label cases**; provider consumer still silently repairs non-string values (R2). |

Original1,045/1,045 equal. Neighbor closure gate:3,806 pairs,3,800 exact equal, six agreed exclusions (two random creates/four unimplemented credential commands), **zero deterministic failures**. Targeted8/8 equal. Thus the controller's specified corpus closure criterion is met; broader independent probes still find24 deterministic mismatches.

## Important findings

Reproduction fixture: same affinity-free tables/primary keys as committed corpus, model v/credential q/key k. Full seed, SQL, command/environment and complete outputs are in `wide.py`, `extra.py`, `wide-differences.txt`, `extra-differences.txt`; all commands include `--root <scratch root>`. Frozen command is Bun with `--no-env-file`; Rust is own copied build. Tuple notation below is `(stdout,stderr,exit)`. None of these read failures changed database state.

### R1 — Infinity is lost before key consumers see it
New `crates/omni-control/src/keys.rs:27–30` passes `Cell::Number` through `api::lossy` into serde Value: nonfinite numbers become null. `scalar_string` cannot recover the original type. Frozen `packages/store/src/sqlite/keys.ts:74–88` preserves raw scalar cells; interpolation and key state consume the original value.
- SQL `UPDATE api_keys SET label=1e999`; `keys expiry k`: TS `("id      k\nlabel   Infinity\nprefix  p…\nexpires: never\n","",0)`; Rust `("id      k\nlabel   null\nprefix  p…\nexpires: never\n","",0)`.
- Same SQL, `keys list`: both stdout empty/exit1; TS stderr `text.replace is not a function. (In 'text.replace(/\u001b\[[0-9;]*m/g, "")', 'text.replace' is undefined)\n`; Rust `null is not an object (evaluating 'text.replace')\n`.
- SQL `UPDATE api_keys SET expires_at=-1e999`; `keys expiry k`: TS `("id      k\nlabel   k\nprefix  p…\nexpires: — (expired)\n","",0)`; Rust `("id      k\nlabel   k\nprefix  p…\nexpires: never\n","",0)`. ±Infinity revoked_at likewise renders active instead of revoked. Fifteen edge mismatches total, including id/prefix. SQLite stores Infinity as REAL; NaN becomes NULL. Preserve nonfinite Number until the particular consumer, only JSON serialization should turn it into null.

### R2 — status still silently replaces non-string provider
SQL `UPDATE credentials SET provider=NULL`; `status`: TS `("","null is not an object (evaluating 'text.replace')\n",1)`; Rust `( "gateway         stopped (none)\nroot            /tmp/opencode/cli-fix4-review/wide/root\nadmin password  not set\n\nACCOUNT  PROVIDER  STATE    QUOTA\nquota              enabled  unknown\n", "",0)`. INTEGER2/REAL1.5/BLOB80ff also differ (TS non-string text.replace failure). Frozen `apps/cli/src/commands/status.ts:117–126` passes provider through its formatter to table; Rust `crates/omni-cli/src/status.rs:197–198` uses `.as_str().unwrap_or("")`. Four mismatches; --json agrees. Apply the consumer rule to provider as well as label; this is an existing adjacent consumer omission, not a new gateway issue.

### R3 — guardrail display treats non-string policy as absent
SQL `UPDATE api_keys SET guardrail_policy=2`; `keys guardrail k`: TS `("id      k\nlabel   k\nprefix  p…\npolicy:\n2\n","",0)`; Rust `("id      k\nlabel   k\nprefix  p…\npolicy: none; requests are not judged\n","",0)`. REAL1.5 and BLOB80ff also differ, frozen prints1.5 and128,255 respectively. Frozen `apps/cli/src/commands/keys.ts:745–750` tests exactly null then interpolates; Rust `crates/omni-cli/src/mutations.rs:335–337` tests `.as_str()`. Three mismatches; JSON and stored cells remain intact. Another preexisting consumer omitted from the carrier integration.

### R4 — numeric TEXT expiry comparison is not JS relational comparison
SQL `UPDATE api_keys SET expires_at='9999999999999'`; `keys expiry k`: TS `("id      k\nlabel   k\nprefix  p…\nexpires: —\n","",0)`; Rust `("id      k\nlabel   k\nprefix  p…\nexpires: — (expired)\n","",0)`. `keys list` likewise reports active in TS, expired in Rust; complete table bytes in extra-differences.txt. Frozen `packages/store/src/types.ts:732–735` uses `expiresAt > now` (ToNumber for TEXT), while Rust `output.rs:143–146` and `mutations.rs:315–318` require `as_f64`. Formatting's Number.isFinite correctly prints an em dash for TEXT on both sides; comparison has different semantics and must not reuse that check. Two mismatches.

### R5 — committed revoke state mask can hide unrelated changes
`conformance/cli/neighbors.py` final assertion rewrites **every** `1\d{12}` token on **every** api_keys INSERT, including label text, created_at, other rows and any future timestamp column. It is not a column-scoped revoked_at comparison. `mask-proof.txt` demonstrates two different INSERTs with unrelated timestamp-like values becoming equal. This weakens the no-masks ruling and the promise to catch unrelated write-back. Scope comparison to the target row/column and verify each side's timestamp against its invocation; preserve every other cell and storage class exactly. Current independent typed-cell checks found no actual unrelated write-back; this is a regression-quality finding, not evidence of a present product write bug.

## Probe counts and state verification

Original scripts copied from read-only first/second-review evidence; paths/env adapted, prior evidence untouched. Committed and original `reads/writes/cases` blocks byte-identical: **missing0/added0/reshaped0**, same seed/model inputs. Committed full stdout/stderr hex and exits are strict, but post-state uses dumps+mask instead of original byte equality. Our own run retains hashes/dumps and adds per-cell `typeof()` + `hex()` for keys/credentials/models/settings. Supplemental dump escapes invalid UTF8; equality claims for cells use storage-class/bytes, not that escaped string.

| Probe set/class | Pairs | Equal | Different |
|---|---:|---:|---:|
| Original stored-cells |1045|1045|0|
| Neighbors other columns |2016|2016|0|
| Neighbors numeric/BLOB |1404|1404|0|
| Neighbors nested |252|252|0|
| Neighbors order/multirow/setup-cells/identity/alias |122|122|0|
| Neighbors extra commands |12|6|6 exclusions|
| Focused confirmations |8|8|0|
| Wide key columns |2736|2733|3|
| Wide credential columns |684|680|4|
| Wide model columns |192|192|0|
| Wide numeric/BLOB scalar edges |360|345|15|
| Wide lookups/setup-shapes/two-cells |264|264|0|
| Extra model edges |120|120|0|
| Extra mixed INTEGER/TEXT identity |12|12|0|
| Extra date coercion |48|46|2|

Totals: **wide4,236/4,214/22; extra180/178/2**. Each original cell class95/95 (11 classes). Neighbor TS histogram unchanged2778/1026/2; stored734/256/55. Detailed per-column counts in counts.json; examples/complete streams retained. All mode pairs include text and --json. Additional key columns include hash, created/revoked_at, body_logging_opt_out, policy, smart_routing; credentials include every actual schema column, including provider/auth_type/enabled/disabled_at/token_version/updated_at and secret columns. Schema iteration proves no physical column omitted, though consumer/command cross-product is bounded (credentials status/setup/model-put; models list/show/rm/setup; keys reads and all existing mutation verbs).
Finite numeric edges:−0,1e21,1e−7,2^53+1,i64 extrema. BLOB empty/non-ASCII/valid text, string-spelling lookups, INTEGER1 beside TEXT'1', invalid UTF8, flags2/1.5/'1'/BLOB, multiple malformed cells, nested primitives/arrays/objects first/middle/last tested. Original corpus includes two malformed rows, order ties, two models. −1 boolean flags, every possible nesting/size and interactive setup output were not exhaustively tested.
Former32 state cases:16 smart-routing pairs now byte/cell equal;16 revoke pairs differ **only** at api_keys.revoked_at value, all storage classes and all other cells equal (`former32.json`). Across neighbors/wide/extra, typed-cell comparison finds **zero** non-excluded state differences after permitting only successful target revoke-time values, not blanket timestamp tokens (`*-state-differences.json`). No coerced unrelated cell written back or extra updated_at change observed. Physical byte equality: neighbors3614/3806, wide4002/4236; timestamps/random creations/SQLite layout prevent a blanket byte-equality claim. SQL-dump equivalence does not certify physical layout. No claim that Infinity's display-only type loss changes storage.

## Boundary and implementation quality

Call graph checked in source and callers.txt: models/credentials terminal projections use Cell; key CLI list/capture/require_key use private control keys::cli_rows; CLI commands call those. HTTP uses control::api key projection/mutations and models nonterminal branch; credential rows_with terminal=false retains safe provider_data/sql_value. Store snapshots/routing use existing typed readers; none calls Cell/table_text/scalar_string/control cli_rows. Public parse_stored_limits body is byte-unchanged (one visibility edit); existing store read_key and PG rows.rs:42,224 already called it, now control CLI projection also calls it. Its parser is shared, not new coercion; **no new gateway/PG path to carrier code**. New readers require SqliteStore; CLI remains SQLite-only.
Control key SQL matches typed reader: SELECT* WHERE id=? or ORDER BY created_at DESC, no revoked filter, same unspecified tie order. It duplicates schema names/flags but uses named columns; extra columns ignored like frozen, missing/renamed columns error rather than silently shift indexes. Newly exposed fields require deliberate projection updates. `hash` is deliberately not exported/parsed. Typed store reader remains unchanged.
Cell is coherent at input, but keys immediately converts it through lossy serde and consumers retain separate special cases (R1–R4). `database::bun_cell` is reused; JSON-input string() repeats a small match instead of Cell but has matching finite conversion rules. Scalar_string's unreachable arm assumes scalar-origin values; current callers receive raw cells, not arbitrary parsed containers. Fixed projection keys supply expects; examined index/cast sites and all-column probes found no panic. Existing limits/schema-normalized operations have bounded expects; not a formal proof against all operator data.

## Consumer-emulation inventory

| Frozen consumer | Rust implementation / result |
|---|---|
| output.ts:71 width(text).replace, table width/padding | table_text on key/model table cells and status label agrees for tested finite scalars/BLOB/NULL; status provider omitted (R2), key Infinity already lost (R1). Existing string width/padding retained. |
| Key mutation/revoke label/prefix template literals | scalar_string handles tested string/finite Number/BLOB/NULL; key Infinity lost upstream. Policy template omitted (R3). |
| Model show strategy field/template, model list raw table fields | carrier retains raw type; finite/nonfinite/BLOB model edges120/120 agree. Strict id equality no longer stringifies. |
| Setup ID array join and target iteration/property reads | null-aware join, string character-target treatment, null-element errors agree in original+96 shape probes; arbitrary nested behavior/interactive mappings not proven. |
| JSON serialization | Number nonfinite→null and bytes→indexed object match at wire; intermediate serde use before non-JSON consumers is wrong (R1). |
| Dates: Number.isFinite→new Date→ISO.replace/slice | output::time agrees on tested numeric/TEXT/BLOB/NULL/large dates; TEXT is intentionally not parsed for formatting. Relational expiry uses JS coercion separately and fails R4. Infinity/null state distinction fails R1. |
| enabled/smartRouting/isAlias ===1 | Integer1/REAL1 accepted, tested2/1.5/TEXT'1'/BLOB remain false, matching frozen. |
| Arithmetic/quota and direct .length/.slice consumers | Existing logic retained; basic malformed tier/weight/status cases agree, not an exhaustive proof of arbitrary runtime JS objects or all quota arithmetic. No blanket approval of open-ended emulation. |

Inherited behavior faithfully reproduced: non-string tables throw JS TypeErrors; malformed JSON can abort before any output; blobs interpolate decimal-byte joins but JSON emits indexed objects; JSON nonfinite values serialize null; random key outputs/time-based revokes differ naturally. These are not findings.

## Gates and provenance

Every crates/**/*.rs touched before first build; test.log shows workspace crates compiling from this checkout; fixture-proof.txt confirms rust-cli fixture path. Offline jobs2/incremental0/dev+test debug0, own ./target, sequential Cargo commands; disk16GiB before workspace test and15GiB before binary build, above5GiB cutoff. No flaky rerun.
Exact `.exit` lines:
```
cargo test --offline --workspace exit=0
cargo build --offline -p omni-cli -p omni-gateway exit=0
cargo clippy --offline --workspace --all-targets -- -D warnings exit=0
cargo fmt --all -- --check exit=0
```
Workspace185 summaries/1265 reported passes/0 failures/19 ignored. Logs test.log/build.log/clippy.log/fmt.log; own probe/catalog/neighbors/wide/extra/targeted commands all exit0 (probe scripts record mismatches rather than asserting none). Ten top-level logs scanned: `FAILED|panicked|^error` **0**; decoded child scan separately above, so hex cannot hide panics.
Own copied CLI SHA256 `b4f4f43438d88a2118641fb96465ab19f15185f0ee7b5eb9e5f62c750785e149`; gateway `637e1a022dd655aea4fa5f2fd8a3c48142769097a85825c6357ae8dae7d8ceda`; commit39e1fa6fcd3adb0bbc244ae4f561e257d8a7c3fc (commit.txt/sha256.txt). **Own hashes differ from controller's041fa933 CLI**, despite clean product tree/identical reported version; reason not established. All own results use these freshly rebuilt copies, not the retained implementer binary.
Controller done marker existed when checked once: matrix-summary records all listed drivers including neighbors/targeted exit0; e2e.exit0; **admin.exit1** (`SQLiteError: database is locked`, admin-routes.ts:2848). Copied summary in controller-results.txt; this is controller evidence, not own rerun or a demonstrated product regression. Did not occupy fixed-port drivers. No live ignored services, full gateway matrix rerun, or exhaustive interactive/huge-input verification. Cargo tests retain inherited temp paths; custom fixture roots/CLI HOME remained under review evidence, no real config used.

**Verdict: REQUEST CHANGES.** N1–N5's reported examples and both requested corpora are fixed; broader operator consumers still have24 reproducible parity mismatches and the committed post-state mask is too broad.
