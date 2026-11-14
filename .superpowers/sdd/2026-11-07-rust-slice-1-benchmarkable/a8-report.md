# A8 — partial: login/logout delivered; five GET routes remain

**NEXT STEP:** implement summary first. Extend `conformance/e2e/admin-routes.ts` with three client identities (currently only the seed key is used for client login), a persistent client-cookie role, and a failing `/api/client/summary` comparison plus direct key-B-versus-key-A marker assertions. Read `packages/control/src/keys.ts` `toSummary`, reuse the lossless Rust key-summary writer without listing all keys, and expose the existing bounded report reader lane to client handlers after `require_client`. Then logs, usage, quota, quota/history in that order, isolation alongside each GET and one commit after each passing comparison. Read the remaining authorities named in a8-brief before implementing them. No GET implementation has been started.

## Status and commits

Partial increment, not A8 complete. No subagents, pushes, merges, dependencies or unsafe code. Product TypeScript untouched. Login uses existing `AdminAuth::login_client`, JSON-field reader and cookie helper. Logout reuses the existing logout handler. Frozen `loginClient` has no attempt accounting/rate limiter; neither does Rust's existing operation. Both hash and look up unknown/revoked keys; no timing equalization or empirical timing claim is made.

| Route | Status | Commit | Comparison evidence |
|---|---|---|---|
| POST login | Implemented | `b4d8ffe1` | `login-red.log`: 22 equal / 34 failures; `login-green.log`: 39 equal / 0 failures |
| POST logout | Implemented | `6861c046` | `logout-red.log`: 13 equal / 12 failures; `logout-green.log`: 19 equal / 0 failures; `logout-session.log`: 21 equal / 0 failures |
| GET summary | Not started | — | No comparison or isolation evidence |
| GET logs | Not started | — | No comparison or isolation evidence |
| GET usage | Not started | — | No comparison or isolation evidence |
| GET quota | Not started | — | No comparison or isolation evidence |
| GET quota/history | Not started | — | No comparison or isolation evidence |

`bbc20d35` adds minted-client logout coverage and sorts Rust module declarations; `73f57924` adds login/logout to surface comparisons. Counts above include database comparisons; failures include independent expected-status failures as well as byte differences. Before implementation Rust returned 404 NOT_FOUND on both POST routes. The first exploratory login fixture failed because it assumed an `enabled` column on api_keys; fixed to use expiry before recording RED. The first build exposed private shared helpers; their visibility is now crate-only. One copy command used the wrong binary filename and failed before any comparison; actual binary is `target/debug/omnigateway`.

Login cases assert statuses for malformed/empty JSON, primitive/non-object JSON, missing/non-string keys, unknown key, usable key, expired key, revoked key, and forwarded-proto forms. Cookie normalization validates a 43-character base64url token and compares remaining attributes. Logout checks anonymous/viewer/admin calls and loss of operator access, secure forwarded cookie, and a freshly minted client cookie. Client-session deletion itself is covered by existing auth tests, not a newly ported protected client GET.

## Isolation evidence

The minted client session is independently asserted to receive 401 from `/api/keys` on each binary. That proves only the existing client/operator role boundary. **There is no cross-key GET isolation evidence in this partial increment**: no three-key traffic fixture, foreign cursors, duplicate/encoded query attack matrix, or marker assertions yet. Those are blocking requirements for each remaining GET route, not deferred acceptance tests. Frozen quota intentionally discloses named accounts to every usable client; distinguish this from cross-key usage/log disclosure when writing assertions.

## Gates (all waited for and results read)

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

- Five GET routes retain unimplemented behavior. No reader-lane, projection, direct bucket writer, quota retention or bounded history work was delivered.
- No new divergence found in exercised POST cases. Existing oversized-body 413 framing differs (Bun no headers, hyper content-length); admin-auth pins four such cases. Client-specific oversized/chunked-over-limit cases, configured HTTPS base URL, unusual stored client-key cells, poisoned limits, Unicode keys and timing measurements were not added and remain coverage gaps.
- Surface had no `/api/client/*` expected-divergence rows in this checkout. Added two POST cases in each static configuration: **606 → 610 equal**, **61 → 61 expected**. No claim that seven routes moved to equal; the remaining GET surface cases still need adding.
- D4 Postgres must wire scoped own-key lookup/summary counters, scoped log paging and projected rows, scoped usage direct writer, credential/quota-window/sample readers and retained-span/sample-limit behavior to a bounded independent reader lane. Existing session auth must use the Postgres key usability lookup too. No Postgres implementation here.
- `bun.lock`, untracked 2026-10-24 specs, stash and other worktrees untouched. At final status, `progress.md` also appeared modified externally during this session; it was neither edited nor staged here.
