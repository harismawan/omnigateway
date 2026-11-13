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

## Fix round 2

**Bookkeeping status: BLOCKED by the fresh surface gate (2 failures); stopped without a
source fix or retry.** Retained passing results below do not supersede that failure.

Review: `a5-r1-review.md`. Range: `04c3c5af..2b6f1165`; implementation `2998e305`,
follow-ups `d4e2d54f`, `d12b397b`, `1727cde2`, `ba0edb26`, `2b6f1165`.
Evidence root **E = `/tmp/opencode/a5-fix2/`** below; every relative log path in this
section is relative to E. This bookkeeping pass read the review, commit stats and diffs,
test-result lines, driver reports, CLI output, RED and mutation output. It adds no source fix.
The corrections below supersede conflicting claims in the original report and round 1.

### Findings → changes → evidence

**R1 — lossless public limits and shared persistence (`2998e305`).**
`LimitConfig::to_js` / `to_json_text` restore lone-surrogate overrides at their original
positions. Shared create/edit writers preserve those limits and interleaved allowlist names
on SQLite and Postgres. CLI JSON summaries and usage use exact JS values; human output keeps
all entries, printing lone names as replacement characters as TS does. CLI limit edits retain
overrides flags cannot spell. `to_json_well_formed` is explicitly partial; serde serialization
still uses that partial diagnostic view, not the complete persistence/operator form.

- Behavioral RED: `red-r1-cli.txt` shows the missing override/usage beside genuine U+FFFD;
  `red-store-round-trip.txt` fails `lone_surrogate_limits_and_allowlists_round_trip_through_shared_writers`
  at the edit with `Corrupt("unreadable limits")` (not a compilation failure).
- `mutation-r1-create-columns.txt` restores only the lossy create helpers: the same contract
  test fails its exact column comparison, demonstrating create loss independently of edit.
- GREEN: that contract test passes in `workspace.log` (SQLite leg), `store-postgres.log`
  and `pg-legs-ran.txt` (explicit SQLite + Postgres execution). `green-r1-cli.txt` shows the
  review's API-created lone-only key listed identically, including `limitUsage`.
- `conformance/cli/lone-surrogates.ts`: `d12b397b` adds the 64-override cap and lone-only
  edit matrices; `ba0edb26` adds API-created keys and explicit listing assertions.
  `red-cli-lone.txt` reports **35/36 differing comparisons**, while
  `cli-lone-surrogates.log` reports **36 PASS** (bytes, status, whole `api_keys` table).

**R2 — completion identity (`2998e305`; driver strengthening `ba0edb26`).**
The finisher carries `model_unencodable` through both writers into transient
`Completion::debit_model`. Such a completion debits the key-wide subject only; the persisted
U+FFFD name is not used to choose its live model subject.

- Behavioral RED `red-r2.txt`: gateway test
  `an_early_refused_lone_model_never_debits_the_replacement_character_model` gets 429 instead
  of 200 live. GREEN `workspace.log`: that test passes, including its distinct post-restart
  expectation of 429 from persisted U+FFFD history.
- Companion test `an_early_refused_lone_model_still_debits_the_key_wide_subject` passes in
  `workspace.log`. `mutation-key-wide-debit.txt` disables that debit: companion fails
  (200 instead of 429), while the non-aliasing test still passes; **1 passed / 1 failed**.
- `a_completion_carries_the_requests_model_identity_not_the_stored_name` passes in SQLite
  `writer.rs` and live-PG `pg_writer.rs`; `pg-legs-ran.txt` explicitly records the latter.
- Driver `key-identity` seeds U+FFFD's long window with `count_tokens`, refuses a lone model,
  then counts U+FFFD twice without a restart. `red.log` / `red-driver/report.txt` have two
  200-versus-429 failures; `green.log` / `green-driver/report.txt` have neither.
  `ba0edb26` pins both complete normalized responses for the one admission-header divergence,
  requiring a difference rather than masking all headers. `mutation-pinned-divergence.txt`
  sends TS on both sides and fails **UNEXPECTED-EQUAL** (82 equal / 0 expected / 1 failure).

**R3 — linear extraction and duplicate handling (`2998e305`, robustness `1727cde2`).**
Ingress extracts the final top-level model string with a linear scanner, skipping unrelated
values. The full lossless parser indexes objects wider than eight members, preserving
insertion order, last-duplicate-wins semantics and distinct UTF-16 names.

- `red-r3.txt` is **compilation RED only**: missing `scan_steps`, not a measured behavioral
  regression. Behavioral mutation evidence is `mutation-r3.txt`: disabling the object index
  fails `the_lossless_parser_handles_wide_objects_and_duplicates_linearly` at 200,347,829
  steps for 277,826 bytes; restoring whole-body quadratic ingress also fails
  `recovering_a_lone_model_is_linear_in_a_wide_body` at 200,267,852 steps for 277,848 bytes.
- Both tests pass in `workspace.log` and `dialects-after-doc.log`; these are structural
  work-count checks, not throughput benchmarks. The HTTP driver also exercises a 20,000-key
  ignored object next to a literal U+FFFD model.
- `top_level_string_agrees_with_the_full_parse` passes. `red-extractor-total.txt` records
  `top_level_string_never_panics_on_text_that_is_not_json` panicking on a truncated string;
  `1727cde2` fixes it and `workspace.log` records GREEN. The extractor is intentionally not
  a JSON validator; malformed input can return a member-shaped prefix or None.

**Minor 1 — independent content-length assertions (`2998e305`).**
`lengthProblem` now produces a per-binary failure even when both binaries have the same bad
length. Twelve startup self-check cases cover bad/duplicate/nonnumeric lengths, HEAD,
204/304 and chunked framing. HEAD/no-body responses are checked for no transmitted body,
not equality with representation length. GREEN is the admin-routes run; no separately
retained pre-fix behavioral RED for this minor. The self-checks are not extra Rust test counts.

**Minor 2 — empty stored allowlist wording (`2998e305`, PG regression `d4e2d54f`).**
Stored JSON uses `parse_js`'s `JSON Parse error: Unexpected EOF`, not empty request-body
wording. `red-empty-allowlist.txt` and `red-pg-empty-allowlist.txt` each show **0 passed /
1 failed** on the message comparison. GREEN tests are
`an_unreadable_row_is_isolated_in_the_snapshot_read` (SQLite) and
`an_unreadable_allowlist_is_isolated_with_json_parses_message` (live PG, `pg-legs-ran.txt`).
The latter checks bad/empty rows alongside a healthy row and continued admin-list refusal.
Driver `boot-bad-keys: bk-empty GET /v1/models` is the third behavioral failure in `red.log`,
and passes in `green.log`. This adds real PG store/snapshot-read evidence; the gateway
refresh/miss integration remains SQLite-only.

**Minor 3 — reset claim (`2998e305`).**
`normalizeV1` now explicitly says reset/retry values are masked. These runs establish their
presence/shape where compared, not correctness against a clock. Documentation correction;
no RED/GREEN correctness test for reset values is claimed.

**Minor 4 — secret assertion scope (`2998e305`).**
The driver counts textual occurrences in observed response heads/bodies and captured process
stdout/stderr, and records mint-validation exceptions instead of swallowing them. Its
overlapping-occurrence self-check runs at startup. GREEN covers **38 minted raw keys**,
each once in its own mint response within that observed scope. No independent pre-fix
mutation/behavioral RED is retained for this minor; no claim about arbitrary unobserved
output is made.

**Minor 5 — report precision (`2998e305`, `2b6f1165`, this report appendix).**
`2b6f1165` changes only the ingress documentation to say TS throws at admission for an exact
override, otherwise whenever a completed row's debit is attempted. Timing, streaming,
accounting, reset masking and CLI counts are corrected below. Round 1's `red-store.txt`
was a compile failure against absent APIs, distinct from its four behavioral HTTP REDs.
This round's complete driver pair is **847 equal / 1 expected / 3 failures → 850 equal /
1 expected / 0 failures**; each log is byte-identical to its corresponding `report.txt`.

### Gate chronology and retained results

Times here are 2026-11-13 UTC+07. The last runtime-code change is `1727cde2` at **12:35:47**;
`ba0edb26` at **13:11:53** changes test drivers only; HEAD `2b6f1165` at **13:21:50** changes
one documentation line. `workspace.log` finishes at **13:30:14**, after HEAD; its compile
duration is 53.80 s and summed suite durations 182.62 s (approximately a 13:26 start).
It includes the final extractor regression. The file was initially created at 11:32 and
reused, so its birth time is not this run's start. No later commit changes code. The log
does not embed a SHA/start timestamp: chronology supports final-HEAD execution, rather
than providing a cryptographic source/binary attestation.

- `cargo test --workspace --no-fail-fast`, retained `workspace.log`: summed **988 passed /
  0 failed / 7 ignored**, across 103 result summaries. No workspace rerun needed.
  PostgreSQL tests that return early without `OMNI_TEST_DATABASE_URL` still count as passes;
  this is not a claim that the workspace run exercised PG.
- Retained `clippy.log` ends successfully at **13:23:28** with no diagnostics
  (`cargo clippy --workspace --all-targets -- -D warnings` gate). `fmt.log` is empty at
  **13:26:15**, but has no saved exit status; a fresh format check is recorded below.
- `dialects-after-doc.log`, after HEAD: **52 passed / 0 failed / 0 ignored**.
- Live-PG store suite `store-postgres.log`: **143 passed / 0 failed / 5 ignored**;
  runs 7 and 8 also have those totals. `pg-legs-ran.txt` at **13:23:45** explicitly
  records three focused tests actually running with PG (each **1 passed / 0 failed**):
  R1 round trip, malformed allowlist isolation, R2 completion identity. It separately
  demonstrates two PG-only tests silently returning when the URL is unset.
- Retained drivers: `admin-auth.log` **212 equal / 4 expected / 0 failures**;
  `surface.log` **606 equal / 61 expected / 0 failures**. `run.log` says **all rows equal**:
  41 request cases, disconnect check, request-ID check, and four DB comparisons
  (`request_logs` 37 rows, `usage_daily` 18, `usage_rollup` 6, `credential_health` 4).
- CLI retained logs: `cli-keys-list.log` **135**; `cli-key-mutations.log` **156 mutation +
  4 repair + 3 usage/null-pruning + 5 PTY + 16 creation** comparisons; `cli-captured-summary.log`
  **PASS** (no count printed); `cli-date-boundaries.log` **40**;
  `cli-settings.log` **347 plus crossread**; `cli-model-puts.log` **302**;
  `cli-lone-surrogates.log` **36**, all passing. `cli-model-reads.log` **262**,
  `cli-model-catalog.log` **510 comparisons + 12 Rust-only plugin-refusal checks**,
  `cli-model-removals.log` **47**, all passing after the last runtime-code change.
  `cli-provider-catalog.log` only says it wrote a data file: it is a generator result,
  not a golden-suite PASS. `biome.log`: **2 files checked, no fixes applied**.

### Fresh bookkeeping gates — stopped on failure

The retained admin-auth/surface/run and several CLI logs predate `1727cde2`, and the retained
release copy `bin/rust-fix2` is timestamped 12:29, also before that parser change. Thus even
the later admin-routes log alone does not establish which parser binary it exercised.
The final CLI driver was committed after its retained run. A sequential, fail-fast refresh
was started at final HEAD; `bookkeeping/manifest.txt` records SHA, exact commands, start/end
times and exit codes. Rust binaries were built in place at `target/release`; the TS binary
was `/tmp/opencode/a5/bin/ts-omnigateway`.

| Fresh gate | Result | Log under E |
|---|---|---|
| `cargo build --release -p omni-gateway -p omni-cli` | exit 0 | `bookkeeping/build.log` |
| `cargo fmt --check` | exit 0, no diagnostics | `bookkeeping/fmt.log` |
| `admin-routes.ts` | **850 equal / 1 expected / 0 failures**, 38 raw keys | `bookkeeping/admin-routes.log`, `bookkeeping/admin-routes/report.txt` |
| `admin-auth.ts` | **212 equal / 4 expected / 0 failures**, 116 distinct tokens | `bookkeeping/admin-auth.log`, `bookkeeping/admin-auth/report.txt` |
| `surface.ts` | **604 equal / 61 expected / 2 failures**, exit 1 | `bookkeeping/surface.log`, `bookkeeping/surface/report.txt` |

The two failures are `unset: unset GET /` and `unset: unset GET /nested`: TS returns JSON
404 (`NOT_FOUND`); Rust returns 200 `text/html`, content-length 1494, containing the dashboard.
The failing run used the in-checkout release binary; no cause or relationship to A5 is
established. Per task instruction, execution stopped at this failure; no source/environment
fix and no retry was attempted. Queued fresh `run.ts` and CLI gates did **not** execute;
their earlier logs remain retained evidence only. The workspace, clippy and live-PG gates
were not rerun. Initial free disk was 6.3 GiB, so no incremental-cache deletion was required.

### Remaining concerns and accepted divergence

- **Early refusal is accepted narrowly, per the review.** Rust rejects an admitted lone-surrogate
  model before rate-limit admission/dispatch with `500 INTERNAL` and TS's illegal-UTF-16
  message in the dialect JSON envelope. This can differ from TS's plain-text envelope,
  admission headers, minute-window claims and stored status/error code. It avoids dispatch
  and upstream cost but **does not mean nothing is spent**: the completed row still charges
  applicable key-wide long windows. `probe-minute-ring.txt` shows TS's subsequent count at
  429 versus Rust 200; `probe-override-named.txt` shows both key-wide long budgets spent,
  with plain-text versus JSON refusal; `probe-spent-key.txt` shows different stored statuses.
- Do not claim TS universally sends upstream then returns 500: exact overrides throw before
  dispatch, unknown models can fail routing first, and streaming may have emitted its head
  or content before completion debit throws. These retained probes principally cover refusal
  cases, not a successful upstream stream.
- Persisted names still use U+FFFD in both builds; later seeding can read that history as a
  genuine U+FFFD model. The repaired live completion path is deliberately distinct from
  post-restart seeding; it never debits that other model's already-seeded live subject.
- **500 ms is a poll interval, not a hard bound.** Read/build/publication/scheduling follow
  the tick. The driver checks one second from its poll step, after mutation/dump, not from
  commit. Retained GREEN live-poison observations are 424 ms refusal, 476 ms revocation,
  **513 ms model visibility**, directly contradicting the earlier hard-500-ms wording.
- PG suite history is not uniformly green. `store-postgres-run1-flake.log` is **141/1/5**
  (SQLite `a_pinned_reader_lets_the_wal_grow_past_the_trigger`); runs 2–6 each **142/1/5**:
  `a_value_postgres_refuses_fails_only_its_own_event` (2,4),
  `a_refused_log_event_is_counted_failed_and_refused_not_written` (3,5), and
  `a_transition_lands_while_log_batches_fail` (6). PG failures report
  `Writer("1 queued events failed to persist on close")`. Later green runs do not erase them.
  `pg-writer-flake-at-head.txt` reports 7/30 failing writer runs at `1727cde2` (5 refused-event,
  4 refused-value failures, overlapping), with 30/30 health runs green. The retained base
  probe reports related failures at `04c3c5af` (3/30 refused-event, 5/30 refused-value,
  1/30 blocked-writer transition), but also unrelated TS cross-read failures caused by its
  archive lacking node_modules. That base probe is qualified evidence of pre-existing
  instability, not proof that every observed failure has the same cause. No fix attempted.
- Per-step admin DB dumps still exclude `nodes`, `request_logs`, `usage_rollup`, `usage_daily`
  and `migrations`; request/usage comparison is provided separately by `run.ts`.

### Fix round 2 — controller re-run of the failed gate (Nov 13)

The bookkeeping run's `surface.ts` failure (2 rows in the `unset` config: `/` and `/nested`, TS 404 vs Rust dashboard HTML 200) is a harness artefact, not a regression. That run pointed `--rust` at `target/release/omnigateway` inside the checkout, so Rust's documented default dashboard candidate `<exe dir>/../../apps/dashboard/dist` resolved to the checkout's real `apps/dashboard/dist`, while the TS bundle (in `/tmp/opencode/a4-fix1/bin`) resolved `/dashboard/dist`, absent. Logs: `unset-ts.log` "dashboard directory absent path=/dashboard/dist" vs `unset-rust.log` "dashboard directory resolved path=…/target/release/../../apps/dashboard/dist". Earlier rounds ran a copy of the binary outside the checkout.

Re-run at HEAD 2b6f1165 with the same release binary copied to `/tmp/opencode/surface-rerun/bin/` (`unset-rust.log`: "dashboard directory absent"):
- `surface.ts`: **606 equal / 61 expected / 0 failures** (`/tmp/opencode/surface-rerun/surface.log`).
- `conformance/e2e/run.ts`: **all rows equal** (`run.log`).
- CLI goldens (`OMNI_CLI_BIN=target/release/omni`): keys-list 135, key-mutations (156+4+3+5+16), settings 347, model-puts 302, model-reads 262, model-removals 47, model-catalog 510 + 12 refusal checks, lone-surrogates 36 — all PASS (`cli-*.log`).
Follow-up (minor): make `surface.ts` copy both binaries into a scratch directory so the location-relative default cannot see the checkout.
