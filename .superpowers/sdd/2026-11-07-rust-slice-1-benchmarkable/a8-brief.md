# A8: the key holder's routes, `/api/client/*`

Base: HEAD of feat/rust-migration-design in /home/homebrew/code/omnigateway (c6736cb6, after A7). Roadmap row A8.

Project: migration of an LLM API gateway from TypeScript (Bun) to Rust. The frozen TypeScript gateway is the behaviour reference and is never edited. The Rust gateway must answer the same requests with the same status, headers that matter, and body bytes.

Parallel agents work in their own git worktrees — never touch their checkouts:
- rust-providers (Anthropic/OAuth): owns crates/omni-providers, crates/omni-ir, crates/omni-dialects, crates/omni-gateway/src/{dispatch.rs,refresh.rs}, crates/omni-gateway-core, token code in crates/omni-store/src/credentials.rs.
- rust-cli (CLI): owns crates/omni-cli and crates/omni-control/src/database.rs.
Stay out of those files. Your work belongs in crates/omni-control (new module, e.g. client.rs, plus small additive changes to logs.rs / reports.rs), crates/omni-store (additive read queries), crates/omni-gateway/src (a new client_routes.rs wired next to admin_routes.rs) and the conformance driver.

## Scope — seven routes
- POST /api/client/login
- POST /api/client/logout
- GET  /api/client/summary
- GET  /api/client/usage
- GET  /api/client/logs
- GET  /api/client/quota
- GET  /api/client/quota/history

Out of scope: any body route (there is none for clients, by design); the quota poller and every operator quota route (roadmap row B10) — you only READ what is in `quota_windows` / `quota_samples`; Postgres (row D4 — say what it must wire); the dashboard.

## Authority (frozen TS, never edit)
- apps/gateway/src/routes/client.ts (206 lines; read it completely first) and apps/gateway/src/routes/http.ts (`requireClient`, `readJsonRecord`, `sessionCookie`, `readCookie`, `apiErrorHandler`).
- packages/control/src: `readOwnKey` (keys.ts), `scopeOf` (principal.ts), `toClientLog` (clientLog.ts, 101 lines), `queryUsage` (usage.ts), `pageLogs` (logs.ts), `accountQuota` (quota/headroom.ts), `accountQuotaHistory` (quota/clientHistory.ts and the `retainedSpan`/paging helpers it uses in quota/history.ts).
- The store queries those call, in packages/store/src/sqlite/ (`listQuota`, `listQuotaSamples`, `credentials.list`, the scoped usage and log queries).
- apps/dashboard/src/api/client.ts for response shapes.

## What already exists in Rust (reuse, do not rewrite)
- crates/omni-gateway/src/admin_auth.rs: `login_client`, client sessions, session invalidation when the key stops being usable. crates/omni-gateway/src/api.rs: `require_client`, cookie helpers, error mapping, the existing `/api/login` / `/api/logout` handlers as the pattern for the two POST routes.
- crates/omni-control/src/reports.rs (`usage`) and logs.rs (`page`) with their validation; crates/omni-store/src/{reports.rs,logs.rs}; the bounded read-only "report lane" in crates/omni-gateway/src/admin_routes.rs (four permits, permit owned by the opening task) — client reads go through the same lane, after authorisation, never through the control connection.
- crates/omni-control/src/credentials.rs has quota readers (`status_quota` and the health reader) and the lossless JS JSON carrier (`omni_ir::jsjson`) used for byte-exact output.

## Requirements
1. Scope is the security property. Every read is narrowed by the API key id taken from the verified session — never from the URL. Prove with tests that no query-string value (`apiKeyId`, `credentialId`, `groupBy=apiKey`, a cursor minted by an operator session or by another key's session, duplicate parameters, encoded variants) lets one key see another key's rows, counts, labels or even the existence of other keys. Where TS refuses such a parameter, refuse identically; where TS ignores it, ignore it identically — read which from the frozen code, do not guess.
2. `/api/client/logs` returns the PROJECTED row (`toClientLog`): enumerate the columns exactly as TS does and reproduce what it does with `degradations` (the `excluded:<credentialId>:<reason>` strings must not leak a credential id). A column added to the operator row later must not appear here by accident: build the client row from an explicit list, not by removing fields.
3. `/api/client/summary`: `readOwnKey` fields plus `dayOffsetMinutes` (configured value, or the host offset as TS computes it; zero is a real value).
4. `/api/client/usage`: the same operation as the operator's, with the client scope and only the five forwarded parameters.
5. `/api/client/quota` and `/quota/history`: byte-equal to TS for whatever is in the tables, including what TS does with an account whose credential row is gone, disabled accounts, unusual cells, the span clamp to retained data, the sample page limit and the per-series `truncated` flag.
6. Authorisation before any parsing or database work on all five GET routes: admin and viewer sessions, no session, an expired session, and a client session whose key was revoked, disabled or expired after login each get exactly what TS gives (status, body, cookie handling).
7. Login: body parsing as `readJsonRecord` (non-object, missing `key`, non-string `key`, oversized or malformed JSON), no distinction between unknown and revoked keys in status, body or — as far as you can make it — timing; cookie attributes identical to TS including `Secure` from the configured base URL and forwarded-proto handling; logout clears the cookie with or without a session. Whatever rate limiting or attempt accounting the frozen `loginClient` applies must be the same; check what the existing Rust `login_client` already does.
8. Unusual stored cells (text where a number is expected, BLOB, NULL, invalid UTF-8, huge integers) behave as TS does and never fail the process; follow the per-row isolation patterns of A5–A7.
9. Memory: `/api/client/usage` uses the direct bucket writer the operator route uses; the quota history is bounded by the sample limit. No client route may build an unbounded value tree.

## Verification
- Failing comparison first, then the implementation, committed per route.
- Extend conformance/e2e/admin-routes.ts with client configurations (or add conformance/e2e/client-routes.ts built on the same helpers): both gateways seeded identically — at least three keys with distinct traffic (direct SQL plus some real /v1 traffic through the stub upstream), quota windows and samples for several accounts — then every route × {client of key A, client of key B, admin, viewer, anonymous, revoked-after-login}, every forwarded filter, paging to the end, invalid inputs, empty tables, unusual cells. Every case asserts the expected status as well as equality. Binaries copied OUTSIDE the checkout; a manifest with the commit and sha256 of both.
- An explicit isolation test per GET route: key B's session, crafted to reach key A's data by every parameter you can think of, returns nothing of A — compared with TS and also asserted directly (a marker string present only in A's rows never appears in any byte of B's responses).
- `cargo test --offline --workspace`, `cargo clippy --offline --workspace --all-targets -- -D warnings`, `cargo fmt --all -- --check`; the existing drivers (admin-routes, admin-auth, surface, run.ts) still pass. surface.ts has expected divergences for unimplemented routes — the seven client routes must move from "expected" to "equal" there; adjust its expectation list accordingly and say how the counts changed.
- CARGO_INCREMENTAL=0, CARGO_PROFILE_DEV_DEBUG=0, CARGO_PROFILE_TEST_DEBUG=0. Evidence under /tmp/opencode/a8/. Disk is tight (about 13 GB free): remove driver scratch directories once their results are recorded; do not copy large fixtures.

## Rules
No subagents, no `unsafe`, no new dependency without saying why, no edits to product TypeScript, bun.lock, progress.md, migration-roadmap.md, the untracked docs/superpowers/specs/2026-10-24-* files, or the stash; no push or merge. Stage only your own files (reports under .superpowers need `git add -f`). Keep reads small (grep first; sections of at most 200 lines; conformance/e2e/admin-routes.ts is very long — never read it whole).

Write a8-report.md in this directory: status; route → commits → tests with counts; which comparisons failed before the implementation; the isolation evidence; every known difference from TS however small; what D4 must wire for Postgres; gate counts with log paths and the manifest. If you run short of context, commit what passes and write the precise next step at the top of the report — finished login/logout/summary/logs with a report is better than seven half-done routes.
