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
