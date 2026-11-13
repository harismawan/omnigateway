# A7 checkpoint — SQLite usage implemented; increment incomplete

**Precise next step:** finish `/api/usage` coverage before starting `/api/logs`: add a PostgreSQL aggregate reader with a live isolated postgres:17-alpine oracle; add usage assertions over real `/v1` traffic, fixed nonzero day offsets, preboot/live pending rows, malformed/raw cells, duplicate filters and invalid UTF-8 URL decoding. Then read `packages/control/src/logs.ts` and `packages/store/src/logPage.ts`, add independent HTTP RED for `/api/logs`, implement it and commit separately. Export and nodes remain unimplemented.

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
