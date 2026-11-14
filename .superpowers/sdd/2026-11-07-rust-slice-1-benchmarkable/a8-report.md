# A8 — partial: login/logout/summary delivered; four GET routes remain

**NEXT STEP:** logs, then usage: not started. Extract the three-key fixture currently inside the `client-summary` step into a shared setup for both routes. Read the frozen authorities, add failing comparisons, then implement and commit each route separately. The fixture currently expects Rust client logs 404 when obtaining A's cursor; replace that branch with a real Rust client cursor when logs is implemented. Complete summary coverage gaps listed below. **quota and quota/history: not started**.

## Status and commits

Partial increment, not A8 complete. No subagents, pushes, merges, dependencies or unsafe code. Product TypeScript untouched. Login uses existing `AdminAuth::login_client`, JSON-field reader and cookie helper. Logout reuses the existing logout handler. Frozen `loginClient` has no attempt accounting/rate limiter; neither does Rust's existing operation. Both hash and look up unknown/revoked keys; no timing equalization or empirical timing claim is made.

| Route | Status | Commit | Comparison evidence |
|---|---|---|---|
| POST login | Implemented | `b4d8ffe1` | `login-red.log`: 22 equal / 34 failures; `login-green.log`: 39 equal / 0 failures |
| POST logout | Implemented | `6861c046` | `logout-red.log`: 13 equal / 12 failures; `logout-green.log`: 19 equal / 0 failures; `logout-session.log`: 21 equal / 0 failures |
| GET summary | Implemented; coverage gaps below | `2493a8a9` | `summary-red.log`: Rust 404; `summary-green.log`: 183 equal, 0 failures; final full driver below |
| GET logs | Not started | — | No comparison or isolation evidence |
| GET usage | Not started | — | No comparison or isolation evidence |
| GET quota | Not started | — | No comparison or isolation evidence |
| GET quota/history | Not started | — | No comparison or isolation evidence |

`bbc20d35` adds minted-client logout coverage and sorts Rust module declarations; `73f57924` adds login/logout to surface comparisons. Counts above include database comparisons; failures include independent expected-status failures as well as byte differences. Before implementation Rust returned 404 NOT_FOUND on both POST routes. The first exploratory login fixture failed because it assumed an `enabled` column on api_keys; fixed to use expiry before recording RED. The first build exposed private shared helpers; their visibility is now crate-only. One copy command used the wrong binary filename and failed before any comparison; actual binary is `target/debug/omnigateway`.

Login cases assert statuses for malformed/empty JSON, primitive/non-object JSON, missing/non-string keys, unknown key, usable key, expired key, revoked key, and forwarded-proto forms. Cookie normalization validates a 43-character base64url token and compares remaining attributes. Logout checks anonymous/viewer/admin calls and loss of operator access, secure forwarded cookie, and a freshly minted client cookie. Client-session deletion itself is covered by existing auth tests, not a newly ported protected client GET.

## Isolation evidence

Summary: three logged-in keys A/B/C have distinct marked labels/prefixes, SQL log rows and real `/v1/chat/completions` traffic through the stub. Each caller (A/B/C, admin, viewer, anonymous, revoked-after-login) is compared with an explicit expected status across 12 queries: identity/credential overrides, apiKey grouping/splitting, admin and client cursors, duplicate names, percent encoding, case changes, bogus offset and invalid filters. Every B answer's headers and body are directly checked for absence of A/C markers. C expired after login is separately refused. Summary ignores all query parameters, as frozen TS does. The TS A-session cursor is checked equal to a deterministic scoped admin cursor; Rust uses that encoding until its logs route exists. Unusual B display cells (text, BLOB, invalid UTF-8, huge integer, nullable fields) match TS without process failure. Zero, 345 and unset offsets pass; unset also passes under `TZ=Asia/Kolkata`. Logs and usage have no route isolation evidence yet. Frozen quota intentionally discloses named accounts.

Implementation authorizes before opening the bounded read-only report lane; the opening task owns the permit. Lookup is a single verified-session key, never a list or URL identity. Shared summary construction is retained, with lossless display-cell replacement because the existing typed operator reader rejects BLOB labels/prefixes.

## Gates (all waited for and results read)

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

- Four GET routes retain unimplemented behavior. Summary reader-lane work delivered; log projection, usage direct writer, quota retention and bounded history remain.
- Existing oversized-body difference is precisely four admin-auth requests: POST `/api/login`, `/api/setup`, `/api/logout` declaring Content-Length 134217729 (128 MiB + 1), and POST `/api/login` sending that many bytes chunked. TS sends status 413 with no headers and an empty body; Rust sends status 413, `content-length: 0`, and an empty body (normalized `413\n\n\n` versus `413\ncontent-length: 0\n\n`). Client-specific oversized/chunked-over-limit cases, configured HTTPS base URL, poisoned limits, Unicode keys and timing measurements remain coverage gaps.
- Summary gaps: no expired-session-token case (key expiry is covered); no key-disable field exists; no summary limit-counter fixture or empty-log variant; unusual limits/allowlist cells remain typed and unverified. The fixture is currently local to summary, not yet extracted for the two pending routes. It has marked requested/resolved models, error codes, key labels/prefixes and degradation entries, but not every possible visible text column; request logs have no error-message column. These are unfinished acceptance coverage, not claims of complete brief compliance.
- Offset concern: summary uses the already-resolved `app.day_offset_minutes` from boot, whereas frozen TS calls `hostDayOffsetMinutes()` per summary when unset. Stable host offsets, including non-UTC, compare equal; a host timezone/DST offset change while running has not been tested and could differ. Preserve configured-versus-unset provenance before claiming exact dynamic fallback parity.
- Surface had no client GET expected-divergence rows to move. Added anonymous summary in both static configurations: **610 → 612 equal**, **61 expected unchanged**. Logs/usage surface cases remain to add after implementation.
- D4 Postgres must wire scoped own-key lookup/summary counters, scoped log paging and projected rows, scoped usage direct writer, credential/quota-window/sample readers and retained-span/sample-limit behavior to a bounded independent reader lane. Existing session auth must use the Postgres key usability lookup too. No Postgres implementation here.
- `bun.lock`, untracked 2026-10-24 specs, stash and other worktrees untouched. At final status, `progress.md` also appeared modified externally during this session; it was neither edited nor staged here.
