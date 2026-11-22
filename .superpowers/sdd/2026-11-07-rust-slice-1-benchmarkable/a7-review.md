# A7 independent review

**Verdict: changes required for spec parity.** No Critical finding. Two Important export defects reproduced; additional minor parity/test defects below. Reviewed detached `2e4458186b295abd0cafac0a5adeb6169a54885a`, range `9624fa13..2e445818`. No source edits or subagents.

## Important

### I1 — export revalidates its own cursor and aborts valid stored-row traversals
- Location: `crates/omni-gateway/src/admin_routes.rs:204-206`; `crates/omni-control/src/logs.rs:300-306`.
- Reproduction: seed 501 rows using `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<501) INSERT INTO request_logs(id,at,requested_model,status,duration_ms) SELECT printf('x%04d',i),100.5,'m',200,1 FROM n;` then authenticated `GET /api/logs/export?since=0&until=200&format=jsonl`.
- TS: 200, 501 complete JSONL rows. Rust: 200, only 500 rows, then broken chunked response. Reproduced for viewer and admin; process remains alive.
- Cause: TS `packages/control/src/logs.ts:385` passes the store cursor directly into the next store read. Rust serializes it to a public cursor, rebuilds the query, then applies the public safe-integer check to fractional `at`. Long/raw/non-string cursor IDs can encounter the same architectural problem. Preserve a typed internal store cursor for export; public cursor validation must remain for `/api/logs`.
- Evidence: `/tmp/opencode/a7-review/adversarial-out3/review-{ts,rust}.json`; normalized Rust output explicitly marks the incomplete framing `<TRUNCATED>`.

### I2 — CSV loses nonfinite numeric cells through a JSON round trip
- Location: `crates/omni-control/src/logs.rs:72,102-107` (page stringify at `:325-330`).
- Reproduction: `INSERT INTO request_logs(id,at,requested_model,status,duration_ms,cost_usd) VALUES('inf',100,'m',200,1,1e999);` then authenticated `GET /api/logs/export?since=0&until=200`.
- TS CSV contains `...,1,Infinity,[],false,...`; Rust contains `...,1,,[],false,...`. Both return 200. JSON/JSONL correctly use null, but CSV must use `String(number)`; negative infinity also needs its formula-guard apostrophe.
- Cause: `page_encoding` stringifies nonfinite numbers as null before `export_page` reparses them. Carry raw values to CSV rather than routing them through JSON. Same evidence directory as I1.

## Minors

- **M1 — blank limit differs:** `crates/omni-control/src/logs.rs:243-249` uses Rust `str::trim`, which does not remove U+FEFF. With at least 100 rows, authenticated `GET /api/logs?limit=%EF%BB%BF` returns 100 rows on TS, one on Rust (both 200). TS's JS trim treats this as absent; Rust converts it to zero and clamps to one. Reproduced in `adversarial-out3`; reuse the existing JS-whitespace helper.
- **M2 — export HEAD header differs:** `crates/omni-gateway/src/admin_routes.rs:217,223-241`: authenticated `HEAD /api/logs/export?since=0&until=200` has `transfer-encoding: chunked` on TS, no such header on Rust; both 200 and empty bodies. Reproduced for admin/viewer. HEAD usage/logs/nodes matched for all three roles.
- **M3 — driver cannot normalize streamed HEAD:** `conformance/e2e/admin-routes.ts:383-385` attempts chunk decoding whenever that header exists, even on a bodyless HEAD. Adding the M2 case makes the original driver throw `invalid chunk header` on TS before comparison. Make normalization method-aware. The scratch driver skips decoding empty HEAD bodies and explicitly marks incomplete GET framing to expose I1.

## Known contention: cause, not a new finding

- `ControlStore::run` (`admin_routes.rs:48-59`) holds its mutex for the entire closure. Export's closure includes store-row conversion, full-page JSON serialization, reparsing, and final CSV/JSONL serialization (`omni-control/src/logs.rs:72-90`), including the limit+1 sentinel row's conversion. Those redundant passes help explain the already-known 51–169ms page hold.
- SQLite runs inside `spawn_blocking`, not on Tokio async workers; no mutex guard spans an await. Release precedes yielding socket data. The request-log writer has a separate connection. A started blocking page can finish after cancellation, but stream drop prevents further iteration. Fixing only socket backpressure would not remove the encoding work under this shared mutex.

## Checks and scope conclusions

- SQL review: every filter/cursor/range/limit value is bound in `omni-store/src/logs.rs`; only fixed columns/operators are interpolated. LIKE escaping is backslash, percent, underscore in the correct order. Usage dimensions are matched to fixed expressions in control and independently whitelisted in store (`reports.rs:71-84`); no query-string SQL injection path found.
- Validation: read the complete TS schemas/control routines and Rust implementations; permanent matrices exercise enum errors, range/safe-integer errors, IDs, caps, strict keys, malformed/canonical cursor errors, duplicate parameters and malformed percent encoding. Error/status comparisons passed in the configurations below. M1 is an independently reproduced gap; exhaustive query-parser mutation equivalence is not established.
- Guards: all four handlers call `require_reader` before filter parsing or store operations; admin/viewer accepted and anonymous rejected in actual runs. Nodes ignores query values as TS does. No authorization widening found.
- Row conversion: raw numeric/text/null/BLOB/invalid-UTF8 handling and strict `rtkApplied` mapping follow TS; rtk filter allowlist matches. Malformed `degradations` can return 500 on both gateways, deliberately tested by `logs-cells`, rather than isolating that row. I1/I2 remain unusual-cell failures. No new `unsafe`, `unwrap()`/`expect()` error-path panic found in added modules.
- Export: bounded 500-row pages plus one sentinel, first read before response construction; not collected across pages. CSV column order, quoting, line endings and formula guard match on finite/text cases. Caller `cursor`, `limit`, and `format` are stripped before paging, including duplicates: appended cursors cannot be overridden by original values. Ordinary `(at,id)` keyset progression handles timestamp ties and newer insertions without replay. Deletions shrink results; concurrent inserts behind the cursor can extend the walk on both implementations. No general finite-duration guarantee under continuously inserted matching rows; no static-data loop found.
- Usage aggregates in SQLite, materializing aggregate buckets, not all raw rows; memory is O(distinct group/split pairs), as TS. Thus neither gives constant-memory unbounded-cardinality reports. Rerun `usage-large` (300k rows / 70k buckets) observed Rust HWM/RSS 250580/244900 KiB versus TS 143116/125308 KiB: substantial constant-factor overhead, not evidence of a leak. Integer SUM overflow reproduced with two `9223372036854775807` token cells: both return identical 500 INTERNAL bodies and keep serving.
- Nodes: bound strict `seen_at > now-60000`, descending order, raw-cell conversion and strict self equality match TS. Rust ID originates at `crates/omni-gateway/src/lib.rs:306`, fresh `clock::uuid_v4()`; TS uses a fresh UUID too. Driver independently inserts each `/health` ID and asserts self=true. Exact cutoff clock races were read, not experimentally synchronized.
- `async-stream = "0.3"` was already in gateway Cargo.toml at `9624fa13`; A7 adds a use, not a dependency/lockfile change. Generator drop is appropriate here; no unsafe added by the increment.

## Test credibility

- A7 ordinary HTTP cases supply explicit expected statuses, checked independently for each binary; transport failures fail comparison even before the status assertion. Real-traffic and traversal steps have independent semantic assertions. The expected-500 malformed-cell case does intentionally accept both gateways failing, because that is the frozen behavior.
- Comparisons preserve body bytes after dechunking, with clock-bounded date/download-name masks and existing ID/time masks; no broad A7 response mask found. Unique materialized step keys are checked. Missing HEAD coverage allowed M2/M3 through.
- Disconnect test can fail: requires successful headers/body, at least one Rust page event, at most one additional event after close, and successful follow-up. Rerun: close=1, after=2, follow-up=200. It measures a 500ms window, not indefinite cancellation or memory recovery; TS has no page counter. RSS snapshots are not return-to-baseline assertions.
- Slow-reader 2000ms admin bound cannot catch the known 55–144ms regression. Report's volume/refactor/traversal/self-identity coverage that never independently failed is useful regression coverage, not demonstrated fault detection. The disconnect RED only proved instrumentation was required, not detection of a deliberately broken cancellation loop.

## Executed coverage and evidence

- Read brief, report first 65 lines, all 1,472 diff lines in ~200-line sections, frozen admin/control/store references and dashboard client. PG readers, body/agent-setup routes and heartbeat writer treated as agreed deferrals.
- Verified manifest commit `e9a894795734099f1890536e46727e3792c34c72`; its only difference from snapshot HEAD is report text. SHA256 TS `420d48588d912ca7e8216792ba7a217bd3ad310066d0aea95ee1fbb500958e6f`; Rust `1c98c1437e013b3258b0e3571a253e3869ba2f28090c6f3087235c64b252e1b1`, both match manifest. Copied artifacts to `/tmp/opencode/a7-review/{ts,rust}` before execution.
- Driver `--only`: usage 449, logs 157, logs-export 47, nodes 29, export-volume-1 17, usage-large 11, logs-cells 17, logs-validation 53, logs-identity 53, export-matrix 173 equal; all zero failures. Logs/artifacts: `/tmp/opencode/a7-review/ok-<configuration>{.log,/}`.
- Detached worktree lacks Bun workspace dependencies. Driver seeding used `--cli 'bun /home/homebrew/code/omnigateway/apps/cli/src/index.ts'`; HTTP product artifacts and driver source remained frozen. Initial default-CLI attempts failed before route execution and are not counted as passes.
- `cargo test --offline -p omni-store -p omni-control -p omni-gateway admin`: 21 passed. Full store/control `--no-fail-fast`: 160 passed, 10 failed, 5 ignored; all 10 failures are Bun module-resolution failures (`@omni/*`, zod) in oracle/cross-read tests, not observed assertion mismatches. NODE_PATH retry did not resolve workspace packages. Evidence: `test-admin.log`, `test-store-control2.log` under review scratch directory. Full suite is therefore **not verified green** here.
- Targeted store/control/gateway `cargo clippy --offline --all-targets -- -D warnings` clean; workspace `cargo fmt --all -- --check` clean (`clippy.log`, `fmt.log`). Builds used isolated target directory, incremental off, dev/test debuginfo off.
- Additional executable scratch reproduction: `/tmp/opencode/a7-review/adversarial.ts`, results `adversarial-out3/` and `adversarial3.log`. This independently exercises I1/I2/M1/M2, all-route HEAD roles and aggregate overflow. No full workspace test, PG, long-duration multi-export stress, or deletion-during-export experiment was run.
