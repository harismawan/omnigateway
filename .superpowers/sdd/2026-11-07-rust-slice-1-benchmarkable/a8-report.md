# A8 — partial: login/logout/summary/logs delivered; three GET routes remain

**NEXT STEP:** implement usage with a failing comparison first, the shared `clientFixture`, the verified session scope, five forwarded parameters and the existing direct bucket writer. Then quota/history. Resolve the offset requirement against the bootstrap evidence below before changing behavior. Complete remaining session-expiry and unusual-cell coverage gaps.

## Status and commits

Partial increment, not A8 complete. No subagents, pushes, merges, dependencies or unsafe code. Product TypeScript untouched. Login uses existing `AdminAuth::login_client`, JSON-field reader and cookie helper. Logout reuses the existing logout handler. Frozen `loginClient` has no attempt accounting/rate limiter; neither does Rust's existing operation. Both hash and look up unknown/revoked keys; no timing equalization or empirical timing claim is made.

| Route | Status | Commit | Comparison evidence |
|---|---|---|---|
| POST login | Implemented | `b4d8ffe1` | `login-red.log`: 22 equal / 34 failures; `login-green.log`: 39 equal / 0 failures |
| POST logout | Implemented | `6861c046` | `logout-red.log`: 13 equal / 12 failures; `logout-green.log`: 19 equal / 0 failures; `logout-session.log`: 21 equal / 0 failures |
| GET summary | Implemented; coverage gaps below | `2493a8a9` | `summary-red.log`: Rust 404; `summary-green.log`: 183 equal, 0 failures; final full driver below |
| GET logs | Implemented | `b5973bb3`, `20cddcbc` | `logs-red.log`: 186 equal / 368 failures (Rust 404); `logs-green-final.log`: 371 equal / 0 failures; malformed degradations RED 376 equal / 6 failures, GREEN 379 equal / 0 failures |
| GET usage | Not started | — | No comparison or isolation evidence |
| GET quota | Not started | — | No comparison or isolation evidence |
| GET quota/history | Not started | — | No comparison or isolation evidence |

`bbc20d35` adds minted-client logout coverage and sorts Rust module declarations; `73f57924` adds login/logout to surface comparisons. Counts above include database comparisons; failures include independent expected-status failures as well as byte differences. Before implementation Rust returned 404 NOT_FOUND on both POST routes. The first exploratory login fixture failed because it assumed an `enabled` column on api_keys; fixed to use expiry before recording RED. The first build exposed private shared helpers; their visibility is now crate-only. One copy command used the wrong binary filename and failed before any comparison; actual binary is `target/debug/omnigateway`.

Login cases assert statuses for malformed/empty JSON, primitive/non-object JSON, missing/non-string keys, unknown key, usable key, expired key, revoked key, and forwarded-proto forms. Cookie normalization validates a 43-character base64url token and compares remaining attributes. Logout checks anonymous/viewer/admin calls and loss of operator access, secure forwarded cookie, and a freshly minted client cookie. Client-session deletion itself is covered by existing auth tests, not a newly ported protected client GET.

Shared fixture extraction: `fd7ed178`, `fixture-extract.log`: 183 equal / 0 failures, unchanged summary behavior. Fixture includes real A/B/C traffic, revoked caller, sessions, and both admin/client cursors; expiry after login is applied by each consuming configuration.

## Isolation evidence

Logs: all ten forwarded filters, invalid cursor/time/state, duplicate/encoded/case-varied names, ignored identity/grouping overrides, A's client cursor and A-scoped admin cursor compare equal. Every B response is directly scanned (headers and body) for A/C markers and `secret-credential-`; excluded degradation entries are seeded for every key and removed in the explicit 19-field projection. B pages to completion using its own cursor (three distinct SQL rows), with real traffic additionally present. Admin/viewer/anonymous/revoked callers and expired-after-login C are refused before malformed query processing. Own text/BLOB/invalid UTF-8/huge integer/NULL cells pass. Initial green had six fixture expectation failures: `state=completed` is invalid (TS accepts pending/done); byte equality already passed. Corrected expected status and reran. No product TS edits.

Summary: three logged-in keys A/B/C have distinct marked labels/prefixes, SQL log rows and real `/v1/chat/completions` traffic through the stub. Each caller (A/B/C, admin, viewer, anonymous, revoked-after-login) is compared with an explicit expected status across 12 queries: identity/credential overrides, apiKey grouping/splitting, admin and client cursors, duplicate names, percent encoding, case changes, bogus offset and invalid filters. Every B answer's headers and body are directly checked for absence of A/C markers. C expired after login is separately refused. Summary ignores all query parameters, as frozen TS does. Both binaries now mint real client cursors and check them against scoped admin cursors. Unusual B display cells (text, BLOB, invalid UTF-8, huge integer, nullable fields) match TS without process failure. Zero, 345 and unset offsets pass; unset also passed under `TZ=Asia/Kolkata` in the previous increment. Usage has no route isolation evidence yet. Frozen quota intentionally discloses named accounts.

Implementation authorizes before opening the bounded read-only report lane; the opening task owns the permit. Lookup is a single verified-session key, never a list or URL identity. Shared summary construction is retained, with lossless display-cell replacement because the existing typed operator reader rejects BLOB labels/prefixes.

## Gates (all waited for and results read)

### Logs increment (2026-11-14)

`manifest.json.logs_increment` identifies external `/tmp/opencode/a8/rust-logs-final`, source `c23a43e2`, and SHA256 for it and the unchanged TS artifact. Full admin/surface ran with `/tmp/opencode/a8/rust-logs` (`20cddcbc`); the final lint-only cleanup `c23a43e2` rebuilt to the IDENTICAL SHA256 `17327efa83db9b082806576e5014df4d6d78c5f91c73baf89f2ee6d91c3630aa` and targeted logs reran against it. Commands follow the commands below with those binary paths; targeted configs use `--only client-logs`. Build logs: `logs-final-build.log`, `logs-rebuilt.log`. Initial workspace command was terminated at its 120-second shell timeout during adversarial tests, then rerun with no timeout (`logs-workspace-final.log`); do not interpret the interrupted `logs-workspace.log` as a completed gate. All Cargo checks use the three required environment settings.

| Gate | Result | Log |
|---|---|---|
| shared summary extraction | 183 equal, 0 failures | `fixture-extract.log` |
| final targeted logs | 379 equal, 0 failures | `logs-degradations-green.log` |
| final lint-clean binary logs | 379 equal, 0 failures | `logs-lint-green.log` |
| cargo test --offline --workspace | 1050 passed, 0 failed, 7 ignored; 117 summaries | `logs-workspace-final.log` |
| cargo clippy --offline --workspace --all-targets -- -D warnings | Passed after collapsing one nested if | `logs-clippy-fixed.log` |
| cargo fmt --all -- --check | Passed | `logs-fmt-fixed.log` |
| admin-routes full | 3756 equal, 10 expected divergences, 0 failures, 38 minted | `logs-admin-full.log` |
| surface | 614 equal, 61 expected divergences, 0 failures | `logs-surface.log` |

Malformed degradation comparison: `logs-degradations-red.log` against the first logs binary showed TS 500 vs Rust 200 for `{}`, `[1]`, and `null` (6 failures including expected statuses). `20cddcbc` propagates generic internal errors as TS does; invalid JSON also yields 500. The supplemental RED was run against the previous binary after the source fix was written, before its build; it is not claimed as test-first source development.

All runs waited for and results read. Final targeted rerun initially collided with the full driver's port, then passed with `A7_TEST_PORT=18543`. Its empty scratch directory was removed; all completed driver scratch self-removed. Older unrelated scratch was left alone. Admin-auth and run.ts were not rerun in this increment (previous passing evidence below). `progress.md` changed externally during this session and was not staged.

### Summary increment (2026-11-14)

`manifest.json.summary_increment` records commit `2493a8a9`, SHA256 and external binary `/tmp/opencode/a8/rust-summary`; TS is the same `/tmp/opencode/a8/ts` artifact below. Fresh post-commit build: `summary-final-build.log`. Commands use the previous commands with `--rust /tmp/opencode/a8/rust-summary`; targeted configs are `client-summary-0`, `client-summary-345`, `client-summary-host` (also `TZ=Asia/Kolkata A7_TEST_PORT=18543`). All Cargo commands use the three required environment settings.

| Gate | Result | Log |
|---|---|---|
| cargo test --offline --workspace | 1050 passed, 0 failed, 7 ignored; 117 summaries | `summary-workspace.log` |
| cargo clippy --offline --workspace --all-targets -- -D warnings | Passed | `summary-clippy.log` |
| cargo fmt --all -- --check | Passed | `summary-fmt.log` |
| summary UTC final fixture | 183 equal, 0 failures | `summary-green.log` |
| configured 345 / unset offset (before extra cursor case) | 169 equal each, 0 failures | `summary-offset.log`, `summary-host.log` |
| unset offset, Asia/Kolkata final fixture | 183 equal, 0 failures | `summary-host-nonutc-final.log` |
| admin-routes full, before extra cursor case | 3335 equal, 10 expected divergences, 0 failures, 38 minted | `summary-admin-full.log` |
| admin-routes final rebuilt binary and fixture | 3377 equal, 10 expected divergences, 0 failures, 38 minted | `summary-admin-final.log` |
| surface final rebuilt binary | 612 equal, 61 expected divergences, 0 failures | `summary-surface-final.log` |

RED preceded implementation (`summary-red.log`, Rust 404, 161 failures including status and initial nondeterministic cursor case-name mismatches). Three initial fixture SQL attempts failed before comparison (wrong column names/placeholder count); corrected before RED. The initial green comparison exposed case-name nondeterminism, corrected by naming cursor cases independently of token bytes. Unusual-cell testing observed TS 200 versus Rust 500; corrected and rerun green, overwriting that run's log, so **no durable separate unusual-cell RED artifact is claimed**. `summary-red-final-fixture.log` replays the expanded fixture against the old binary (164 failures); it is supplementary, not the pre-implementation proof. Successful driver scratch is self-removed; own failed fixture scratch was removed. No other agent scratch removed.

### Previous login/logout increment

Evidence root `/tmp/opencode/a8/`; binaries copied outside checkout. `manifest.json` gives full Rust build commit, driver commit, TS artifact provenance and SHA256 for both binaries (plus login-only binary). Rust build commit `6861c046`; later Rust source edit is module ordering only. TS copied from the A7 fix2 artifact whose manifest names `d0c11d29`, unchanged frozen product TS.

| Gate | Result | Log |
|---|---|---|
| cargo test --offline --workspace | 1050 passed, 0 failed, 7 ignored, 117 result summaries incl. doctests | `workspace.log` |
| cargo clippy --offline --workspace --all-targets -- -D warnings | Passed | `clippy.log` |
| cargo fmt --all -- --check | Passed after module-order fix | `fmt.log` |
| admin-routes (full, with both client configs) | 2828 equal, 10 expected divergences, 0 failures, 38 raw keys minted | `admin-routes.log` |
| admin-auth | 212 equal, 4 expected divergences, 0 failures, 116 distinct tokens | `admin-auth.log` |
| surface final | 610 equal, 61 expected divergences, 0 failures | `surface-final.log` |
| run.ts | All 41 request rows equal; DB logs 37, daily 18, rollup 6, credential health 4 | `run.log` |

Rust build/test/clippy used `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0`. Existing slow-reader gate ran in the full admin driver: Rust idle median 4.580ms, loaded median 2.686ms (15 samples, bound 10ms), raw `admin-routes/slow-reader-rust.json`. Other drivers used distinct existing ports; no runs remain outstanding. Successful admin driver removes its scratch itself; removed this session's initial failed client-login scratch and run.ts scratch after recording results. No large fixtures copied.

Commands: `bun conformance/e2e/admin-routes.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a8/rust --out /tmp/opencode/a8/admin-routes` (targeted runs add `--only client-login` or `--only client-logout`); analogous admin-auth.ts and surface.ts with their `--out` directories; `bun conformance/e2e/run.ts --ts /tmp/opencode/a8/ts --rust /tmp/opencode/a8/rust`.

## Differences, gaps, concerns

- Three GET routes retain unimplemented behavior: usage, quota, quota/history. Logs uses the bounded report reader after authorization and overwrites scope from the verified session.
- Existing oversized-body difference is precisely four admin-auth requests: POST `/api/login`, `/api/setup`, `/api/logout` declaring Content-Length 134217729 (128 MiB + 1), and POST `/api/login` sending that many bytes chunked. TS sends status 413 with no headers and an empty body; Rust sends status 413, `content-length: 0`, and an empty body (normalized `413\n\n\n` versus `413\ncontent-length: 0\n\n`). Client-specific oversized/chunked-over-limit cases, configured HTTPS base URL, poisoned limits, Unicode keys and timing measurements remain coverage gaps.
- Coverage gaps: no expired-session-token case (key expiry is covered); no key-disable field exists; no summary limit-counter fixture or empty-log variant; unusual limits/allowlist cells remain typed and unverified. Shared fixture now supports summary/logs and can be reused for usage. It has marked requested/resolved models, error codes, key labels/prefixes and degradation entries, but not every possible visible text column; request logs have no error-message column. Logs filter comparisons use the deterministic SQL time window; real traffic is seeded but its client log output is not compared. These are unfinished acceptance coverage, not claims of complete brief compliance.
- Offset investigation (item 1, no code change): both TS route factories call `deps.dayOffsetMinutes ?? hostDayOffsetMinutes()` per request (client.ts:110, admin.ts:604). However frozen `packages/control/src/config.ts:140` resolves absent/invalid configuration at boot and `apps/gateway/src/index.ts:345` ALWAYS passes that number; app.ts:445–469 forwards it to both factories. Thus the actual frozen binary and Rust both retain the boot value through DST. Changing only Rust for an unset environment variable would introduce a difference. No injectable optional-offset Rust route-factory API exists; no DST simulation was run. The requested change is blocked on reconciling route-factory semantics with frozen executable semantics; operator routes remain unchanged for the same reason.
- Surface had no client GET expected-divergence rows to move. Added anonymous logs in both static configurations after summary; expected divergences remain unchanged. Usage still needs a surface case.
- D4 Postgres must wire scoped own-key lookup/summary counters, scoped log paging and projected rows, scoped usage direct writer, credential/quota-window/sample readers and retained-span/sample-limit behavior to a bounded independent reader lane. Existing session auth must use the Postgres key usability lookup too. No Postgres implementation here.
- `bun.lock`, untracked 2026-10-24 specs, stash and other worktrees untouched. At final status, `progress.md` also appeared modified externally during this session; it was neither edited nor staged here.
