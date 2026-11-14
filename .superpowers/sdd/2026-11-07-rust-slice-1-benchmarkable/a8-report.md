# Fix round 2 — partial checkpoint: quota R1 fixed; audits/R2/R3 pending

**NEXT STEP:** finish R1's broader operator identity audit below, then R2, then R3. Product commit `30411500` fixes both quota joins, including last-entry-wins Map semantics. R2 is UNFIXED: read reviewer scripts `/tmp/opencode/a8-review/fix-nan.ts` and `fix-panic.ts` with grep/short slices, port the 5/22-row fixtures into the driver, record RED, replace both sample sorting comparators with total orders (numeric timestamps ascending, NaN after numbers stable), pin full frozen/Rust exchanges with the requested reason, and test thousands of adversarial rows. R3 is UNFIXED: stored JSON errors still leak through other paths; audit log vs wire boundaries before sanitizing. Full closure and `/tmp/opencode/a8/fix2/manifest.json` remain pending; do not claim completion.

| Finding | Commit | Failed first | Evidence under `/tmp/opencode/a8/fix2/` |
|---|---|---|---|
| R1 quota joins fixed; wider audit incomplete | `30411500` | 6078 equal / 6 expected / 6 failures, BLOB rows disclosed | `r1-red.log`; GREEN `r1-quota.log` 6081 equal / 6 expected, `r1-history.log` 9887 equal / 6 expected, zero failures |
| R2 | pending | review's 5-row order mismatch and 22-row panic | `/tmp/opencode/a8-review/fix-nan.log`, `fix-panic/` |
| R3 | pending | review summary canary disclosure | `/tmp/opencode/a8-review/fix-canary2/` |

R1 semantics: independent BLOB reads never join; text matches only text; INTEGER/REAL compare as JS numbers with SameValueZero (including ±0 and NaN); NULL matches NULL; reverse lookup reproduces Map's last entry on duplicate primitive keys. Bun SQLite probe `r1-map-semantics.log` observes numeric 1 vs text "1" distinct, ±0 equal, bound NaN stored as NULL, BLOB objects distinct. Rust `map_id_primitives_and_object_identity` passed (`r1-test.log`); synthetic NaN tested there, not claimed as a readable SQLite NaN cell. Fresh external binary `/tmp/opencode/a8/fix2/rust-r1`, build `r1-build.log`, all requested Cargo environment settings. No full workspace gate this increment.

R1 audit so far (not exhaustive, no universal parity claim):
- `client_quota.rs` history/live account joins: structural BLOB equality fixed above. Other client summary/logs/usage paths use session-derived SQL scope, not these in-memory account joins.
- `catalog.rs:choice`, `api.rs:852–861` static ids/public model grouping: string keys or generated catalog values; BLOB/numeric raw cells do not enter those comparators as keys. `public_rows` validates JSON catalog entries; deeper verification still needed.
- `models.rs:31,77,105–138` model id / credential pin / provider / auth membership: Rust `models::operator_credentials` uses strict String reads (`omni-store/src/models.rs:35–43`), and model ids use `row::opt_text` (`models.rs:140–150`). BLOB or numeric storage cells fail before matching; frozen strict equality would not match a string request/target to those cells. This is a possible whole-request-vs-no-match difference, NOT yet reproduced; fixing requires widening operator read carriers and validating downstream projections, not just changing one equality.
- `models.rs:94–99,124` grandfathered target pairs deliberately stringify JSON provider/model, rather than comparing raw row identities. `keys.rs:429` matches projected key id to request string; store/projection behavior for malformed ids remains to audit.
- `credentials.rs:189–205` health last-used lookup reads projected ids then queries SQL; `sql_value` turns BLOB into text. Potential malformed-id behavior requires comparison with frozen health/readOwnKey code; no fix or equality claim yet.
- Further client/operator matches and store/auth paths need examination; grep results are starting points, not a completed audit.

R3 initial grep (unfixed): `admin_password.rs:147` model_allowlist parse_error; `omni-store/src/keys.rs:291,379,490` allowlist diagnostics; `pg/rows.rs:72,251` related diagnostics; `omni-store/src/models.rs:214` targets parse message; `omni-control/src/models.rs:17,51` targets and credential provider_data parsers outside the previously sanitized helper. Settings/policies/limits and all wire-vs-log consumers still need tracing. Preserve operator error response bytes while removing parser input from logs.

Known differences still include accepted sort pair order, history nonnumeric timestamp ordering/panic (R2), stored JSON log leakage outside the shared credential parser (R3), and empty-413 framing. Shared metadata error log is **fixed reason plus the credential id**; the id is an accepted operator-visible identifier. Grouped-rule unit test shares production key extraction and collation with its all-pairs evaluation: it verifies grouping, not independent JS coercion; differential cases check coercion. Successful drivers completed normal scratch teardown. Excluded local work untouched.

---

# Fix round 1 — historical completion before re-review

I2 rule: fail with generic 500 iff some ordered pair of distinct projected rows would throw under the frozen left-to-right comparator. Validate equal-prefix groups in O(n log n), requiring only reached receivers to be strings and using JS argument coercion; otherwise use stable sorting with the same field ordering. History's fourth key is numeric subtraction: non-numeric observedAt produces NaN, treated as equal without throwing (frozen `clientHistory.ts:128`).

Properties/evidence: (a) empty and singleton comparisons pass; (b) differing providers protect malformed labels (`sort short circuit`); (c) reached receiver failures agree, including the observed eight-row arrangement; (d) successful singleton/short-circuit/populated/UTF-8/overflow fixtures compare byte-equal; (e) three-row and five-row argument-only arrangements are pinned divergences. `grouped_rule_equals_all_ordered_pairs` checks the grouped rejection predicate against brute-force ordered pairs for 9,000 deterministic random arrays of sizes 0–8, including coerced BLOB/null/numeric arguments and canonically equivalent Unicode strings. This proves the tested predicate cases, not a universal byte-equivalence theorem for malformed numeric comparator inputs.

Per route, the original 18 RED failures represented 9 distinct exchanges counted twice (comparison plus status): 6 exchanges now equal (singleton/short-circuit × three clients), 3 become documented divergences. Final seven sort arrangements × three clients give 15 equal and 6 documented-divergence exchanges per route, plus 35 equal unauthorized exchanges. Larger five-row TS success and eight-row TS failure were observed in `i2-observe-{quota,history}.log` before pinning. Across both routes there are 12 pinned divergences. Concrete example: `(id,provider,label)` rows `(0,b,BLOB 3132),(1,a,x),(2,b,x)` yield frozen 200 in order `[1,0,2]`, with BLOB label `{"0":49,"1":50}`; Rust gives generic 500 INTERNAL. Driver pins complete headers/status/body for both sides with reason `sort pair order (documented difference)`. Exact-cap probes remain reviewer evidence, not added this round.

| Finding | Commit | Failed first | Evidence under `/tmp/opencode/a8/fix1/` |
|---|---|---|---|
| I1 fixed | `19e6cc27` | log canary: 2886 equal / 1 failure | `i1-red.log`; GREEN `i1-quota.log` 2887 equal, `i1-history.log` 3621 equal, zero failures |
| I3 fixed | `21c8ed8c` | 5527 equal / 864 failures | `i3-red.log`; GREEN `i3-quota.log` 5959 equal, `i3-history.log` 9765 equal, zero failures |
| I2 accepted rule implemented | RED `e55be7ae`, fix `91451272` | singleton, short-circuit and three-row argument-only cases | RED `i2-red.log` / `i2-history-red.log`: 18 failures each; GREEN `i2-quota.log`: 6065 equal / 6 expected; `i2-history.log`: 9871 equal / 6 expected; zero failures |

I1 shared parser now carries only fixed reason and credential id, never the stored provider_data or parser error. Both syntactically invalid canary and valid array containing it are covered, with response and stdout/stderr secret scans. Grep found two direct shared-parser callers: client whole-list validation and operator `rows`. The latter serves list, health, patch lookups and create validation/result paths; they inherit the sanitization. Generic 500 wire response remains equal; Rust still logs its sanitized reason whereas frozen TS does not log that failure.

I3 uses existing `js::own_cell` in credential identity, quota-window and quota-sample readers. Both routes compare invalid/truncated/overlong UTF-8 and embedded NUL in label/provider/id/window_type. BLOB identity is preserved. No product TypeScript/dependency/unsafe changes.

Closure on `91451272`: workspace tests 1159 passed, 0 failed, 11 ignored, 161 groups (`final-tests.log`); workspace Clippy all targets -D warnings passed (`final-clippy.log`); fmt passed (`final-fmt.log`). All three requested Cargo environment variables used. Fresh build `final-build.log`, external binary `rust-final`; final `/tmp/opencode/a8/fix1/manifest.json` records commit and both SHA256 values. Admin-routes: 20301 equal / 22 expected / 0 failures (`final-admin-routes.log`); admin-auth: 212 equal / 4 expected / 0 failures, 116 tokens (`final-admin-auth.log`); surface: 620 equal / 61 expected / 0 failures (`final-surface.log`); run.ts: 64 passing rows, all equal (`final-run.log`). All runs waited for and read; drivers remove scratch on teardown.

Known differences: an operator could see the sort difference only with credential or quota sort cells that are not strings, which the gateway itself never writes: a throwing ordered pair exists but the frozen engine never visits it in that direction, so TS returns 200 and Rust 500. Rust still emits the sanitized metadata error log; accepted empty-413 framing difference remains. Documentation correction: logs projection is 20 fields; final pre-review targeted summary counts were 207 each and logs 429 (reviewer's rerun); older counts below are historical fixture versions. No new claim about other edge cases.

---

# Previous completion checkpoint (superseded by review findings above)

All seven routes implemented; full closure passed. History implementation/fixture: `670bc8f4`. Product TypeScript untouched; no dependencies, unsafe, subagents, pushes or merges. External concurrent documentation commits and excluded local files were left alone.

| Route | Commits | Targeted equal / failures | Failed first |
|---|---|---|---|
| login | `b4d8ffe1` | 39 / 0 | 34 failures, 404 |
| logout | `6861c046`, `bbc20d35` | 21 / 0 | 12 failures, 404 |
| summary | `2493a8a9` | 207 / 0 each | Rust 404 |
| logs | `b5973bb3`, `20cddcbc` | 429 / 0 | 368 failures; malformed-degradation RED 6 |
| usage | `1d84ed0f`, `43263a90`, `327f240f` | 487 / 0 | 422 failures, 404 |
| quota | `f95b99b9`, `9cbd3b8c` | 2887 / 0 | 578 failures; malformed metadata RED below |
| quota/history | `670bc8f4` | 3621 / 0 | 192 failures, 404 (`history-red.log`); duplicate-bound comparisons failed before last-value fix |

Summary isolation: verified-session id only; ignored identity attacks; B response bytes exclude A/C markers; shared caller matrix and post-login expiry.
Summary lane: `require_client` before bounded read-only report reader and all parsing/reads.
Logs isolation: explicit 20-field projection, removed excluded credential degradations, scoped foreign cursors/filters, B marker scans and complete paging.
Logs lane: `require_client` before bounded read-only report reader and all parsing/reads.
Usage isolation: scoped totals, B marker scans; allowed apiKey grouping stays scoped, credential grouping refused; all shared callers and expired key.
Usage lane: authorization first; bounded read-only reader, direct bucket writer.
Quota isolation: all shared callers × identity/encoded/duplicate/cursor attacks; orphan omitted, disabled included; every response scanned for three distinctive credential secrets.
Quota lane: authorization first; bounded read-only reader; identity metadata read excludes secret columns, whole-list metadata validation retained.
History isolation: same caller/attack matrix plus span edges/duplicates, malformed metadata/settings, orphan/disabled accounts, unusual numeric/BLOB cells, overflow and key expiry; every history response scans all three distinctive secrets.
History lane: authorization before query parsing or reader; bounded read-only lane, newest 50,001 rows → binary reorder → trim 50,000 → projection/locale sort.

Quota discloses exactly `{accounts:[{credentialId,label,provider,windowType,usedRatio,resetsAt,observedAt,windowMs,ratePerHourRatio,exhaustsAt,survives,stale,rolledOver}]}`.
History discloses exactly `{samples:[{credentialId,label,provider,windowType,observedAt,usedRatio,resetsAt,windowMs}],truncated}`. Both equal TS on the recorded fixtures: all clients see all named accounts, including disabled credentials; orphans disappear. Raw used/limit/rate counts and secrets are absent; exact ratios can reveal ceilings. History's flag is one top-level boolean. No gateway-wide traffic rate is disclosed.

Memory: at most 50,001 raw sample rows, 50,000 sort descriptors, metadata and output buffer; projected JSON held one row at a time. Full fixture process VmHWM: Rust 105136 kB, TS 141472 kB (not an isolated request allocation measurement), `final/admin-routes/client-history-{rust,ts}-rss.txt`.

Known differences: accepted empty-413 content-length framing difference remains. No new client response difference observed. Existing non-client expected divergences remain in closure driver logs. Coverage is fixture-based, not proof over every malformed SQLite cell. Limits: neither gateway has a login attempt limiter; day boundary fixed at boot in both.

All evidence below is under `/tmp/opencode/a8/`; results were waited for and read. Cargo used CARGO_INCREMENTAL=0, CARGO_PROFILE_DEV_DEBUG=0, CARGO_PROFILE_TEST_DEBUG=0.

| Gate | Result | Log |
|---|---|---|
| workspace tests | 1158 passed, 0 failed, 11 ignored; 161 groups | `history-workspace-tests.log` |
| workspace Clippy all targets -D warnings | pass | `history-workspace-clippy.log` |
| workspace fmt check | pass | `history-workspace-fmt.log` |
| fresh build / targeted history | 3621 equal, 0 failures | `history-build.log`, `history-green.log` |
| admin-routes | 10873 equal, 10 expected, 0 failures | `final/admin-routes.log` |
| admin-auth | 212 equal, 4 expected, 0 failures; 116 tokens | `final/admin-auth.log` |
| surface | 620 equal, 61 expected, 0 failures (quota checkpoint: 618 equal) | `final/surface.log` |
| run.ts | 64 pass rows, all equal | `final/run.log` |

Manifest: `/tmp/opencode/a8/final/manifest.json`, implementation commit `670bc8f4`, external binary `/tmp/opencode/a8/final/rust`, Rust SHA256 `b3d92914c6827cb50c29f26c4bc69b8743fc2b6ee91f621286128506786d26d1`; TS `/tmp/opencode/a8/ts`, SHA256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`. Drivers remove scratch on success; retained files are evidence. Initial fixture used future samples and an absolute backward clock; corrected to retained samples without changing the login clock. Initial compile used unsupported usize SQL binding; fixed before GREEN.

D4 must wire authenticated client report readers to Postgres: session-derived key scope for summary/logs/usage, explicit projections, lossless metadata validation/coercion, quota-window and bounded quota-sample reads, inclusive span/clamp/settings semantics, newest-first cap then binary reorder and page trim, ICU locale output ordering and single top-level truncated. Preserve authorization-before-read and bounded lane ownership.

---

# Previous checkpoint — partial: malformed quota gap closed; history RED recorded

**NEXT STEP (2026-11-14, malformed-quota checkpoint):** implement `/api/client/quota/history`. Item 1 is committed as `9cbd3b8c`; targeted GREEN is 2887 equal / 0 failures. A new `client-history` configuration and movable-clock enablement now record RED: 101 equal / 192 failures, Rust 404 (`/tmp/opencode/a8/history-red.log`). The fixture currently covers only empty history and shared callers/identity attacks: extend it with >50001 samples, orphan/disabled accounts, unusual cells, malformed credentials/settings, secret scans and expiration after login. Frozen `clientHistory.ts` (132 lines) and `history.ts` lines 1–150 have been read: **the actual wire result has a single top-level boolean `truncated`, NOT a per-series flag**, despite stale comments/request wording. `pageSamples` trims the store-reordered 50001 rows to 50000. Store `listQuotaSamples` first selects newest by observed_at DESC LIMIT 50001, then JS binary-id/window ordering and observed_at subtraction; read credentials.ts lines 530 onward for the rest. `retainedSpan` reads settings, clamps since to max(now-retentionDays*DAY, now-16*DAY), until to now; use frozen optionalNumber semantics (inspect schemas.ts). Reuse `credentials::validate_client_metadata` for whole-list parse failures, added in item 1. Authorize before reader/parsing; direct sample writer, bounded report lane; surface expectation still pending. Then run full closure and write final manifest. No subagents.

## This session's completed increment

| Item | Commit / result | Evidence |
|---|---|---|
| malformed quota credentials | `9cbd3b8c`; 2887 equal, 0 failures | `/tmp/opencode/a8/quota-malformed-green.log` |
| malformed quota RED | 2467 equal, 144 failures (36 real invalid-JSON differences plus expected-status failures from the initial incorrect malformed-settings assumption) | `/tmp/opencode/a8/quota-malformed-red.log` |
| history | RED only; 101 equal, 192 failures | `/tmp/opencode/a8/history-red.log` |
| targeted omni-control tests | 22 passed, 0 failed | `/tmp/opencode/a8/quota-malformed-tests.log` |
| control + gateway Clippy all targets -D warnings | pass | `/tmp/opencode/a8/quota-malformed-clippy.log` |
| workspace fmt check | pass | `/tmp/opencode/a8/quota-malformed-fmt.log` |

Item 1 outcomes (status AND response bytes compared): invalid provider_data JSON among valid credentials → 500 INTERNAL/internal error; valid JSON array/null/number → 200; number stored in TEXT label/provider → 200; BLOB or NULL label/provider → 500; malformed settings JSON → 200 fallback. NULL cases use a fixture-only nullable replacement table because production schema rejects NULL. Existing operator provider-data parser was extracted and reused; metadata validation opens only provider_data, never secret columns. No other implemented client route lists credentials. Quota continues to disclose exactly the fields listed below, identically to TS; all callers and all response bytes/headers in all malformed phases were checked for the three distinctive credential secrets, with zero leaks. Authorization/lane placement unchanged.

Fresh external binary `/tmp/opencode/a8/rust-quota-malformed`: SHA256 `1d874fdd6e8b40f7785092d3ceea50df1cf73bd0be29f306a5153cb7df6536a7`; TS `/tmp/opencode/a8/ts`: SHA256 `f9cc6678a7d2bc2300a71b3aae98caff1aaedbcb2d811baee3dffd4325009d63`. Built with all three required Cargo environment settings (`quota-malformed-build.log`). No final manifest or full closure claimed. Initial history fixture run failed because clock enablement was missing; corrected before recorded RED. Build artifact is `target/debug/omnigateway`, not `omni-gateway`.

Known differences/limits: the prior invalid-JSON quota gap is CLOSED on the compared cases. Accepted empty-413 content-length difference remains; no new quota difference observed. History remains unimplemented; no per-series flag exists in frozen history's actual response. No login attempt limiter in either gateway; day boundary fixed at boot in both. D4 obligations below still apply. `bench-matrix-report.md` changed externally during this session and was left untouched, along with bun.lock and all other excluded work.

---

# Previous checkpoint (historical; open quota item below is now closed)

**NEXT STEP (quota checkpoint, 2026-11-14):** implement GET `/api/client/quota/history` with a failing comparison first. Read frozen `clientHistory.ts` and `history.ts` (retainedSpan, sample query cap, pageSamples, per-series truncated), then `listQuotaSamples`. Authorize before parsing/opening the bounded reader; write samples directly without a value tree. Extend the shared fixture clock to the history configuration, include limit overflow affecting only some series, orphan/disabled accounts, unusual cells, all callers and the distinctive credential-secret scan. Then run the full closure drivers and write `/tmp/opencode/a8/final/manifest.json`; that final manifest and full closure are NOT done. Existing history below is preserved. No subagents.

## Latest checkpoint

| Route | Commits | Comparisons | Failed first |
|---|---|---|---|
| login | `b4d8ffe1` | 39 equal / 0 failures | 34 failures, 404 |
| logout | `6861c046` | 21 equal / 0 failures | 12 failures, 404 |
| summary | `2493a8a9` | 183 equal / 0 failures | Rust 404 |
| logs | `b5973bb3`, `20cddcbc` | 379 equal / 0 failures | 368 failures, then malformed-degradation RED 6 |
| usage | `1d84ed0f`, `43263a90`, `327f240f` | 487 equal / 0 failures | 422 failures, 404 |
| quota | `f95b99b9` | 775 equal / 0 failures | 294 equal / 578 failures, Rust 404 |
| quota/history | pending | none | not run |

Quota disclosure equals TS on the compared fixtures: `{accounts:[...]}` contains exactly credentialId, label, provider, windowType, usedRatio, resetsAt, observedAt, windowMs, ratePerHourRatio, exhaustsAt, survives, stale, rolledOver, in that order. Every valid client sees all named accounts, including disabled accounts; orphan windows disappear. Raw used/limit counts, raw rate, and secrets are absent. Exact fractions can reveal ceilings; this is intentional frozen behavior, not a secrecy claim. History disclosure is NOT implemented or verified.

Quota isolation: shared A/B/C, operator, viewer, anonymous, revoked and genuinely expired-session callers × twelve identity/cursor/duplicate/encoded parameter attacks × empty/populated/unusual/observed-cell phases. Expired-after-login C also gets 401. All response headers/body bytes scanned for `quota-distinct-access-token`, `quota-distinct-refresh-token`, `quota-distinct-api-key`; zero leaks. Explicit field-list/orphan/disabled assertions pass.
Quota lane: `require_client` precedes `app.control.reader()` and all DB reads; only the bounded read-only report lane runs the operation. New store reads select identity metadata and raw quota cells, never secret columns. Existing ICU root comparison matches tested labels é/E/e/Z/ä/A/a/Å/中; no new dependency.

Summary isolation: verified-session id only, ignored URL identities; B responses scanned for A/C markers; shared fixture/caller coverage described below.
Summary lane: authorizes before opening the bounded read-only report reader.

Logs isolation: explicit 19-field projection, scoped cursors and filters, B byte scans and complete paging described below.
Logs lane: authorizes before opening the bounded read-only report reader.

Usage isolation: scoped bucket totals and B byte scans, allowed apiKey grouping and refused credential grouping described below.
Usage lane: authorizes before opening the bounded reader; direct bucket writer.

History isolation/lane: pending; no evidence claimed.

### Latest verification (results read)

All logs under `/tmp/opencode/a8/`; Cargo used CARGO_INCREMENTAL=0, CARGO_PROFILE_DEV_DEBUG=0, CARGO_PROFILE_TEST_DEBUG=0.

| Gate | Result | Log |
|---|---|---|
| quota RED | 294 equal / 578 failures | `quota-red.log` |
| quota GREEN, fresh external binary | 775 equal / 0 failures | `quota-green.log` |
| workspace tests | 1158 passed / 0 failed / 11 ignored, 161 result groups | `quota-tests.log` |
| workspace Clippy all targets -D warnings | pass | `quota-clippy.log` |
| workspace fmt check | pass | `quota-fmt.log` |
| fresh gateway build | pass | `quota-build.log` |
| surface | 618 equal / 61 expected divergences / 0 failures | `quota-surface.log` |

`quota-manifest.json` records commit `f95b99b9` and SHA256 of `/tmp/opencode/a8/rust-quota` and unchanged `/tmp/opencode/a8/ts`. Final manifest is deliberately not claimed. Full admin-routes/admin-auth/run.ts have not been rerun for this increment; previous evidence below applies to the previous binary. First workspace test build was terminated at the tool's 120-second deadline; rerun with 600 seconds completed successfully. Initial fixture attempts assumed an array rather than `{accounts}` and tried NULL in NOT NULL `used`; corrected before RED. Initial compile needed an explicit text-cell helper; Clippy required NaN-aware positive comparisons. All corrected before final GREEN.

Known differences/limits: accepted empty-413 content-length difference remains. No new response difference observed in quota comparisons. Code-inspection difference still to close before review: invalid JSON in a credential's provider_data makes frozen credentials.list throw, while the new identity-only read never parses it. This case has not been compared. Malformed credential labels/providers and malformed settings also need dedicated comparisons. No universal parity claim for malformed credential records. No login attempt limiter in either gateway; day boundary fixed at boot in both. D4 must wire the authenticated client read lane and lossless quota/credential metadata reads to Postgres, preserve JS cell coercion, ICU ordering and output order, and add bounded quota sample reads plus retained-span/paging semantics for history.

---

## Prior checkpoint history

**NEXT STEP:** implement GET `/api/client/quota` with a failing comparison first. `headroom.ts` was read completely: it DOES disclose `credentialId`, label, provider and window fractions (plus timing/estimate flags); it omits raw used/limit counts. Read `burn.ts`, credentials.list and settings semantics before porting; listQuota is an unfiltered `SELECT * FROM quota_windows`. Skip orphan windows, include disabled credentials, preserve JS coercion of unusual cells and locale sorting. Use the bounded report reader AFTER require_client. Extend shared fixture clock enablement (admin-routes.ts `clientClock`) to the new quota configuration. Commit quota when equal, then history with retainedSpan/sample cap/truncated. Neither quota route has a RED comparison yet. This session closes at the usage checkpoint due to context budget; A8 is not complete for review.

## Status and commits

Partial increment, not A8 complete. No subagents, pushes, merges, dependencies or unsafe code. Product TypeScript untouched. Login uses existing `AdminAuth::login_client`, JSON-field reader and cookie helper. Logout reuses the existing logout handler. Frozen `loginClient` has no attempt accounting/rate limiter; neither does Rust's existing operation. Both hash and look up unknown/revoked keys; no timing equalization or empirical timing claim is made.

| Route | Status | Commit | Comparison evidence |
|---|---|---|---|
| POST login | Implemented | `b4d8ffe1` | `login-red.log`: 22 equal / 34 failures; `login-green.log`: 39 equal / 0 failures |
| POST logout | Implemented | `6861c046` | `logout-red.log`: 13 equal / 12 failures; `logout-green.log`: 19 equal / 0 failures; `logout-session.log`: 21 equal / 0 failures |
| GET summary | Implemented; coverage gaps below | `2493a8a9` | `summary-red.log`: Rust 404; `summary-green.log`: 183 equal, 0 failures; final full driver below |
| GET logs | Implemented | `b5973bb3`, `20cddcbc` | `logs-red.log`: 186 equal / 368 failures (Rust 404); `logs-green-final.log`: 371 equal / 0 failures; malformed degradations RED 376 equal / 6 failures, GREEN 379 equal / 0 failures |
| GET usage | Implemented | `1d84ed0f`, `43263a90`, `327f240f` | `usage-red.log`: 216 equal / 422 failures (Rust 404); `usage-green.log`: 427 equal / 0 failures; expired-session and daily fixtures: 487 equal / 0 failures each |
| GET quota | Not started | — | No comparison or isolation evidence |
| GET quota/history | Not started | — | No comparison or isolation evidence |

`bbc20d35` adds minted-client logout coverage and sorts Rust module declarations; `73f57924` adds login/logout to surface comparisons. Counts above include database comparisons; failures include independent expected-status failures as well as byte differences. Before implementation Rust returned 404 NOT_FOUND on both POST routes. The first exploratory login fixture failed because it assumed an `enabled` column on api_keys; fixed to use expiry before recording RED. The first build exposed private shared helpers; their visibility is now crate-only. One copy command used the wrong binary filename and failed before any comparison; actual binary is `target/debug/omnigateway`.

Login cases assert statuses for malformed/empty JSON, primitive/non-object JSON, missing/non-string keys, unknown key, usable key, expired key, revoked key, and forwarded-proto forms. Cookie normalization validates a 43-character base64url token and compares remaining attributes. Logout checks anonymous/viewer/admin calls and loss of operator access, secure forwarded cookie, and a freshly minted client cookie. Client-session deletion itself is covered by existing auth tests, not a newly ported protected client GET.

Shared fixture extraction: `fd7ed178`, `fixture-extract.log`: 183 equal / 0 failures, unchanged summary behavior. Fixture includes real A/B/C traffic, revoked caller, sessions, and both admin/client cursors; expiry after login is applied by each consuming configuration.

## Isolation evidence

Usage: all five forwarded parameters, duplicate/percent-encoded/case-varied names, ignored URL identity/credential filters and foreign cursors compare equal. apiKey grouping/splitting is allowed but narrowed to the verified session; credential grouping/splitting returns the frozen 400. Every B response (headers and body) is scanned for A/C markers AND key ids and credential-secret markers. Raw totals are directly asserted as B's three SQL rows (two after since=101), daily totals as B's 66 requests against distinct A/C daily counts. The shared fixture also seeds real A/B/C traffic; comparisons use deterministic time bounds. All callers including an actually expired session are checked. libfaketime mints an additional B token at -43201 seconds, then restores the clock before requests; this now applies to summary/logs/usage. C expiry after login is checked before invalid usage grain validation. Implementation reuses the direct bucket writer without a value tree and opens the bounded read-only lane only after require_client.

Quota disclosure reconnaissance only: frozen accountQuota explicitly includes credentialId, label, provider, window type, exact fractions, timestamps and burn/staleness/rollover flags; raw used/limit/rate counts and secrets are omitted. Removed credentials' windows are skipped; there is no enabled-account filter in this operation. No Rust quota disclosure/equality or isolation claim yet. History still requires reading its authorities.

Logs: all ten forwarded filters, invalid cursor/time/state, duplicate/encoded/case-varied names, ignored identity/grouping overrides, A's client cursor and A-scoped admin cursor compare equal. Every B response is directly scanned (headers and body) for A/C markers and `secret-credential-`; excluded degradation entries are seeded for every key and removed in the explicit 19-field projection. B pages to completion using its own cursor (three distinct SQL rows), with real traffic additionally present. Admin/viewer/anonymous/revoked callers and expired-after-login C are refused before malformed query processing. Own text/BLOB/invalid UTF-8/huge integer/NULL cells pass. Initial green had six fixture expectation failures: `state=completed` is invalid (TS accepts pending/done); byte equality already passed. Corrected expected status and reran. No product TS edits.

Summary: three logged-in keys A/B/C have distinct marked labels/prefixes, SQL log rows and real `/v1/chat/completions` traffic through the stub. Each caller (A/B/C, admin, viewer, anonymous, revoked-after-login) is compared with an explicit expected status across 12 queries: identity/credential overrides, apiKey grouping/splitting, admin and client cursors, duplicate names, percent encoding, case changes, bogus offset and invalid filters. Every B answer's headers and body are directly checked for absence of A/C markers. C expired after login is separately refused. Summary ignores all query parameters, as frozen TS does. Both binaries now mint real client cursors and check them against scoped admin cursors. Unusual B display cells (text, BLOB, invalid UTF-8, huge integer, nullable fields) match TS without process failure. Zero, 345 and unset offsets pass; unset also passed under `TZ=Asia/Kolkata` in the previous increment. Usage has no route isolation evidence yet. Frozen quota intentionally discloses named accounts.

Implementation authorizes before opening the bounded read-only report lane; the opening task owns the permit. Lookup is a single verified-session key, never a list or URL identity. Shared summary construction is retained, with lossless display-cell replacement because the existing typed operator reader rejects BLOB labels/prefixes.

## Gates (all waited for and results read)

### Usage increment (2026-11-14, merged Anthropic/OAuth tree)

`manifest.json.usage_increment` records external `/tmp/opencode/a8/rust-usage`, implementation `1d84ed0f`, final driver `327f240f`, SHA256 for Rust and unchanged `/tmp/opencode/a8/ts`. Fresh Rust build is `usage-build.log`; subsequent commits are driver-only. Commands are the commands below with `--rust /tmp/opencode/a8/rust-usage`, `usage-*` evidence directories; targeted runs add `--only client-usage`. All Cargo commands used CARGO_INCREMENTAL=0, CARGO_PROFILE_DEV_DEBUG=0, CARGO_PROFILE_TEST_DEBUG=0. Every run was waited for and results read. Full admin reran after the daily fixture addition. Drivers clean their own scratch directories; run.ts scratch removed after recording.

| Gate | Result | Log under /tmp/opencode/a8/ |
|---|---|---|
| usage initial RED | 216 equal, 422 failures (404 plus expected-status assertions) | `usage-red.log` |
| usage GREEN | 427 equal, 0 failures | `usage-green.log` |
| expired-session coverage | 487 equal, 0 failures | `usage-expiry.log` |
| daily scoped totals | 487 equal, 0 failures | `usage-daily.log` |
| cargo test --offline --workspace | 1158 passed, 0 failed, 11 ignored; 161 summaries | `usage-workspace.log` |
| cargo clippy --offline --workspace --all-targets -- -D warnings | Passed | `usage-clippy.log` |
| cargo fmt --all -- --check | Passed | `usage-fmt.log` |
| admin-routes final | 4365 equal, 10 expected divergences, 0 failures, 38 raw keys minted | `usage-admin-final.log` |
| admin-auth | 212 equal, 4 expected divergences, 0 failures, 116 distinct tokens | `usage-auth.log` |
| surface | 616 equal, 61 expected divergences, 0 failures | `usage-surface.log` |
| run.ts | All 47 rows equal | `usage-run.log` |

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

- Two GET routes retain unimplemented behavior: quota, quota/history. Usage and logs use the bounded report reader after authorization and take scope from the verified session. No observed usage differences from TS in tested cases. Usage unusual-cell, empty-table and real-traffic-output comparisons remain coverage gaps; real traffic is seeded but excluded by the deterministic comparison window.
- Existing oversized-body difference is precisely four admin-auth requests: POST `/api/login`, `/api/setup`, `/api/logout` declaring Content-Length 134217729 (128 MiB + 1), and POST `/api/login` sending that many bytes chunked. TS sends status 413 with no headers and an empty body; Rust sends status 413, `content-length: 0`, and an empty body (normalized `413\n\n\n` versus `413\ncontent-length: 0\n\n`). Client-specific oversized/chunked-over-limit cases, configured HTTPS base URL, poisoned limits, Unicode keys and timing measurements remain coverage gaps.
- Coverage gaps: no key-disable field exists; no summary limit-counter fixture or empty-log variant; unusual limits/allowlist cells remain typed and unverified. Shared fixture now supports summary/logs/usage, including expired-session-token callers via libfaketime. It has marked requested/resolved models, error codes, key labels/prefixes and degradation entries, but not every possible visible text column; request logs have no error-message column. Logs filter comparisons use the deterministic SQL time window; real traffic is seeded but its client log output is not compared. These are unfinished acceptance coverage, not claims of complete brief compliance.
- Offset investigation (item 1, no code change): both TS route factories call `deps.dayOffsetMinutes ?? hostDayOffsetMinutes()` per request (client.ts:110, admin.ts:604). However frozen `packages/control/src/config.ts:140` resolves absent/invalid configuration at boot and `apps/gateway/src/index.ts:345` ALWAYS passes that number; app.ts:445–469 forwards it to both factories. Thus the actual frozen binary and Rust both retain the boot value through DST. Changing only Rust for an unset environment variable would introduce a difference. No injectable optional-offset Rust route-factory API exists; no DST simulation was run. The requested change is blocked on reconciling route-factory semantics with frozen executable semantics; operator routes remain unchanged for the same reason.
- Surface had no client GET expected-divergence rows to move. Added anonymous usage in both static configurations, taking equal count from 614 to 616; expected divergences remain 61. Quota/history still need surface cases.
- D4 Postgres must wire scoped own-key lookup/summary counters, scoped log paging and projected rows, scoped usage direct writer, credential/quota-window/sample readers and retained-span/sample-limit behavior to a bounded independent reader lane. Existing session auth must use the Postgres key usability lookup too. No Postgres implementation here.
- `bun.lock`, untracked 2026-10-24 specs, stash and other worktrees untouched. At final status, `progress.md` also appeared modified externally during this session; it was neither edited nor staged here.
