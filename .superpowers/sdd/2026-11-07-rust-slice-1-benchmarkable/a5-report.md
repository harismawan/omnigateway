# A5 report: admin keys / models / catalog / settings / password routes

Base 61e19950, code commit 5da6af7e. Brief: `a5-brief.md`. Evidence: `/tmp/opencode/a5/evidence/`.
Implementer opus-pr. Controller review (gpt-6-astra#high) pending.

## What changed

**Routes** (`crates/omni-gateway/src/admin_routes.rs`, wired through A4's `api::route`/`serve`)
- `GET|HEAD /api/models`, `PUT|DELETE /api/models/:id`, `GET|HEAD /api/catalog`,
  `GET|HEAD /api/keys`, `POST /api/keys`, `PUT /api/keys/:id/{limits,models,expiry,guardrail,smart-routing}`,
  `DELETE /api/keys/:id`, `GET|HEAD /api/settings`, `PUT /api/settings`,
  `PUT /api/settings/password`, `PUT /api/settings/viewer-password`.
- Each handler follows admin.ts's order: the guard first (`requireReader` for reads, `requireAdmin`
  for writes), then the body, then the operation. Path params are decoded as Elysia's
  `fast-decode-uri-component` does: `%2F` is part of the id, and an undecodable param becomes `null`.
  A `null` id never matches a body id and deletes or revokes nothing. Unmatched
  methods and sub-paths keep A4's fallthrough.
- Config reads and writes use a dedicated `ControlStore` connection (opened at boot, mutex,
  blocking pool), never the `/v1` connection. A non-`GatewayError` failure answers
  `500 INTERNAL "internal error"`, as `apiErrorResponse` does, and is logged with its reason.
  TS logs nothing on that path.
- Password routes reuse A4's `AdminAuth` (owned-permit hashing, session invalidation). TS wording
  and order are kept: the length rule is checked before verify, `admin password change refused` /
  `admin password changed` / `viewer password set|removed` logs, and a change ends every session or
  only viewer sessions respectively.
- `/api/catalog`: built-in descriptors only (no plugins, as in the CLI increment). It covers the
  palette-safe colour rule, `quotaResets: true` for anthropic/openai (the built-in OAuth flows with
  reset credits), and account-catalog models from `provider_data.modelCatalog` grouped and sorted by
  `localeCompare`. That sort uses ICU root collation via `icu_collator` 2.4 (the ICU 2.4 crates were
  already in the lock), matching Bun's order in a unit vector. Problems are logged once per process,
  as `reportCatalogProblem` does.
- **Snapshot invalidation:** a write commits to SQLite, which moves `data_version` on the refresher's
  connection, so `/v1` picks it up within the 500 ms poll. There is no in-process emit (the poll is
  the single path). Measured in the driver: a minted key is admitted, a revoked key refused, and a
  put/removed model listed or unlisted on `/v1` within 1 s. Times were 0–500 ms on Rust and ~1–10 ms
  on TS.

**Control (`omni-control`)**, reusing the CLI ports without forking them:
- `body_schema.rs`: `keyCreateSchema`, `keyLimitsSchema`/`limitConfigSchema`, `keyModelsSchema`,
  `keyExpirySchema`, `keyGuardrailSchema`, `keySmartRoutingSchema` as zod 4.6.1 runs them, over
  `JsValue`. It reproduces first-issue ordering, strict unknown keys, record `__proto__`
  stripping and invalid-key handling, code-point lengths, `received Infinity`, and `parseOrThrow`'s
  safeToken'd path. The CLI built these bodies from flags and never needed this; HTTP accepts any JSON.
- `api.rs`: lossless key/model/settings/catalog operations. `toSummary` is built from the stored
  row with the edited field spread in, `limitUsage` comes from `sum_since`, the create answer is the
  only one carrying `key`, and lone surrogates survive to the response.
  `smart_router_models` mirrors `smartRouterModelStatus`, including the `TypeError` 500s on rows
  `localOnlyModel` cannot read.
- Fixes in the reused validators (found by the new oracles):
  - `model_schema` / `settings` printed `received number`/`null` where zod prints
    `received Infinity`/`-Infinity`/`undefined`.
  - `settings` measured `max` in UTF-16 units; zod 4.6 measures code points.
  - `settings` accepted `guardrailModel: -1e400` as `null`, because serde maps Infinity to null.
  - CLI settings and put suites still pass: settings 347, model-puts 302.

**Store (`omni-store`)**
- `JSON.parse` accepts lone surrogate escapes and serde does not. `/api` now stores them (TS does too),
  so the snapshot readers retry with the lone surrogates replaced by U+FFFD. This applies to
  `model_allowlist`, limits, `targets` and the settings row. Before this, such a row failed boot or
  marked a key unreadable; TS reads it fine.
- `OperatorKey.limits_json`, `keys::create_columns`, `keys::set_limits_encoded`: raw-column writes for
  JS-encoded values.

## Verification

**Black-box driver** `conformance/e2e/admin-routes.ts` (new). It runs the TS binary against the Rust
binary on copies of one CLI-seeded root, with raw HTTP/1.1 compared as status, sorted headers and
body bytes. After every step it also compares a whole-DB dump, covering all config tables, settings
rows with salted hashes classed, and minted ids/keys/hashes/prefixes and near-now timestamps masked
after validation.

The driver has 8 configs:
- **reads**: every route as anon/viewer/admin, HEAD, query, trailing slash, wrong methods.
  Body shapes on every body-reading route: BOM, whitespace, trailing garbage, text/form/multipart
  content types, no body. 50k-deep bodies.
- **reads-empty**
- **models**: guards, about 30 invalid bodies (schema, strict unknowns, `__proto__`, numeric keys, 1e400,
  lone surrogates, 20k deep, custom endpoint/pin/kilo reachability), encoded/numeric/unicode/
  undecodable/slash/case ids, replace, delete twice, 8 concurrent puts, `/v1` visibility.
- **keys**: about 20 invalid creates, 5 mints (full matrix with numeric/lone-surrogate model names,
  duplicate keys, 256-char override), every edit as every caller, unknown and undecodable ids,
  6 concurrent edits, 4 concurrent mints, revoke (repeat, unknown), `/v1` admit/refuse within 1 s.
- **settings**: guards, schema refusals including ±1e400, `__proto__`, lone surrogates, extras,
  smart-router states (unset/ok/notLocal/unresolved), 4 concurrent saves (asserted to be exactly one
  whole save).
- **passwords**: guards, malformed bodies, length rule, wrong current, session ending (caller, viewer
  only vs all), re-login with old and new passwords.
- **odd-rows**: hand-edited stored values (non-string allowlist entries, a string allowlist, a
  lone-surrogate override key, unknown strategy, junk settings).
- **broken-rows**: unparseable allowlist/targets, `provider_data = null`, which give TS 500s.

The driver also asserts that the `admin password …/viewer …/provider catalog …/api key limits …`
log lines are equal, and that each raw key appears in exactly one response, its creation's.

| run | binary | result |
|---|---|---|
| RED | `rust-before` (A4 fix1, 61e19950 code) | 100 equal / **588 failures** (`red.log`) |
| GREEN | 5da6af7e release | **688 equal / 0 failures**, 34 raw keys minted, each seen once (`green.log`) |

**Unit/oracle (frozen TS in-process via Bun):**
- `body_schema` 146 vectors equal to `parseOrThrow`. A mutation check (injected off-by-one and
  message typo) gave 3/146 caught.
- `http_oracle_tests`: `putSettings` 73 vectors compared on the stored row/refusal, `modelSchema`
  43 vectors.
- RED for these was the reused validators, 9 differences (`control-oracles-red.txt`).
- `key_mutations::lone_surrogate_escapes_in_stored_json_read_as_js_does`: RED gives Corrupt
  (`store-lone-red.txt`), GREEN passes.
- `tests/server.rs::admin_keys_models_settings_and_passwords_end_to_end`: RED gives 404 on the pre-A5
  router, GREEN passes.
- Route-table unit test, colour rule, and ICU order.

**Gates:**
- `cargo test --workspace --no-fail-fast`: **854 passed / 0 failed / 7 ignored**
  (`workspace.log`).
- An earlier attempt overlapped a stray second run, which caused a `failed_boot…` 2 s timeout; the
  test passed 3/3 alone.
- `cargo clippy --workspace --all-targets -D warnings` clean; `cargo fmt --check` clean; Biome
  clean on the driver.
- `surface.ts` 606 equal / 61 expected / 0 failures, `admin-auth.ts` 212 equal / 4 expected /
  0 failures, `run.ts` all rows equal.
- CLI `settings.ts` 347 PASS, `model-puts.ts` 302 PASS.

## Concerns / known differences
- **Boot strictness (pre-existing, out of A5 scope):** the Rust snapshot refuses to *boot* on some
  rows TS reads lazily, for example a REAL `api_keys.created_at` or an unparseable `model_allowlist`
  (TS boots and fails only the routes that read them). The driver writes those rows after boot and
  documents this. Suggest a later row makes boot reads as lenient as TS.
- Snapshot pickup on Rust is the 500 ms poll, against TS's in-process emit (~1 ms). It is within the
  spec's 1 s bound; a local invalidate hook would close the gap if wanted.
- `quotaResets` is fixed to the built-in flows that implement reset credits (anthropic, openai), not
  read from a runtime registry (no plugins).
- `/api/settings` makes three store reads (settings, models and credentials for smart-router status)
  on the control connection, plus the auth connection for `viewerConfigured`. That is fine for admin
  traffic.
- `limitUsage` sums come from `usage::sum_since`, as in the CLI. No usage was seeded in the driver
  (A7 covers usage), so `used` is only compared at 0.
- Out of scope: dry-run (A12), credentials (A6), usage/logs/console/nodes/agent-setup (A7).
- Disk: freed about 9.6 GB of stale debug test executables and incremental caches (regenerable) to
  get through linking; 2.4 GB free at the end.

## Fix round 1

Review `a5-review.md`; ruling in `progress.md`. Base 51a54e5a (D2 merged on 2cd757cb). Code commit
427dbcb1. Evidence: `/tmp/opencode/a5-fix1/`. TS answers for every new case were taken first from
the frozen binary (`probe/probe*.ts`).

**Correction to the first report.** Its final driver report file (`green-report.txt`) came from an
earlier 686-equal run. The matching log said 688/0. This round keeps the log and report of the same
run together: `green.log` and `green-report.txt` are both **811 equal / 0 failures**.

**I1: model identity is exact JS UTF-16 throughout.**
- **Store read** (`omni-store/keys.rs`): allowlist entries and `models` keys that contain a lone
  surrogate are no longer folded into U+FFFD. They are kept as exact UTF-16 in
  `ApiKey::lone_allowlist` and `LimitConfig::lone_models`. Well-formed entries stay `String`s.
  Collisions are no longer possible: `"\ud800"`, `"\udc00"` and U+FFFD are three different
  entries.
  - Lone override keys get every schema rule: 1..=256 code points, a strict scope that limits
    something, `__proto__` refused, and a 64-override cap that counts them too.
  - A lone key anywhere outside `models` makes the matrix unreadable, as zod's strict object does.
  - The lossless JSON parser moved from omni-control into `omni_ir::jsjson::parse_js`, so there
    is one copy; omni-control re-exports it.
- **Ingress:** `Ingested::model_lone` carries the request model's exact units (after JS `trim` and
  `[1m]` folding) when it holds a lone surrogate. It is only computed when the lossy model contains
  U+FFFD, so the ordinary path has no extra work.
- **Allowlist:** `ApiKey::allows(model, lone)` checks the chat routes and `count_tokens`. A
  well-formed model is matched against the well-formed entries only. A lone model is matched
  against the lone entries only.
- **`/v1/models`:** stored model ids are UTF-8, so only well-formed entries can match one. An
  allowlist `["\ud800"]` sees no U+FFFD model, as in TS.
- **A lone-surrogate model the key admits** (chat or responses): TS always fails with its URIError
  (`encodeURIComponent` at admission, or in every case at the completion's debit).
  - Rust refuses with the same `500 INTERNAL "String contained an illegal UTF-16 sequence."`, but
    before admission or dispatch.
  - TS sends the request upstream first and then crashes. Its 500 is sometimes the bare
    `text/plain` body Elysia writes when the error escapes its catch. Rust always answers in the
    dialect's JSON. This is the documented difference.
- **`count_tokens`** follows TS's rule exactly: a 500 only when an override names that exact
  model; otherwise it is judged against the key-wide limits alone.
- **Evidence:**
  - `tests/key_identity.rs::a_lone_surrogate_never_matches…`: RED fails, GREEN passes. It covers
    `/v1/models` visibility, 401s for U+FFFD (escaped and literal), distinct surrogates,
    whitespace and `[1m]` forms, the U+FFFD override's own 1/min (429) not shared by `\ud801`, and
    the `\ud800` override's 500.
  - Store unit tests cover distinct override keys and the schema rules.
  - An ingress vector covers every surface, duplicate `model` keys and surrogate pairs.
  - Driver config `key-identity` has 65 comparisons.

**I2: one unreadable key row never stops boot or refresh** (shared snapshot layer, SQLite and
Postgres).
- `SnapshotData.api_keys` is `Vec<Result<ApiKey, KeyRowError>>`, read with
  `keys::list_entries` / `pg::list_key_entries`. Misses use `find_entry_by_hash`.
- A row TS's `toKey` would throw on (an allowlist `JSON.parse` refuses) becomes that key's entry.
  The key is refused at auth as `INTERNAL` with JavaScriptCore's exact message (`JSON Parse error:
  Expected '}'`), as TS's `findByHash` throw is answered. Every other key, model and setting still
  loads and refreshes.
- Dates are read as the JS numbers TS compares (INTEGER, REAL or TEXT):
  - `expiresAt > now` stays exact for integer `now`, using the ceiling of a fraction;
  - a non-null `revokedAt` is revoked;
  - unparseable or non-text `limits` mark the key unreadable instead of failing the row.
- The admin listing still fails on a bad row, as TS's `keys.list()` does.
- The `api key limits unreadable` log now follows TS's `toKey`: once per read of the row, usable or
  not. The log comparison in the driver caught this.
- **Evidence:**
  - Store test `an_unreadable_row_is_isolated_in_the_snapshot_read`.
  - Core test `one_unreadable_key_never_poisons_boot_or_refresh`: a revocation, a model and a
    settings change all land despite the bad row.
  - HTTP tests `one_unreadable_key_row_does_not_stop_boot` and
    `a_corrupt_key_does_not_freeze_revocation_of_another`: both RED, both GREEN.
  - Driver configs:
    - `boot-bad-keys`: bad allowlist, fractional dates, fractional revoked and unreadable limits,
      all present at boot.
    - `live-poison`: A is served; B is corrupted live and refused within 412 ms; A is revoked over
      `/api` and refused in 478 ms; a model is put and listed in 490 ms.
    - `odd-rows` and `broken-rows` now boot with every bad row in place. The after-boot SQL
      workaround is removed, except for `provider_data = null`, which neither build's routing
      snapshot reads.

**I3: lossless `revokedAt`.** `OperatorKey.revoked_at` is read as stored, like the other two dates
(an INTEGER as an integer, a REAL as its number, TEXT as a string). The admin summaries, post-edit
summaries and CLI listing print it unchanged.
- **Evidence:** `tests/key_identity.rs::summaries_carry_fractional_dates_as_numbers` (RED 500,
  GREEN) covers INTEGER, fractional REAL and NULL for all three dates, on the listing and on an
  edit. The driver's `odd-rows` adds `odd-frac` and `odd-null` rows with edits.

**Minors**
- **Deadlines** (`admitted`, `listed`): each binary is now checked on its own. An answer counts
  only if the request both started and finished within 1 s of the step's start. A miss is a
  `DEADLINE` failure even if both binaries miss.
- **`content-length`** is validated against the body's length, then masked.
- **Secrets:** each raw key must be seen exactly once, in the step that minted it, and no foreign
  raw key may appear.
- **Boot refusals:** a binary that refuses to boot fails that config step by step instead of
  aborting the run. This is how RED is measured on the A5 binary.
- **Sequential mints** are spaced 3 ms apart. TS and Rust order same-millisecond ties differently;
  the order follows SQLite's row order, and the concurrent-mint step is still compared by DB dump.
- **Whole-DB claim, narrowed.** The per-step dump covers every table except `nodes`,
  `request_logs`, `usage_rollup`, `usage_daily` and `migrations`. Salted password hashes are
  classified rather than compared. These are written on the gateways' own clocks; `run.ts`
  compares them.
- **Failed-boot test:** the phase under test (the 10 ms seed bound) is still asserted through the
  error it produces. The outer timeout is now 30 s, only to catch a hang, and failures report the
  elapsed time.

**RED → GREEN** (`conformance/e2e/admin-routes.ts`, final driver):

| run | binary | result |
|---|---|---|
| RED | `rust-a5` (5da6af7e) | 721 equal / **61 failures** (key-identity 20, boot-bad-keys 12, odd-rows 13, broken-rows 9, live-poison 7) (`red.log`) |
| GREEN | 427dbcb1 release | **811 equal / 0 failures**, 38 raw keys, each seen once in its own mint (`green.log`, `green-report.txt`) |

**Gates**
- `cargo test --workspace --no-fail-fast`: **978 passed / 0 failed / 7 ignored**
  (`workspace.log`; count includes D2's crates).
- `cargo clippy --workspace --all-targets -- -D warnings` clean (`clippy.log`); `cargo fmt --check`
  clean (`fmt.log`); Biome clean (`biome.log`).
- Drivers:
  - `admin-auth.ts`: 212 equal / 4 expected / 0 failures.
  - `surface.ts`: 606 equal / 61 expected / 0 failures.
  - `run.ts`: all rows equal.
- CLI suites: keys-list 135, key-mutations 16, settings 347, model-puts 302, all PASS.

**Concerns / known differences**
- **Lone-surrogate model a key admits:** Rust refuses before dispatch with TS's message. TS
  dispatches (possibly upstream) and then 500s, sometimes as `text/plain` with a different stored
  row status. Rust's direction is safe: nothing is claimed or spent.
- **Rows stored as U+FFFD:** a row from such a request stores `requested_model` as U+FFFD (SQLite
  UTF-8, as in TS). A later seed of a real U+FFFD override reads it in both builds. Rust's in-memory
  debit also counts it, where TS's throws before the model subject. This applies only to rows from
  requests that ended in that 500.
- **Bad key in the snapshot:** until a repair, a bad key's refusal comes from the snapshot, which
  catches a corruption within one poll (≤ 500 ms). TS reads the row on every request.
- **Repair path:** a bad key cannot be repaired over `/api` in either build, because the edit
  reads the row first.
