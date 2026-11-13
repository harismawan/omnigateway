# A7 checkpoint — SQLite usage implemented; increment incomplete

## Latest continuation: typed reader and log parity fixes

**NEXT STEP:** resolve lone-surrogate cursor comparison against a real SQLite TS oracle before export: the typed cursor now retains UTF-16 but store binding still uses `String::from_utf16_lossy`, so the known identity concern is not closed. Exercise canonical lone-surrogate cursors against actual replacement-character IDs, including equal timestamps and ordering. Add the remaining unsafe-number Infinity and broader cursor mutation vectors. Then read frozen export implementation/handler, establish byte-level CSV/JSONL RED, and iterate this typed reader with first chunk awaited before response construction; verify cancellation, slow-reader writer progress, and three-run RSS ranges. Nodes remains subsequent scope.

| Requirement | Commit | Independent evidence under `/tmp/opencode/a7-parity/` |
|---|---|---|
| Typed store filter interface; all values including limit bound | `73c918de` | Existing logs corpus `typed.log` passes; structural refactor, no behavioral RED claimed |
| Exact provider pattern, negative unsafe integer, safeToken unknown key, permissive cursor decode/version order | `ca1f39f0` | `red.log`: 39 equal / 20 failures → `green.log`: 53 equal / 0 failures |
| BLOB degradations JS coercion | `ca1f39f0` | `cells-red.log`: TS 500 versus Rust 200 → `cells-green.log`: 17 equal / 0 failures; invalid two-byte and valid single-byte blobs |
| Full cursor traversal, newer insertion between pages | `ca1f39f0` | `walk.log`: 157 equal / 0 failures; 503 original IDs exactly once across 17-row pages; no independent RED |
| Empty table, text numeric cell, BLOB duration, NULL resolved model, valid RTK arrays | `ca1f39f0` | final driver; cells fixture; no independent RED except BLOB degradations above |

Store Query fields are explicit time bounds, failed/state, provider, requested/resolved/either model, error code, key/account IDs, UTF-16 cursor and limit. SQL text no longer crosses its API. Frozen logFilterSchema has no RTK filter input, so none was invented; RTK arrays are row output and whitelist-filtered. Multi-byte Uint8Array stringifies to comma-separated decimal bytes before JSON.parse, which correctly fails for the tested blob; a single byte parses as a number.

Final gates on implementation commit `ca1f39f0`, both binaries freshly built outside checkout; manifest commit/SHA256 written before driver runs: `/tmp/opencode/a7-parity/manifest.json`. Workspace **1046 passed / 0 failed / 7 ignored** (`workspace.log`); all-target workspace clippy clean (`clippy.log`); fmt clean (`fmt.log`). Admin-routes **2080 equal / 2 expected / 0 failures**; admin-auth **212 equal / 4 expected / 0 failures**; surface **606 equal / 61 expected / 0 failures**; run.ts **all rows equal** (matching log names). Incremental/debug disabled.

Status: **partial checkpoint, not complete for review**. Known unresolved issue: lone-surrogate cursor binding. Additional coverage caveats: overflow-to-Infinity schema wording, exhaustive malformed cursors, and schema-excluded NULL measures remain unchecked. Export not started; no three-run export RSS/cancellation/writer-progress claims. PostgreSQL report readers/backend routing and live HTTP conformance remain D4. Earlier historical next-step lists below are superseded by this section.

## Latest checkpoint — initial logs, 598f5aaa

**NEXT STEP:** finish logs traversal and adversarial conformance before export. Add a driver step that follows every returned cursor over all 503 seeded rows, inserts a newer row between pages, and asserts no duplication/omission of original rows. Add empty-table, unusual-cell, valid RTK filter, malformed cursor variant and validation boundary cases. Then export's precise next step is to read frozen `exportLogs`/CSV serialization and admin handler, add independent byte-level HTTP RED for CSV/JSONL, and iterate the bounded store page reader with the first chunk awaited before building the response. Do not collect an export; verify cancellation and writer progress with a slow reader.

Commit `598f5aaa`: additive `omni-store::logs` page reader (limit+1, descending at/id, raw-cell JSON conversion), control validation/opaque cursor, guarded GET/HEAD route; usage traffic fixture. Requirement → test map: route/filter/default/cap/guard/cursor malformed → `red.log` **80 equal / 150 failures** against old Rust → `green2.log` **155 equal / 0 failures**. Invalid time error text independently mismatched real TS in `green.log`, corrected to `since: Invalid input`. Every log HTTP case asserts status independently. Usage real request → `traffic-green.log` **9 equal / 0 failures**: exactly one upstream request and one usage bucket, requests=1/input=1/output=1/errors=0, only duration normalized after finite/range validation. Its initial failure was a test cookie formatting error, **not an implementation RED**. Usage and logs were committed together, not separately as requested.

Evidence `/tmp/opencode/a7-logs/`. Touched-crate tests **305 passed / 0 failed / 5 ignored** (`tests.log`); touched-crate all-target clippy clean (`clippy2.log`), fmt clean (`fmt.log`). Fresh TS and Rust binaries built at `598f5aaa`, outside checkout, manifest with hashes recorded before final driver. Final admin-routes **1997 equal / 2 expected / 0 failures** (`admin-routes-final.log`). Cargo incremental/debug disabled. No full workspace gate claimed in this continuation.

**Status: incomplete checkpoint, not complete for review.** Remaining coverage: traversal/insert-between-pages, empty log table, unusual log cells, valid RTK arrays, usage invalid UTF-8 dimension/ID and aggregate integer overflow. Known implementation concerns: provider validation is not yet an exact port of PROVIDER_ID_PATTERN; negative unsafe-integer error wording and safeToken unknown-key sanitization need correction; cursor decoding currently uses strict base64 before the TS version check (TS Buffer is permissive); lone-surrogate cursor IDs narrow through UTF-16-lossy conversion; raw BLOB degradations JSON coercion may differ. The page reader currently accepts internal SQL clauses assembled by control rather than typed filter fields. No export/nodes implementation. PG remains deferred to D4. These are explicit unfinished items, despite the ordinary corpus being green.

## Continuation checkpoint (89ecdb01)

**NEXT STEP:** add a usage-specific real `/v1` stub-upstream request, wait for its committed log, then assert `/api/usage` tokens/counts (normalize only validated nondeterministic duration/timestamps). Expand invalid UTF-8 tests to dimension and ID parameters (current vectors only exercise numeric fallback), and add integer-overflow aggregate error coverage. Then start `/api/logs` with independent real-TS HTTP RED, followed by export and nodes. PostgreSQL is deferred for every route to D4 per the revised instructions.

`89ecdb01` extracts SQL/label conversion into additive `omni-store::reports::usage`, with a defensive SQL expression whitelist. Control retains query validation. Driver now covers 300,000 raw rows across 10,000 keys and seven models (70,000 group/split tuples), +330/-480 minute daily-floor boundaries, a live inserted row with invalid UTF-8 TEXT, BLOB input tokens, text duration, invalid degradations, and a pending row. Five malformed query encodings exercise numeric fallback. All remaining legacy Database connections now set a bounded busy timeout.

**Memory:** neither frozen TS nor Rust has a fixed result bound. For a selected grain, output cardinality is the number of distinct selected group/split tuples among qualifying rows; it is at most the qualifying row count and at most the product of the two dimension cardinalities. An unbounded interval does not impose a fixed ceiling. Both aggregate in SQLite and materialize result buckets, not raw rows. TS additionally holds `.all()` aggregate records before mapping them. Rust directly collects mapped buckets. No new cap is imposed. Final 300k-row fixture VmHWM: **TS 152,852 kB; Rust 142,664 kB** (`admin-routes-final/usage-large-{ts,rust}-rss.txt`). Earlier isolated run: TS 151,060 kB / Rust 240,676 kB; process peaks vary with allocator/runtime behavior. These are Linux process high-water marks through all requests in the configuration, not a guarantee on arbitrary bucket cardinality.

Requirement → commit → test: store extraction, large-table memory, offsets, live/raw cells, malformed numeric query encodings, and legacy busy timeouts → `89ecdb01` → `usage-green.log` (449 equal), `large-green.log` (11 equal), `offset-green.log` and `offset-negative-green.log` (35 equal each), plus full final driver. **No independent behavioral RED occurred in this continuation:** the new tests were run against the old committed implementation before refactoring and already passed (`baseline.log`, `large-baseline.log`, `offset-baseline.log`, `live-baseline.log`). This is coverage plus a behavior-preserving extraction, not a newly fixed mismatch. The prior implementation RED evidence remains below.

Final gates run once against implementation commit `89ecdb01`; evidence `/tmp/opencode/a7-next/`:

| Gate | Result | Log |
|---|---|---|
| workspace tests | 1046 passed / 0 failed / 7 ignored | `workspace.log` |
| workspace all-target clippy -D warnings | clean | `clippy.log` |
| fmt | clean | `fmt.log` |
| admin-routes | 1833 equal / 2 expected / 0 failures | `admin-routes-final.log` |
| admin-auth | 212 equal / 4 expected / 0 failures | `admin-auth-final.log` |
| surface | 606 equal / 61 expected / 0 failures | `surface-final.log` |
| run.ts | all rows equal | `run-final.log` |

Both final binaries freshly built at the recorded commit and copied/compiled outside checkout. `manifest.json` records commit, SHA256s, and final driver log names before those driver runs. Build logs: `build-ts-final.log`, `build-rust-final.log`. Earlier exploratory runs reused the prior TS artifact and are not final gates. Existing unrelated working-tree lockfile/progress edits were preserved. No new known response mismatch; real-traffic usage assertion remains incomplete. Logs/export/nodes remain unimplemented. **Status: partial checkpoint, not complete for review.** D4 must add PG report readers beside the extracted SQLite reader and wire backend selection through control operations and HTTP, with live-PG conformance.

## Historical first checkpoint (superseded by continuation above)

## Changes

Commit `6d2a7a8e` implements GET/HEAD `/api/usage` on the existing independent control connection and blocking pool, with the reader guard first. New `omni-control::reports` validates grain/dimensions/IDs, implements JS optional-number coercion and daily flooring, and aggregates raw/daily SQLite rows. Response uses lossless JS JSON serialization; BLOB bucket labels stringify as comma-separated bytes. SQL expressions are selected from a whitelist. No writer connection or transaction is held by this query.

SQL currently lives in the control module; an additive store reader extraction would allow sharing with a future backend interface. No Postgres reader added in this checkpoint.

Permanent `usage` configuration in `conformance/e2e/admin-routes.ts`: 68 distinct requests × three caller roles, expected status independently checked; raw/daily dimensions and splits, invalid schemas, numeric fallbacks, duplicate grain, key/account narrowing, bounds, empty result, 20 raw and 8 daily rows, BLOB/empty/null labels, text and huge numeric measures. Fixture seed/copy connections now set a 5-second busy timeout. Other legacy driver connections still need the same pragma.

## Requirement → commit → evidence

| Requirement | Commit | Evidence under `/tmp/opencode/a7/` |
|---|---|---|
| Usage reader guard, schemas, all dimensions/splits | `6d2a7a8e` | `red-valid.log`: 191 equal / 372 failures against existing A6 Rust; `green-valid.log` passes empty-table corpus |
| Seeded aggregates, filters, unusual SQLite cells | `6d2a7a8e` | `seeded.log`: 411 equal / 2 failures; `usage-final.log`: 413 equal / 0 failures |
| Last duplicate query parameter wins | `6d2a7a8e` | Independently RED in seeded real TS-vs-Rust HTTP comparison, then fixed and GREEN |
| Regression gates | `6d2a7a8e` | table below |

The seeded aggregate corpus was added after implementation; only its duplicate-parameter finding has an independent behavioral RED. The earlier empty-table corpus had a real missing-route RED. Initial `red.log` additionally had an incorrect expected-status regex in the test; `red-valid.log` corrects it before implementation. Compilation initially needed adapting `JsValue` serialization to `json_ok(String)`. One attempted copy used the wrong binary name (`omni-gateway`, actual `omnigateway`), so `green.log` is not verification evidence.

## Verification

| Gate | Result | Log |
|---|---|---|
| Usage-only final HTTP | **413 equal / 0 failures** | `usage-final.log` |
| Entire admin-routes | **1716 equal / 2 expected / 0 failures**, 38 raw keys | `admin-routes.log` |
| admin-auth | **212 equal / 4 expected / 0 failures**, 116 tokens | `admin-auth.log` |
| surface | **606 equal / 61 expected / 0 failures** | `surface.log` |
| run.ts | **all rows equal**, four DB comparisons | `run.log` |
| cargo test --workspace | **1046 passed / 0 failed / 7 ignored** | `workspace.log` |
| clippy workspace/all-targets, -D warnings | clean | `clippy.log` |
| fmt check | clean | `fmt.log` |

All Rust builds used CARGO_INCREMENTAL=0 and disabled profile debug information. Outside-checkout binary `/tmp/opencode/a7/rust-final` was built from dirty `9624fa13` with the source subsequently committed as `6d2a7a8e`. TS reused `/tmp/opencode/a6-fix2/ts`; it was not freshly rebuilt. `manifest.json` records hashes and source qualifications for each substantive driver run, retrospectively. This does not satisfy the stronger fresh-binary/contemporaneous-provenance goal in full.

## Known differences / concerns / hand-off

- No mismatch in the exercised usage cases. URL parsing currently uses `url::form_urlencoded`; malformed UTF-8 and uncommon duplicate combinations need explicit oracle coverage.
- PostgreSQL, real-traffic usage verification, nonzero offsets, pending rows, comprehensive raw-cell adversaries remain unverified. Existing `run.ts` does exercise traffic and storage, but does not assert this new HTTP report over that traffic.
- Aggregation materializes all result buckets, as TS does. Unbounded high-cardinality report memory remains a concern relative to the brief's bounded-memory requirement.
- `/api/logs`, `/api/logs/export`, `/api/nodes` remain at their prior behavior. No export, paging, cursor, disconnect, or large-export claims.
- D4 must wire database selection through gateway/control readers and add PG implementations for these report operations (not merely select PgStore), then exercise HTTP and cross-runtime restart/cross-read against live PostgreSQL.
- Existing pinned divergences: 2 admin-routes, 4 admin-auth, 61 surface.
- No frozen TS, provider-owned files, CLI-owned files, lockfile, progress, user specs, stash, or other worktrees edited or staged; no unsafe, push, merge, or subagents.

Status: **checkpoint, not complete for review**. Route commit is green for the exercised SQLite corpus; remaining scope and qualifications above are deliberate hand-off items, not completed requirements.
