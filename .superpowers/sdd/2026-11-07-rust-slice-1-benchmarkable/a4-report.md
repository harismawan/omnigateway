# A4 report: admin auth core and /api router skeleton

Base 8ad1ac54, code commit 369aaf0d. Brief: `a4-brief.md`. Evidence: `/tmp/opencode/a4/`.
Implementer opus-pr. Controller review (gpt-6-astra#high) pending.

## What changed

**Hashing, shared** (`crates/omni-crypto/src/password.rs`, `session.rs`;
`crates/omni-control/src/admin_password.rs`)
- `password::hash`: argon2id m=19456 t=2 p=1, 32-byte salt, 32-byte output, PHC string, exactly
  `Bun.password.hash(_, ARGON2)`'s format. `password::verify`: any argon2 PHC string
  (id/i/d, its own params, 16-byte `@node-rs/argon2` salts included); unparseable/absent → false,
  as TS's `passwordMatches` treats a throwing verify. Output comparison is constant-time
  (`password_hash::Output`'s `PartialEq`). New dep: `argon2 0.5` (+ `password-hash`, `blake2`,
  `base64ct`).
- `session::token` (unpadded base64url of 32 CSPRNG bytes) and `session::key`
  (`sess:<kind>:<sha256hex(utf8 token)>`), the spec's schema, so D2's Redis store uses the same keys.
- `omni_control::admin_password`: sync, runtime-free storage half of `createAdminAuth` — the
  12-UTF-16-unit length rule with TS wording, `adminPasswordHash`/`viewerPasswordHash` rows
  (`ON CONFLICT DO NOTHING` for setup, delete for viewer-off), `set_admin_password` (what E1's
  `omni admin set-password` will call), `client_key_usable` (`keys.get` + `keyUsable`, throwing
  like `toKey` on an unparseable allowlist). New dep for omni-control: `rusqlite` (same version the
  workspace already uses). **omni-store untouched.**

**Session authority** (`crates/omni-gateway/src/admin_auth.rs`)
- `AdminAuth` ports every `createAdminAuth` method: `is_configured`, `set_initial_password`,
  `set_password` (ends every session), `change_password` (length rule *before* verify, as TS),
  `login`, `is_viewer_configured`, `set_viewer_password` (ends viewer sessions only), `login_viewer`,
  `login_client`, `verify` (kind lookup order admin→viewer→client; expiry `expiresAt <= now`
  deletes; client sessions re-check key usability every verify and are deleted when it fails),
  `logout`, `invalidate_sessions`, `invalidate_kind`. Only A5/A8/A10 call the unused ones.
- `SessionKv` trait = TS `coord.kv` (`set` with TTL, `get` expiring on read, `del`, `del_prefix`),
  boxed futures so a networked D2 impl fits. `MemoryKv` = `memoryCoord().kv` against an injected
  clock; stored value is TS's JSON `{"expiresAt":<ms>,"principal":{...}}` byte for byte.
  Addition: `MemoryKv` sweeps expired entries when the map has doubled since the last sweep (TS
  only forgets on read, so abandoned sessions accumulate); unobservable otherwise.
- Argon2 runs on `spawn_blocking`, bounded by a semaphore of `available_parallelism()` (19 MiB
  each), like Bun's threadpool. Store access uses a dedicated SQLite connection (opened at boot),
  also on the blocking pool — never the request path's connection.
- Principal `machine` (plugin capability, unreachable in TS) is not modelled; a stored record naming
  it reads as no session.

**/api router** (`crates/omni-gateway/src/api.rs`, `server.rs`)
- **Bare hyper, not axum** (spec leaves it to the builder): `server::handle` already matches on
  Elysia's normalized path (A2), and the unmatched answers (plugin 501, `/api` 404 guard JSON for
  GET/HEAD, `NOT_FOUND` text for other methods, trailing-slash folding) are TS-specific bytes. axum's
  404/405, extractor rejections and trailing-slash handling would each need overriding to stay
  byte-identical. `api::route(method, path)` is the table A5–A10 extend; a matched route is checked
  after the plugin 501 and before the static/404 fallthrough, so unported `/api` paths answer as
  before (asserted by surface.ts, unchanged 606/61/0, and the new server test).
- Shared helpers, as `routes/http.ts`: `read_cookie` (`;` split, JS trim, first `omni_admin=` wins,
  value after the first `=`, multiple `cookie` headers joined `"; "` as Bun's `Headers` does),
  `session_cookie` (`omni_admin=<t>; Path=/; HttpOnly; SameSite=Strict[; Secure]; Max-Age=<n>`;
  `Secure` iff `OMNI_BASE_URL` parses as https — case-insensitive, malformed → no — or the first
  `x-forwarded-proto` hop JS-trimmed equals `https` case-insensitively; the request URL is always
  `http:` here), `principal_of`, `require_admin`/`require_reader`/`require_client` (TS messages),
  `read_json_fields` (= `readJsonRecord` reduced to top-level string fields), `error_response`
  (= `apiErrorResponse`; non-`GatewayError` → `500 INTERNAL "internal error"`).
- JSON validity is JSC's (`omni_ir::jsc_json::parse_error`, iterative): any depth (tested 50k in the
  driver, 100k in units), `1e400`, lone surrogate escapes, BOM, trailing whitespace accepted exactly
  as `request.json()`; anything else → `400 BAD_REQUEST "invalid JSON body"`. Fields are then read by
  a small iterative scanner (duplicate keys: last wins; escapes and surrogate pairs decoded; a lone
  surrogate becomes U+FFFD — what TS hashes too, since Argon2 sees the UTF-8 encoding).
  Content-Type is ignored, as `request.json()` ignores it (driver: text/plain, form, multipart).
- Routes: `GET|HEAD /api/status`, `POST /api/setup`, `POST /api/login`, `POST /api/logout`, each
  with TS's statuses, bodies, header order (`set-cookie` before `content-type`), logs
  (`admin setup completed`, `admin login failed reason="invalid credentials"`,
  `admin login succeeded`).
- **Body limit:** Bun's default `maxRequestBodySize` (128 MiB): a declared `content-length` over it
  is 413 before routing for every non-GET/HEAD method off `/v1/*` (probed against TS: every method,
  every path); a chunked body that grows past it while an `/api` route reads it is 413 too. Bun's 413
  has no `date` — a `NoDate` response extension skips `stamp_date`. `/v1/*` keeps its own existing
  32 MiB limit and dialect error unchanged (test asserts no early 413 there). Body idle timeout as
  `/v1` (hang-up).
- No CSRF/Origin check, no login rate limit or lockout: TS has none (searched `routes/*`,
  `adminAuth.ts`); `SameSite=Strict` is the only cross-site defence, kept.
- Restart behaviour: sessions are in process memory in both builds; a restart ends every one
  (driver `restart` config, equal).

## Verification

**Black-box driver** `conformance/e2e/admin-auth.ts` (new): TS binary vs Rust binary, each on its
own copy of one CLI-seeded root, raw HTTP/1.1, status + sorted headers + body bytes, with session
cookies captured per binary and replayed in later steps. 14 configurations: fresh install (status
anon/HEAD/query/slash/dotdot/encoded, every wrong method, 16 malformed setup bodies, setup ok with
https, setup again ×3), 29 successful logins (mode variants, duplicate keys, escaped keys, BOM,
whitespace, `1e400`/lone surrogate, 50k-deep body, 4 content types, path spellings, 14
`x-forwarded-proto` shapes incl. NBSP/é/two headers), 12 failed logins, 12 cookie-reading shapes,
logout with/without/garbage/https/body/path variants and concurrent-session survival, oversized
bodies (content-length and chunked over 128 MiB, a body exactly at the limit, GET with a huge
content-length), cross-compat both directions (`cross-ts-written`: both binaries on the DB TS's
setup wrote; `cross-rust-written`: on the DB Rust's wrote), Bun-written admin+viewer hashes (viewer
login, wrong-mode, `VIEWER`, viewer logout sparing admin), `@node-rs/argon2` legacy hash, broken
hashes, restart, 5 `OMNI_BASE_URL` shapes, and **expiry with libfaketime** (wall clock moved
+43190 s / +43199 s / +43201 s / back to +0 / +86400 s; Bun and Rust both read `CLOCK_REALTIME`,
monotonic untouched): valid up to the TTL, gone at it, stays gone when the clock returns, a later
session expires on its own TTL. Also asserted: the `admin …` log lines in order per config; the
stored hash matches `^\$argon2id\$v=19\$m=19456,t=2,p=1\$[43]\$[43]$` on both.

Masks: `date` (IMF, ±120 s; any IMF date under faketime); session token in `set-cookie` after
validating `[A-Za-z0-9_-]{43}` decoding to 32 bytes and never minted before in the run (108
distinct tokens across both binaries).

Asserted divergence (4 rows): a 413 — Bun writes a bare head, hyper adds `content-length: 0`.

| run | binary | result |
|---|---|---|
| RED | `rust-before` (bb6d3401 release) | 14 equal, 180 failures (`/tmp/opencode/a4/red.log`) |
| GREEN | 369aaf0d release | **190 equal, 4 asserted divergences, 0 failures** (`green.log`) |

One intermediate GREEN found the chunked-413 `date` header difference (fixed: `NoDate`).

**Unit/integration:** omni-crypto password (TS-written Bun/argon2i/legacy hashes verify; bcrypt,
oversized-m, garbage → false; new-hash format; empty refused), session (TS key schema vectors);
omni-control admin_password (UTF-16 length rule + wording, row round trips, set_admin_password);
gateway admin_auth (expiry at exactly TTL with deletion, stored JSON byte-exact, concurrent
sessions, viewer independence/clearing, change-password ordering and ending every kind, client
revocation on verify, invalidate by kind/all, MemoryKv sweep, principal JSON), api (readCookie,
Secure rule, baseUrl parse, field scanner incl. 100k-deep); `tests/server.rs`: end-to-end
setup/login/status/logout + unported `/api` fallthrough + plugin 501, and 413-off-`/v1`-only.

**Gates (final binary 369aaf0d):** `cargo test --workspace` 768 passed / 0 failed; `cargo clippy
--workspace --all-targets -D warnings` clean; `cargo fmt --check` clean; Biome clean on the driver;
`conformance/e2e/surface.ts` 606 equal / 61 expected / 0 failures (unchanged from A1/A2);
`conformance/e2e/run.ts` all rows equal. `/v1` hot path untouched except one
`starts_with("/v1/")` check before routing (no benchmark per brief).

## Concerns / known differences
- A bcrypt hash in `settings` verifies in Bun, not here (nothing ever writes one; only a hand edit).
  An argon2 hash naming >1 GiB memory is refused rather than attempted (Rust aborts on OOM).
- 413 framing: `content-length: 0` extra (asserted).
- `MemoryKv` sweep is an addition (bounded memory); key/JSON schema unchanged.
- Each `/api` call reads password rows through one `Mutex<SqliteStore>`; fine for admin traffic,
  revisit if A7's heavy reads share it (they should get their own connection/pool).
- `libfaketime` was installed via Homebrew for the expiry configuration
  (`/home/linuxbrew/.linuxbrew/lib/faketime/libfaketimeMT.so.1`); the driver needs it.
- `/api/client/login` (client sessions over HTTP) is A8; client-session behaviour is covered by
  unit tests only so far.

## Fix round 1

Review `a4-review.md` (gpt-6-astra#high); controller ruling in `progress.md`. Base 9b04c3a1 (D1 merged
on top of ebb4d240; no A4 files touched by it). Evidence: `/tmp/opencode/a4-fix1/`.

**I1: the hashing bound now limits running Argon2 jobs.** `AdminAuth::hashing` takes an owned
permit from an `Arc<Semaphore>` (`acquire_owned`) and moves it into the `spawn_blocking` closure.
The permit is released only when the closure exits. Before this, the permit belonged to the
awaiting future: dropping it (a client hang-up) freed the slot while `spawn_blocking` work, which
cannot be cancelled, kept running.
- `admin_auth::tests::hashing_bound_survives_cancelled_waiters`: deterministic. 2 permits; 4 waves
  of 2 jobs, each a blocking closure parked on a gate that counts itself in and out; every awaiting
  task is aborted once its wave has had the chance to start. RED (permit held by the future):
  **"8 blocking jobs ran at once with 2 permits"**. GREEN: peak ≤ 2. Once the gate opens all
  permits come back, so cancellation never strands one.
- `tests::a_hung_up_login_keeps_its_hashing_slot_until_argon2_finishes` (lib, real server over
  TCP): the stored admin hash is a Bun-written argon2id with t=40, so verification runs for
  seconds. A login is sent, the test waits until a permit is held, then drops the socket.
  RED: **idle permits back to 8 (all) after the hang-up** while Argon2 still ran. GREEN: still
  `permits − 1` 300 ms after the hang-up, and back to all once the job ends.
- Logs: `i1-red-final.log` (both fail), `i1-green-final.log` (both pass); the gate test was
  repeated 5× with no flake.

**Minor 1: `POST /api/setup` reports every `setInitialPassword` failure as 400 BAD_REQUEST with
the described message,** as frozen `admin.ts:225-230` does (ruling: TS parity).
- Store errors now carry `describeError` of what `bun:sqlite` would throw: SQLite's own
  `sqlite3_errmsg` text, or `SQLiteError` (the error's name) when that text is empty. Probed
  against the TS binary with refusal triggers on the `adminPasswordHash` insert:
  - `RAISE(ABORT,'review write denied')` → `"review write denied"`
  - `RAISE(FAIL,'')` → `"SQLiteError"`
  - a NOT NULL failure inside the trigger → `"NOT NULL constraint failed: x.a"`
  - `RAISE(IGNORE)` → 409 (the row was not written)
- **Secrets.** SQLite messages contain neither the SQL, the bound values nor the database path,
  so no password, stored hash, key or path can appear. The single exception needs the operator to
  install a trigger whose message is `NEW.value`. That echoes the new hash of the password this
  caller just sent (never stored), and TS echoes exactly that too (probed). Other failures in the
  path are the argon2 crate's parameter errors and a blocking-task join error; neither carries
  input.
- Other routes still redact any non-password failure to `500 INTERNAL "internal error"`, as
  `apiErrorResponse` does for non-`GatewayError`s.
- Driver: 4 new configs (`setup-store-abort`, `-fail-empty`, `-ignore`, `-constraint`). Each
  installs the trigger in the copied database before boot, then runs setup, then status (still
  unconfigured), then login (401). Rust test: `a_store_refused_setup_is_bad_request_with_sqlite_s_message`
  (tests/server.rs) and `store_failures_carry_sqlite_s_message_only` (unit).

**Minor 2: the 413 rows assert TS's exact bytes.** TS must be exactly `413` with no headers and
no body (`TS_413`); Rust must be exactly `413` + `content-length: 0` (`RUST_413`, the documented
framing exception). This is no longer a status-only check. All 4 rows pass.

**Added coverage.**
- **Persistent concurrent first setup.** Unit test `concurrent_first_setups_have_one_persistent_winner`:
  8 parallel `set_initial_password` calls on a multi-thread runtime produce exactly one winner. A
  fresh connection then reads that winner's hash, and only the winner's password verifies and logs
  in. Driver configs `setup-race-1/2`: 8 concurrent `POST /api/setup` against each binary give
  `200 ×1, 409 ×7` with the TS 409 body; afterwards exactly one password logs in, and it is the
  setup winner's. The log comparison sorts lines for race configs, because which password wins is
  the scheduler's choice.
- **Guard truth table.** `api::tests::guards_admit_exactly_their_principals` runs
  `require_admin` / `require_reader` / `require_client` against admin, viewer and client
  principals, no cookie, an unknown token, and an expired session:

  | principal | admin guard | reader guard | client guard |
  |---|---|---|---|
  | admin | ok | admin | `client session required` |
  | viewer | `admin session required` | viewer | `client session required` |
  | client | `admin session required` | `admin session required` | `k1` |
  | none / unknown / expired | `admin session required` | `admin session required` | `client session required` |

- **Invalidation scope.** `changing_the_admin_password_ends_every_session` now also holds a client
  session whose key stays usable. The password change ends it too, and the KV is empty afterwards,
  so "every kind" is now tested. `viewer_password_changes_spare_admin_and_client_sessions`
  confirms a viewer-password change ends only viewer sessions.
- Driver robustness: before comparing log lines, the driver waits until each boot's log file
  contains its shutdown line, because the stdout file can trail process exit.

**Inherited race (deferred to D2, per ruling).** A login (or viewer login) can read the old hash,
finish Argon2 after a concurrent `set_password` / `set_viewer_password` has deleted sessions by
prefix, and then issue a session that survives the change. TS has the same ordering: a store
read, a slow verify, then `issue`, with no generation check. Prefix deletion gives sequential
invalidation, not linearizable invalidation. D2's shared session store should decide whether to
add a credential generation (stamped into each session and checked on `verify`) or an atomic
issue-if-generation. The `SessionKv` trait does not guarantee either today.

**Verification (final binary `rust-fix1`):**
- `conformance/e2e/admin-auth.ts`:
  - RED, the A4 binary with the final driver: 206 equal / 4 asserted / **6 failures** (the 3
    store-error setups, each a DIFF plus a LOGS line).
  - GREEN: **212 equal / 4 asserted (exact bytes both sides) / 0 failures**, 116 distinct tokens.
- `cargo test --workspace --no-fail-fast`: **846 passed / 0 failed / 7 ignored** (839 at
  9b04c3a1, plus 7 new). One earlier run stopped on the unrelated
  `omni-gateway-core` snapshot test `the_refresher_picks_up_another_connections_commit_within_a_poll`
  (timing, 1 s window). That run overlapped surface.ts and run.ts, and an even earlier attempt hit
  ENOSPC. The test then passed 5/5 alone and in the full rerun. Flagged as a possible load-sensitive flake.
- `cargo clippy --workspace --all-targets -- -D warnings` clean; `cargo fmt --all --check` clean;
  Biome on the driver clean.
- `conformance/e2e/surface.ts`: 606 equal / 61 expected / 0 failures (unchanged).
  `conformance/e2e/run.ts`: all rows equal.
- `/v1` path unchanged by this round.
