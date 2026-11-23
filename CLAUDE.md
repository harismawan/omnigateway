# OmniGateway Repository Guidance

Agent guidance for repo work: architecture, boundaries, conventions, durable traps.
`README.md` serve operators; `ARCHITECTURE.md` explain how system fit together; this file serve
contributors. Update all that change touch.

**This file is loaded every session; keep it lean.** Add here only an invariant a contributor break
by not knowing it, in the fewest lines that name the file, symbol and test that pin it. Anything
else go where its subject already live: how a subsystem work → `ARCHITECTURE.md`; operator-facing
behaviour → `README.md` / `docs/*.md`; design rationale → `docs/superpowers/specs/`; forensic
history behind rule — how found, what measured, earlier wrong drafts — under `## History` in
matching spec. One line here with a pointer beat a paragraph. Never restate what a test already pin,
and never narrate a fix: state the rule that survive it. A rule marked **unpinned** has no test
holding it: a change there is the moment to add one.

## Scope

OmniGateway = self-hosted AI gateway: a Rust Cargo workspace (`crates/`, one binary) plus the
React/Bun console it serves.

- `crates/omni-gateway`: the `omnigateway` binary — hyper server, auth, dispatch, streaming egress,
  `/api/*` routes, push socket, loops, shutdown. `main.rs` dispatches to the CLI when invoked as
  `omni` or `omnigateway omni …`
- `crates/omni-gateway-core`: boot config, in-memory routing snapshot + refresher, single-node
  limiter
- `crates/omni-cli`: `omni` — local install administration (also its own `omni` bin)
- `crates/omni-control`: operator operations shared by `/api/*` and CLI; owns
  `data/provider-catalog.json`, the **only** built-in catalog source
- `crates/omni-dialects`: client dialects — Anthropic Messages, OpenAI Chat, Responses
  ingress/egress
- `crates/omni-providers`: provider codecs (`anthropic/`, `openai/`, `antigravity/`, `custom/`),
  SSE parser, order-preserving outbound HTTP client, quota probes
- `crates/omni-router`: pure ranking — filters, score, breaker, quota, model resolution
- `crates/omni-ratelimit`: pure limit arithmetic — windows, buckets, evaluate, combine
- `crates/omni-cluster-limit`: Redis/Valkey cluster limiter, batched debits, seeding, load publish
- `crates/omni-coord`: coordination trait + `MemoryCoord` + `RedisCoord` (Lua scripts)
- `crates/omni-ir`: provider-neutral model + JS-compatible JSON writer
- `crates/omni-store`: SQLite (default) + Postgres (cluster) stores, migrations, batched writer
- `crates/omni-crypto`: byte-exact field encryption, key hashing, Codex/Qoder id derivations
- `crates/omni-rtk`: pure tool-result filters — **built and tested, not wired into dispatch** (see
  `dispatch.rs` "RTK and ponytail")
- `apps/dashboard`: admin console (React, styled-components, Bun build), served from `dist/`
- `scripts/`: npm packaging (`build-npm.ts`), bench harness, hygiene checks, capture tools
- `packaging/npm`: npm launcher + platform package templates

Approved designs in `docs/superpowers/specs/`; matching plans in `docs/superpowers/plans/`. Read
spec before change, but verify current code — specs and plans name the code as it was.

## Commands

Rust, from repo root (toolchain pinned in `rust-toolchain.toml`):

```bash
cargo build --workspace
cargo test --locked --workspace
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
cargo run -p omni-gateway --bin omnigateway          # gateway; config from process env only
cargo run -p omni-gateway --bin omnigateway -- omni --help   # the CLI through the gateway binary
```

PG/Redis suites skip unless pointed at servers; CI's `rust` job sets `OMNI_TEST_DATABASE_URL`,
`OMNI_TEST_PG_URL` (Postgres 17), `OMNI_TEST_REDIS_URL` (Valkey 8), `OMNI_TEST_REQUIRE_PG=1`,
`OMNI_TEST_REQUIRE_REDIS=1` (skip becomes failure), and `OMNI_TEST_REDIS_DOCKER`/`_URL` naming a
**disposable** Valkey container the fault tests stop and pause. Copy that block from `ci.yml`.

Console and scripts, with Bun 1.4.4:

```bash
bun install --frozen-lockfile
bun run test               # scripts/ suite, then console suite (happy-dom)
bun run typecheck          # scripts + console
bun run lint               # biome
bun run fmt
bun run check:claims       # stale-claims; reads git history
bun run check:dead         # dead exports
bun run build:dashboard            # typecheck + production build into apps/dashboard/dist
bun run dev:dashboard              # 5173; rebuild + full reload; proxies /api, /health to 9000
bun run --cwd apps/dashboard test  # console suite alone
```

`apps/dashboard/tooling/transforms.ts` adapts pinned public TanStack hooks plus Babel
styled-components (no Vite runtime). `tooling/serve.ts` owns dev/preview; dev rebuilds the
production graph then reloads, resetting state rather than Fast Refresh.

Release: `bun run build:npm v1.2.3 <assets-dir>` builds four platform packages + `omnigateway` from
release archives. Push `v*` tag run `.github/workflows/release.yml`; tag = sole version source
(`OMNI_CLI_VERSION` at build). Before claim done, run focused changed-behaviour tests and every
check in `.github/workflows/ci.yml` (`rust` and `verify` jobs).

## Architectural boundaries

**Single-copy rules.** Never re-derive these locally. Console copies live in
`apps/dashboard/src/lib/domain.ts`, each naming its Rust twin, pinned by
`apps/dashboard/test/lib/domain.test.ts` on the Rust test's cases:
- `ApiKey::usable` (`crates/omni-store/src/keys.rs`): revoked or expired unusable;
  `expires_at == now` is expired. Pin: `crates/omni-store/tests/key_mutations.rs`.
  `client_key_usable` in `omni-control/src/admin_password.rs` restates it for the raw-row path —
  keep the two together.
- `credential_expired` (`omni-router/src/filters.rs`): only an OAuth token past expiry **with no
  refresh token** excludes at routing. Pin: `filters.rs` test
  `expiry_excludes_only_an_unrefreshable_oauth_credential`.
- `serves_target` (`omni-router/src/filters.rs`): provider, custom endpoint and pin are one
  question; router, `model_limits`, `omni-control` `diagnostics.rs` (doctor pins) and `setup.rs` ask
  it there. Pins: `crates/omni-router/tests/filters.rs` (`a_pin_*`, `pairs_custom_targets_*`).
- `rolled_over` (`omni-router/src/quota.rs`): null `resets_at` is not rolled over. Pin:
  `crates/omni-router/tests/quota_breaker_resolve.rs`. Not single-copy in Rust: `omni-control`
  `client_quota.rs`, `credentials.rs` and `omni-cli` `quota.rs`/`status.rs` inline the same test.
- Read scope has no shared `Scope` type: client routes pass the session's `api_key_id` explicitly
  (`client_query` in `omni-control/src/logs.rs` writes it **after** forwarding the caller's
  filters).

1. `omni-ir`, `omni-router`, `omni-ratelimit`, `omni-rtk` stay pure: no I/O, no clock (`now` and
   `rand` are parameters), no `tracing`, no `std::env`. `omni-router` may depend on `omni-store`
   for types only (see its `Cargo.toml`). Unpinned beyond the dependency lists.
2. Provider wire formats, headers, signing, stream decoding stay in `crates/omni-providers`. A
   provider directory does not reach into another; shared helpers at crate root (`http/`, `sse.rs`,
   `codec.rs`, `response_format.rs`, `tool_result_files.rs`). **Divergence:**
   `anthropic/codec.rs` calls `custom::codec::needs_scope`, `antigravity/wire.rs` reads
   `anthropic::body::AGENT_PREAMBLE`.
3. Dispatch (`omni-gateway/src/dispatch.rs`) owns side effects, retries, refresh, deadlines,
   failover, commit point (first `BlockDelta`, or the pending cap `PENDING_MAX_EVENTS`/`_BYTES`).
   Pins: `crates/omni-gateway/tests/dispatch.rs`.
4. Routes (`server.rs` inference,
   `api.rs`/`admin_routes.rs`/`client_routes.rs`/`database_routes.rs`) authenticate, parse, apply
   key policy, call dispatch or `omni-control`, render. Admin rules belong in `omni-control`, not
   handlers.
5. `omni-control` knows nothing about caller type: no hyper, cookies, argv, terminal. Long-lived
   timers stay in `omni-gateway` (`maintenance.rs`, `refresh.rs`, `quota.rs`). Unpinned.
6. Store rows + secrets stay behind `omni-store`. A read/write added for one backend is added for
   **both** SQLite and `pg/`, plus a case in `crates/omni-store/tests/contract.rs` (`each` runs
   SQLite then Postgres). Postgres routing changes reach other replicas as row identities on the
   `routing` topic (`omni-gateway/src/routing.rs`); a 500 ms version poll repairs misses.
7. All outbound provider HTTP goes through `omni_providers::http::HttpClient`; OTLP export too. The
   client writes headers in the given order and casing. Pin:
   `crates/omni-providers/tests/http_client.rs`.
8. Catalog pricing gives defaults. Router prices from saved targets; catalog edits hit new targets
   only. Catalog JSON pinned by `crates/omni-router/tests/*_catalog.rs`.
9. CLI administers local SQLite installs through `omni-control`, never `/api/*`. Postgres fleets are
   administered over HTTP. Unpinned.
10. Console calls `/api/*` only, including `/api/stream`; `/health` alone stays plain polling. It
    imports nothing from `crates/`, `@omni/*` or `@omnigateway/*`, type-only included, and nothing
    from `scripts/`. Pin: `apps/dashboard/test/imports.test.ts`. Wire shapes mirrored in
    `src/api/types.ts`; constants copied from Rust held by `test/api/rustMirrors.test.ts` (reads
    Rust source; never the reverse). Provider list/order/label/colour/models come from
    `GET /api/catalog`, never `theme/tokens.ts`. In `routes/_app.tsx`, resolve catalog in
    `beforeLoad` after session check, before mount; `errorComponent` shows error + retry and
    preserves expired-session `redirect`. Pin: `test/routes/appGate.test.tsx`. `/client` is `_app`'s
    **sibling**, so nothing resolves the catalog for it: a component shared with a console board
    must not call `useProviderCatalog` above its `operator` gate, and its test passes
    `makeQueryClient({catalog: false})`. Pin: `test/features/client.test.tsx`. `providerColor`
    (`theme/tokens.ts`) is the only place a provider id becomes CSS: it checks `SAFE_PROVIDER_ID`
    because stored targets/log rows are never re-validated, and returns
    `var(--p-<id>, var(--ink-faint))`; never move the guard to call sites. Pin:
    `test/theme/providerColorOnly.test.ts`.
11. `omni-coord`: one trait, `MemoryCoord` + `RedisCoord`. Every impl: a claim visible to every
    concurrent claimant **when issued** — memory futures complete on first poll. Pins:
    `crates/omni-coord/tests/{contract,memory}.rs`
    (`every_memory_call_completes_on_its_first_poll`). Redis scripts are byte-stable across a fleet:
    `scripts_are_byte_stable` in `omni-coord/src/redis/scripts.rs` pins each digest. Redis failure
    falls back per primitive to an embedded `MemoryCoord`; `kv` refuses instead. Pin:
    `crates/omni-coord/tests/faults.rs`. `ARCHITECTURE.md#clustering`.
12. `omni-ratelimit/src/limits.rs` owns the limit JSON schema; `Dimension`/`Window` in `lib.rs`.
    Limiter state lives in `omni-gateway-core/src/ratelimit.rs` (single) and `omni-cluster-limit`
    (fleet).
13. **No provider logic in core crates** — aim, not achieved. Known provider literals outside
    `omni-providers`: `omni-router/src/providers.rs` (`Providers::builtin` registry, nine ids),
    `resolve.rs` (`custom` excluded from prefix routing); `omni-control`
    `model_schema.rs`/`models.rs` (`custom` ⇔ `endpointId`), `diagnostics.rs` (served set),
    `quota_runtime.rs`/`api.rs` (quota providers); `omni-gateway` `dispatch.rs` (`send_provider` +
    served-set guard), `price.rs` (Anthropic cache-write multipliers), `connect.rs`/`refresh.rs`
    (OAuth providers); `omni-store/src/bodies.rs` (vendor key prefixes in masking — on purpose,
    never extensible). Core keeps provider-shaped **vocabulary**: `ErrorCode`, `StopReason`, log
    fields, `AuthType`, `WindowType`.
14. Plugins are not supported in 1.x. `<root>/plugins/` entries are warned once and never run;
    `/api/plugins*` answers 501, `/plugin-assets/<id>/*` 404; `omni plugin *` exits 1. Pins:
    `crates/omni-gateway/tests/drop_warnings.rs`, `server.rs` test `plugin_routes_are_unsupported`.
15. `Principal` (`omni-gateway/src/admin_auth.rs`): `Admin`, `Viewer`, `Client{api_key_id}` share
    one cookie; a stored `machine` session reads as none. Guards per route, never grouped:
    `require_admin`, `require_reader`, `require_client` (`api.rs`). Mutations, snapshot download,
    `/api/connect/*`, request bodies stay admin-only. Pins: `api.rs` test
    `guards_admit_exactly_their_principals`, `admin_routes.rs` `routes_match_elysia_s_table`.

## Adding a provider

Codec in `crates/omni-providers/src/<id>/` (`codec.rs`, `wire.rs`, `decode.rs`, `profile.rs`,
`oauth.rs` as needed) on the `codec.rs` contract; register it in `omni-gateway/src/dispatch.rs`
`send_provider` **and** the served-set guard beside `"no adapter for provider"`; catalog rows in
`crates/omni-control/data/provider-catalog.json` plus `Providers::builtin` in
`omni-router/src/providers.rs`; served set in `omni-control/src/diagnostics.rs`; OAuth in
`omni-gateway/src/connect.rs`/`refresh.rs`; a `crates/omni-router/tests/<id>_catalog.rs`. Mirror the
id rule: `rustMirrors.test.ts` checks every catalog key.

## TypeScript and dashboard style

- Rust: workspace lints forbid `unsafe`, deny `unwrap_used` outside tests; clippy `-D warnings`.
- Strict TypeScript; `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` stay enabled.
- Never commit `any`, tests included. Use `unknown` plus narrowing or named types.
- ESM imports with explicit `.ts` extensions. Match nearby naming + comment density.
- Biome: 2-space indent, 100-column lines. Avoid unrelated refactors.
- Dashboard use styled-components, never Tailwind or CSS files.
- Palette CSS variables in `theme/GlobalStyle.ts`; `theme/tokens.ts` reference them.
- Colour mean provider identity or state only. Prefix transient props with `$`.
- Self-host fonts through `@fontsource`; never add third-party origins.

## Testing

- Prefer behaviour tests at narrowest stable boundary. Synthetic credentials, local fake upstreams;
  never call live providers.
- Dispatch or codec changes cover streaming + non-streaming paths; preserve pre-commit failover vs
  post-commit in-stream errors (`crates/omni-gateway/tests/dispatch.rs`).
- Shared proxy changes test Anthropic + OpenAI + Responses error surfaces
  (`server.rs` `auth_failures_answer_in_the_dialect_and_file_a_row`).
- Auth changes cover Bearer and `x-api-key`, conflicting input, revoked keys, allowlists, limits.
- Deadline tests distinguish gateway timeout from client cancellation.
- Store behaviour on both backends goes in `crates/omni-store/tests/contract.rs`; PG/Redis tests
  must fail, not skip, under `OMNI_TEST_REQUIRE_*`.
- Console tests run under happy-dom. Use `test/helpers/fetchStub.ts`, `renderWithProviders`,
  `renderWithRouter`; assert visible text, roles, accessible names. Re-query after async loads.
- **Check gated on `merge-base(main, HEAD)` fail on `pull_request`, vacuous on `push`.**
  `actions/checkout` never create `refs/heads/main`; base resolve through `main` or `origin/main`,
  fall back to **first parent** when HEAD is base. One copy in `scripts/lib/history.ts`, tested in
  `scripts/test/history.test.ts`.

## Security and privacy

- Never log prompt/response bodies, OAuth tokens, API keys, passwords, encryption keys, or arbitrary
  headers/metadata.
- Log fields are a closed allowlist: `FIELD_ORDER` in `omni-gateway/src/logging.rs`; any other field
  never reaches the line. New free-text fields are security changes. Pin: `logging.rs` test
  `fields_outside_the_allowlist_never_reach_the_line`.
- `GatewayError::gateway_authored` (`omni-ir/src/error.rs`) defaults false. `reason_shown` in
  `dispatch.rs` withholds a message only when the error names a provider, unless debug is on or the
  flag is set. Set it only for repository-authored text. Unpinned at `reason_shown`.
- Return raw gateway API keys once; store only hashes (`omni-crypto/src/apikey.rs`).
- Encrypt provider credentials with required `OMNI_ENCRYPTION_KEY` (`omni-crypto/src/field.rs`);
  never add default secrets or commit `.env` files/databases.
- Client errors omit provider tokens, credential IDs, internal stacks.
- Preserve admin sessions on every `/api/*` route except setup/status/login flows and the two
  password routes, which end sessions **by design**.
- Two passwords, neither default. `PUT /api/settings/password` requires current password; wrong
  current is `AUTH "current password is incorrect"` — same code and status as a failed login,
  different message (`invalid password`), so it says nothing a stolen cookie can use. Success clears
  every session including caller's; console redirects to `/login?reason=password-changed`.
  `PUT /api/settings/viewer-password`: string sets, `null` deletes, absent `BAD_REQUEST`; clears
  viewer sessions only. Pins: `admin_auth.rs` tests
  `changing_the_admin_password_ends_every_session`, `viewer_password_*`. `MIN_PASSWORD_LENGTH` = 12
  in `omni-control/src/admin_password.rs`, mirrored in `features/settings/policy.ts`, held by
  `rustMirrors.test.ts`.

## Client contracts

Client surface:

- `POST /v1/messages`: Anthropic-compatible request, response, SSE, errors
- `POST /v1/chat/completions`: OpenAI-compatible request, response, SSE, errors
- `POST /v1/responses`: Responses-compatible. **Stateless**: `previous_response_id`,
  `item_reference`, explicit `store: true` refused (`omni-dialects/src/ingress/responses.rs`);
  `background` accepted and ignored. Keepalive ≤4 s (`RESPONSES_KEEPALIVE` in `server.rs`).
- `GET /v1/models`: authenticated, filtered by key allowlist, smallest target window per model
  (`resolve_model_limits`, `omni-router/src/model_limits.rs`). Limits advertised, not enforced
- `POST /v1/messages/count_tokens`: authenticated local estimate, charged to `requests` only, no
  dispatch or usage row. Pin: `crates/omni-gateway-core/tests/ratelimit.rs`
  `count_tokens_consumes_requests_and_never_tokens_spend_or_a_slot`
- `GET /health`: unauthenticated liveness; `GET /metrics` only with `OMNI_METRICS_TOKEN`

`/api/client/*` (`client_routes.rs`) is key holder's own read surface: `login`, `logout`, `summary`,
`usage`, `logs`, `quota`, `quota/history`. Scope comes from the verified session, never a query
parameter (`apiKeyId=ignored` in the pin). Client session re-reads the key on **every** verify
(`AdminAuth::verify`). Pins: `admin_auth.rs` test
`client_sessions_end_when_the_key_stops_being_usable`; `server.rs` test
`cluster_listener_uses_postgres_without_opening_a_sqlite_shadow` (no `credentialId` on client logs).

`summary` carries `dayOffsetMinutes` as an additive top-level field. Absent differs from zero (UTC).
Only install-level fact; justify any other. Pin asserts `0` only — a nonzero pin is missing.

Client quota (`omni-control/src/client_quota.rs`) names accounts; `usedRatio`/`ratePerHourRatio` are
`0..1`; `stale` and `rolledOver` kept separate; no aggregate gateway rate on history. History caps
at `MAX_SAMPLES` (50_000), queries `cap + 1`, reports `truncated`; operator history (`quota_ops.rs`)
narrows to one account before the cap. Key sets held by `rustMirrors.test.ts`.

Every `/v1/*` request accepts Bearer or `x-api-key`; two that disagree are `AUTH "conflicting API
key headers"`, two that agree pass (`api_key_header`, `omni-gateway-core/src/snapshot.rs`). `null`
allowlist unrestricted; empty array denies all.

Translation invariants:

- Keep mid-conversation system messages in place; never fold into request-level `system`.
- Forward `thinking` forms exactly. Never derive budgets from effort. Drop unsigned thinking before
  Anthropic replay; preserve + accumulate signatures (`collect` pin:
  `crates/omni-ir/tests/stream_collect.rs`).
- OpenAI chat egress renders canonical thinking as `reasoning_content`
  (`omni-dialects/src/egress/openai.rs`).
- Carry `anthropic-beta` as header and body passthrough, deduplicated; never synthesize a missing
  one (`anthropic/codec.rs`). Unpinned.
- **Structured output arrives in three spellings, leaves in four.** Ingress writes the bag of its
  own surface (`vendor.openai.response_format`, `vendor.openai.text.format`,
  `vendor.anthropic.output_config.format`). `read_response_format` in
  `omni-providers/src/response_format.rs` is the **one** parse; "refused" (`TooDeep`) and "never
  asked" are distinct. Outbound: `text.format` (`move_to_responses_text`), `output_config.format`,
  `generationConfig.responseSchema`, `response_format`. Every encoder deletes foreign spellings from
  its bag. Anthropic's schema is closed (`additionalProperties: false`) at every depth after the
  merge (`anthropic/vendor.rs`); tool `input_schema` never closed. Depth cap 64 subschema levels. A
  refusal is noted `<provider>:response-schema-too-deep`. Pins: `response_format.rs` tests
  (`the_depth_cap_sits_at_sixty_four_subschema_levels`),
  `crates/omni-providers/tests/outbound_depth.rs`. The 3×9 ingress×target matrix is
  unpinned. Design: [structured
  output](docs/superpowers/specs/2026-09-21-response-format-cross-provider-design.md).
- Anthropic versioned tool `type` carried exactly; known versions listed in
  `omni-dialects/src/ingress/anthropic_tools.rs`; unknown dated types rejected.
- Provider-native blocks (`ProviderNative` in `omni-ir/src/request.rs`) carry payload verbatim and
  their producing `provider`; routing admits only that provider's targets, excluded as
  `capability:providerNative`. Pins: `crates/omni-router/tests/filters.rs` (`required_providers_*`,
  `a_request_naming_anthropic_*`).
- A cache breakpoint on the final mid-conversation system turn is retargeted to the last cacheable
  history block or dropped (`anthropic:system-turn-cache-control-retargeted` / `-dropped`,
  `anthropic/wire.rs`). Unpinned.
- `pause_turn` own stop reason; never fold into end-turn or tool-use (`omni-ir/src/stream.rs`).
- Tool-result images/files: `ToolResultBlock.images` / `.files`, never serialised into text. Text
  files decoded inline (`tool-result-files-inlined`), binaries only through the wire's own carrier
  (`tool-result-files-moved`), else `files-dropped`; Responses carrier is a measured allowlist
  (`omni-providers/src/tool_result_files.rs`). Pins: that file's tests; encoder notes unpinned.
- Client tool names renamed on the Anthropic **OAuth** leg only (`anthropic/cloak.rs`), restored in
  `anthropic/decode.rs` via `uncloak` — never at egress (a restore at egress would hide the
  rename from anything that classifies tool names). The cloak is built per request in the codec
  (`ToolCloak::build`), never stored on shared dispatch state. Exempt names (already PascalCase,
  `mcp__*`) claim their spelling. Fingerprint refusals map to `FINGERPRINT_REFUSED`. Pin:
  `crates/omni-providers/tests/anthropic_codec.rs`.
- Unknown Anthropic SSE events and content-block types fail visibly (`unrecognized Anthropic …`,
  `anthropic/decode.rs`), never skipped. Unpinned.
- Preserve cache-control block, TTL, order. One exception: `autoCacheEnabled` (default on) adds
  breakpoints in `anthropic/wire.rs` when the request carries none
  (`anthropic:cache-breakpoint-added`, `anthropic:history-cache-breakpoint-added`): only when the
  cached-input estimate is 0 and the vendor bag has no `cache_control`; last tool, last system
  block, then last eligible wire-history block (text/image/tool_use/tool_result/document), each only
  where the prefix grew ≥1024 tokens since the last marker; mutates wire, never IR. Unpinned in
  Rust. Design:
  [auto-cache](docs/superpowers/specs/2026-08-23-anthropic-auto-cache-full-prefix-design.md).
- **RTK and ponytail do not run.** `rtkEnabled` and `ponytailMode` are stored and editable but
  dispatch and `count_tokens` send the request as received (`dispatch.rs`, `server.rs` comments).
  `request_logs.rtk_filters` stays a storage contract (`RTK_FILTER_IDS`, `omni-rtk/src/catalog.rs`;
  read-side allowlist in `omni-store/src/maintenance.rs` `rtk_filters`): add ids freely, rename only
  with a migration.
- `Usage.input_tokens` is uncached input; cache reads and 5m/1h writes priced once (`price.rs`).
  `prompt_tokens()` (`omni-ir/src/stream.rs`) when a surface needs total prompt tokens.
- OpenAI-chat upstreams need `stream_options.include_usage` (`custom/wire.rs`); Responses usage
  arrives on `response.completed` (`openai/decode.rs`).
- Normalize `[1m]` before key allowlist checks (`omni-dialects/src/ingress/mod.rs`); `claude/` is
  not reserved or rewritten. Pin: `crates/omni-gateway/tests/key_identity.rs`.
- Gateway does not validate request-shape support per model; unsupported combos are upstream errors.
- `ChatRequest.conversation_id`: Anthropic `metadata.user_id`, else `read_conversation_header`
  (`omni-dialects/src/ingress/mod.rs`): `x-session-id`, `x-session-affinity`,
  `x-deepseek-harness-session-id`, `session-id`, case-insensitively. Never OpenAI `user`. The
  Responses cache key (`openai/wire.rs`) is client `prompt_cache_key` → `session_id` → hashed
  `conversation_id` → hash of instructions + first input item (not tools); a supplied UUID passes
  through, else a keyed UUIDv7 thread id. Unpinned beyond the fingerprint literals. The OpenAI OAuth
  leg wears Codex 0.170.0's fingerprint (`openai/profile.rs`, `wire.rs`, `identity.rs`), moved only
  with a capture (`scripts/codex-capture/README.md`); sends one id as `session-id`, `thread-id`,
  `x-client-request-id` — only `session-id` routes the Codex cache (measured), keep all three in
  `profile.rs`'s order; the body is built with `store: false`. Native reasoning reads the
  **client's** `include`, never the body's (`openai/mod.rs`). Ids keyed by the credential's
  `providerData.idSalt` (`openai/oauth.rs`). Pin:
  `crates/omni-providers/tests/openai_fingerprint_literals.rs`. Design: [Codex
  fingerprint](docs/superpowers/specs/2026-10-16-codex-0163-fingerprint-design.md).
- OpenAI chat ingress reads images from `messages[].images` (Ollama; non-image there refused) and
  `attachments`/`experimental_attachments` (non-image dropped); the payload's own magic bytes beat
  a declared type; remote URLs never fetched (`omni-dialects/src/ingress/openai.rs`).

Detailed compatibility rules + measured client behaviour belong in `docs/superpowers/specs/`.

## Runtime and data traps

- `OMNI_BASE_URL` must be the public origin (decides `Secure` cookies, OAuth callbacks). Changing
  `OMNI_ENCRYPTION_KEY` invalidates stored credentials.
- The gateway reads **no** `.env`: config is process env only (`omni-gateway-core/src/lib.rs`). Pin:
  `crates/omni-gateway-core/tests/config.rs`. The CLI merges the root's `.env` explicitly and passes
  it to the gateway it spawns.
- CLI root (`omni-cli/src/context.rs` `resolve`): `--root` > `OMNI_ROOT` > cwd holding `.env` or
  `omnigateway.db` > `~/.config/omnigateway`. Database: `--db` > root `.env` > ambient
  `OMNI_DB_PATH` > `omnigateway.db`. `--root` without `--db` drops ambient `OMNI_DB_PATH`, warns on
  stderr, and doctor reports it. Unpinned.
- All nine catalog providers are dispatched: `anthropic`, `openai`, `antigravity`, `custom`,
  `kimi`, `kilo`, `grok`, `muse`, `qoder`. A target naming anything else reaches
  `INTERNAL "no adapter for provider …"` at attempt time. Qoder's catalog is dynamic
  (`providerData.modelCatalog`); its router catalog stays empty.
- `1m` and `concurrency` are process-local on a single node; `5h`/`1w` are seeded from the store and
  survive restart. In Rust the single-node gauge has **no TTL** (freed on `Drop`).
- A success writes health only when `success_would_change` (`omni-router/src/breaker.rs`) says the
  snapshot row differs from blank; checked before the attempt in `dispatch.rs`. Missing row =
  healthy. Pin: `quota_breaker_resolve.rs`
  `success_would_change_is_exactly_whether_record_success_changes_the_row`. Postgres trigger `WHEN`
  (`migrations/postgres/002_health_measurements.sql`) is a strict subset.
- Migrations under `crates/omni-store/migrations/{sqlite,postgres}/` are frozen bytes: installed
  databases record ids. Never edit one; add the next. Pins:
  `crates/omni-store/tests/{migrate,pg_migrate}.rs`.
- The writer (`omni-store/src/writer/`) is the one writer of `request_logs`; completion is applied
  at most once per id, rollups folded in the same transaction. Pins:
  `crates/omni-store/tests/writer.rs`, `pg_writer.rs`. Pending rows hold placeholder metrics;
  inspect `state`, not `status`.
- `usage_rollup` derived from `request_logs`; `rebuild_rollup` (`omni-store/src/rollup.rs`)
  reproduces it; doctor audits (`diagnostics::audit_rollup`). Day offset is fixed per install
  (`OMNI_DAY_OFFSET_MINUTES`); thread it through both stores. Pin: `contract.rs`
  `the_configured_day_offset_cuts_the_daily_bucket`.
- `quota_windows` hold provider observations. Missing data = unknown, never unlimited. Probe failure
  never disables a credential. Pins: `omni-control/src/quota_runtime.rs` tests.
- Rollover suppresses inference only: `burn` drops `ratePerHour`, `exhaustsAt`, `survives` but keeps
  measured `windowStartsAt`; staleness is checked before rollover (`omni-cli/src/quota.rs`,
  `omni-control/src/credentials.rs`, `client_quota.rs`). Pin: `quota.rs`
  `rollover_keeps_window_start_but_suppresses_inference`. Console projection (`projectedPace`,
  `lib/vitals.ts`) stops at the ceiling, the same instant as `exhaustsAt`; `usedPercent` capped at
  100. Pin: `test/lib/vitals.test.ts` `stops at the ceiling rather than projecting past it`.
- Limit names (`api_keys.limits` JSON keys) are a storage contract failing **closed**: unknown name
  is a parse failure (`omni-ratelimit/src/limits.rs`). Pin: `crates/omni-store/tests/limits.rs`.
- Refuse at auth, degrade at list. Unparseable `limits` refuse the key as
  `INTERNAL "api key configuration is unusable"` (`snapshot.rs`), never `AUTH`; the key list still
  returns the row. Pin: `crates/omni-gateway-core/tests/snapshot.rs`
  `a_revoked_key_and_unreadable_limits_are_refused_*`.
- Admission claims the `1m` window and gauge **before any await** and rolls back on refusal.
  Per-model overrides (`LimitConfig::model_override`) claim key-wide **and** model subject in one
  admission, roll back both. Pins: `crates/omni-gateway-core/tests/ratelimit.rs`
  (`a_burst_against_a_1m_ceiling_*`, `a_refusal_by_either_scope_rolls_back_the_other`),
  `crates/omni-cluster-limit/tests/cluster.rs`.
- Five fields editable after minting, each written whole (`omni-control/src/body_schema.rs`):
  `limits` (`{}` removes the last limit), `models` (`null` and `[]` are opposite facts), `expiry`
  (`null` = never; past instant allowed — "expire now", reversible where revoke is not; never add a
  `> now` guard), `guardrail` (`null` = none, empty after trim refused), `smart-routing`
  (`{enabled}`). Strict schemas: an absent field is refused, never defaulted. `bodyLoggingOptOut`
  deliberately not editable. Routes:
  `PUT /api/keys/:id/{limits,models,expiry,guardrail,smart-routing}`.
- **Guardrail fails closed**: only a bare `ALLOW` from a finished reply (`endTurn`/`stopSequence`)
  admits (`parse_verdict`, `omni-gateway/src/screening.rs`). Judged after admission, inside the
  event sequence (`screen_first`); classifier dispatched with `request_transforms: false`. Pins:
  `crates/omni-gateway/tests/guardrail.rs`, `server.rs` `a_policy_key_with_no_guardrail_model_*`.
- Smart routing never falls back external; fails closed. Pins:
  `crates/omni-gateway/tests/smart_routing.rs`, `screening_dispatch.rs`.
- Long windows over-count, never under-count. Single node: buckets seeded through the writer
  (`ratelimit_seed.rs`); debits follow the committed row (`LogObserver`), never inside the store.
  Seed reads count `state = 'done'` rows only (`omni-store/src/usage.rs`, `pg/usage.rs`). A failed
  seed serves the request and retries, degrading long windows only (pin:
  `a_failing_seed_read_serves_the_request_and_is_asked_again`). Seeding does not block (deliberate,
  documented in `ratelimit.rs`).
- Cluster gauge slots are named per admission (random uuid, never `requestId`) and renewed under a
  one-day cap (`GAUGE_TTL_MS`, `MAX_RENEWED_MS`, `omni-cluster-limit/src/lib.rs`). Probe slots
  expire at 180 s and are not renewed (`Probes::claim`, `omni-gateway/src/load.rs`). Pins:
  `crates/omni-coord/tests/contract.rs` (`a_named_gauge_slot_renews_*`,
  `a_blank_holder_is_refused`), `crates/omni-cluster-limit/tests/cluster.rs`
  `a_long_request_keeps_its_slot_by_renewal`.
- `limitUsage` counts committed rows only; `concurrency.used` is `null`, not `0`
  (`omni-control/src/api.rs`).
- `Target.credential_id` is a hard filter: no spill from a disabled, breakered, rate-limited or
  spent account; `pin:missing` once per target only when no account resolves. Nothing validates pin
  existence at write time; doctor reports dangling pins. Pins: `filters.rs` `a_pin_*`.
- Pinned limits (`resolve_model_limits`, `omni-router/src/model_limits.rs`): a resolved pin uses
  that account's auth only; an unresolved pin falls back to the provider-wide auth set, never bare
  catalog API figures; `ServingCredentials::new` counts enabled credentials only (`put_model`'s auth
  check counts every one). Pin: `one_request_pass_then_two_auths_or_one_pin_per_target`. Console
  draft (`features/models/draft.ts`) clears the pin on provider (`retargetDraft`) or endpoint
  (`reEndpointDraft`) change, keeps it on model change; API/CLI preserve it. Pin:
  `test/features/models.test.tsx`.
- Breaker probe: router marks open-past-cooldown and `halfOpen` as `probe`; dispatch claims
  `probe:<healthKey>`; a lost claim (`breaker:probing`) consumes no attempt; success closes the
  breaker **at commit**. Pin (router half): `filters.rs` `admits_an_open_breaker_*_as_a_probe`.
  Dispatch half unpinned.
- `provider:missing` once per target, first guard (`filters.rs`). Pin:
  `a_target_naming_a_provider_that_is_not_installed_is_excluded_once`.
- Format and existence are two questions. Credential creation checks the id grammar **and**
  `catalog::descriptor` (`omni-control/src/credentials.rs` `parse_create`); target writes check
  grammar only (`model_schema.rs`). `custom` target requires `endpointId`, nothing else may carry
  one. Grammar mirrored by `SAFE_PROVIDER_ID` (`theme/tokens.ts`) at all three Rust sites, held by
  `rustMirrors.test.ts`.
- `ProviderModelChoice.auth` enforced at write time (`omni-control/src/models.rs`), never at
  routing. Unpinned.
- `CONNECT_ATTEMPT_TIMEOUT` (3 s, `omni-providers/src/http/mod.rs`) stays above one TCP retransmit.
  Pin: `http_client.rs` `connect_attempt_timeout_is_longer_than_one_tcp_retransmit`.
- Streams carry `: keepalive` every 10 s (`KEEPALIVE`, `omni-gateway/src/lib.rs`), 4 s on Responses.
  Pin: `server.rs` `an_idle_stream_carries_keepalive_comments`. `requestDeadlineMs` default 0 =
  unlimited. Connection idle budget `IDLE_TIMEOUT` 255 s; inference routes are exempt
  (`omni-gateway/src/http.rs`). Pins: `http.rs` tests, `server.rs`
  `a_silent_upstream_stream_with_keepalives_outlives_the_idle_timeout`.
- Socket registry closes connections with `1001` on restart; `4401` means "do not reconnect", for
  expired session alone (`stream_transport.rs`). Pin:
  `expired_session_upgrade_and_next_shared_heartbeat`. Heartbeat re-verifies every 20 s.
- `/health` stays plain polling, never on the socket.
- **Emitter count matches writer count**: the writer's `LogObserver::committed`
  (`stream_transport.rs` `Hub`) emits `res:logs` per row event and `res:usage` per finish; admin
  mutations emit their resource (`admin_routes.rs` `frozen_resource_publisher_routes`). Topic covers
  every query-key branch reading it (console `["usage",…]` and client `["client","usage",…]`);
  clients may hold only `res:usage`/`res:logs` (`stream.rs` `authorised`).
  `ARCHITECTURE.md#push-transport`.
- Telemetry is process-local: `/metrics` reads neither store nor coord; provider HTTP gains no trace
  header (`otlp.rs` `TraceHttp`). Unpinned. Design:
  [observability](docs/superpowers/specs/2026-09-04-observability-design.md).
- Stdout holds operational events; `request_logs` hold completed requests; `requestId` joins both.
  Console reads only captured stdout: `OMNI_LOG_FILE`, journald, or none
  (`omni-gateway/src/console.rs`).
- Docker `scratch` runtime: binary + console, non-root `bun` user, `HEALTHCHECK` via
  `omni health --env-only`. npm ships one native binary per platform plus `public/`. Kustomize base
  in `k8s/`; `secret.yaml` gitignored.
- Snapshot is the database alone (`VACUUM INTO`); `request_bodies/` excluded and reconciled by the
  orphan sweep. Downloads `no-store`.
- Bodies: writer emits `OGBA` raw (`seal`, `omni-store/src/pg/bodies.rs`); readers accept raw, gzip
  and legacy `enc:v1:` hex; `MAX_ENVELOPE_BYTES` caps before read. Pin: `pg/bodies.rs`
  `a_sealed_envelope_opens_and_a_flipped_byte_does_not`, `crates/omni-store/tests/pg_cross_read.rs`.
- Lifecycle and swap: `ARCHITECTURE.md#replacing-the-database-while-it-is-open` and
  `#stopping-and-restarting`. Read before changing any.
- Restart asks systemd, never self-signals; `--no-block` required (`omni-gateway/src/lifecycle.rs`).
  Pin: `supervision_and_stubbed_commands`.
- Quiesce latch gates `/v1/*` only; `/api/*` and `/health` stay live through a swap
  (`quiesce.rs`, `server.rs`).
- Swap (`omni-control/src/database.rs` restore/import, `omni-gateway/src/database_swap.rs`): close
  every registered owner (`omni-store/src/lifecycle.rs`), unlink stale `-wal`/`-shm`, rename,
  reopen; compare password hashes; `rebuild_rollup` last and guarded — **nothing between swap and
  that comparison**. Pin: `database.rs` tests `swap_exact_sequence_*`,
  `failures_preserve_frozen_half_swap_*`.
- `vacuum` checkpoints (`VACUUM; PRAGMA wal_checkpoint(TRUNCATE)`). Unpinned.
- Log filters (`omni-store/src/logs.rs`, `pg/logs.rs`): typed text (`model`, `requestedModel`,
  `resolvedModel`, `errorCode`) is case-insensitive escaped substring (`LIKE`/`ILIKE … ESCAPE '\'`);
  ids, especially scoped `apiKeyId`, use `=`. Unpinned in Rust.
- `omni db restore` refuses while the gateway runs, no override (`omni-cli/src/database.rs`).
  Unpinned.
- Literal `../` never reaches a route: `normalize_path` (`static_files.rs`) resolves dot segments
  first; `canonicalize` decides containment. Pin: `crates/omni-gateway/tests/static_paths.rs`.

## Subagent workflow

- Orchestrator create implementation subagent, then separate review subagent. Subagents not spawn
  nested subagents.
- Use `feat/*` branches for subagent implementation work; no worktrees.

## graphify

When gitignored `graphify-out/graph.json` exists, query it first for codebase questions; use
`path`/`explain` for focused relationships and the wiki/report only for broad navigation. If absent,
run `/graphify .` or read source directly. After code edits run `graphify update .`.
