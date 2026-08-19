# OmniGateway Repository Guidance

Agent guidance for repository work: architecture, boundaries, conventions, and durable traps.
`README.md` serves operators; `ARCHITECTURE.md` explains how the system fits together; this file
serves contributors. Update all that a change affects.

## Scope

OmniGateway is a Bun/TypeScript monorepo for a self-hosted AI gateway:

- `apps/gateway`: Elysia gateway and long-lived process loops
- `apps/dashboard`: admin console served by gateway
- `apps/cli`: local `omni` CLI
- `packages/control`: admin operations shared by gateway routes and CLI
- `packages/ir`: provider-neutral domain model
- `packages/providers`: provider adapters and catalog
- `packages/router`: pure routing
- `packages/ratelimit`: pure API-key limit evaluation and sliding-window counting
- `packages/rtk`: tool-result filters, applied in dispatch before routing
- `packages/store`: persistence and encryption
- `packages/testkit`: shared test fixtures

Approved designs live in `docs/superpowers/specs/`; matching implementation plans live in
`docs/superpowers/plans/`. Read relevant spec before changes, but verify current code because plans
record past intent.

## Commands

Use Bun from repository root:

```bash
bun install
bun run dev              # gateway with file watching
bun run start
bun test                 # excludes dashboard tests
bun run test:all         # both suites; what CI runs
bun run typecheck        # core and dashboard
bun run lint
bun run fmt
```

Dashboard:

```bash
bun run dev:dashboard              # Vite on 5173, proxies /api and /oauth to 9000
bun run build:dashboard            # writes apps/dashboard/dist
bun run --cwd apps/dashboard test  # happy-dom suite excluded from root tests
```

CLI and release:

```bash
bun apps/cli/src/index.ts --help
cd apps/cli && bun link
omni doctor --root <install>
bun run build:npm v1.2.3
```

Pushing a `v*` tag runs `.github/workflows/release.yml`; tag is sole version source. Before claiming
completion, run focused changed-behavior tests, full `bun test`, dashboard suite, `bun run typecheck`,
and `bun run lint`.

## Architectural boundaries

1. `packages/ir` stays provider-independent and side-effect-free. Inject clocks and logger sinks;
   never import `process`, `console`, or transport.
2. Provider wire formats, headers, signing, stream decoding, and model catalogs stay in
   `packages/providers`.
3. `packages/router` stays pure: no network, database, token refresh, or timers.
4. Dispatch owns side effects, retries, refresh, deadlines, failover, and stream commit semantics.
5. Gateway routes authenticate, parse, apply key policy, call dispatch or `@omni/control`, render
   compatible responses, and record metadata. Admin rules belong in `packages/control`, not handlers.
6. `packages/control` knows nothing about caller type: no Elysia, cookies, argv, terminal, or timers.
   Long-lived schedulers stay in `apps/gateway`.
7. Store rows and secrets stay behind `@omni/store`; never expose encrypted or raw provider secrets.
8. All outbound provider HTTP uses `HttpClient`; no direct production `fetch`.
9. `@omni/providers/catalog` is browser-imported and must remain a leaf: model lists plus types only.
10. Catalog pricing provides defaults. Router prices from saved targets; catalog edits affect new
    targets only.
11. CLI administers local installations through `@omni/control`, never `/api/*`. Inject every side
    effect so tests never start processes or write outside temp directories.
12. Dashboard calls `/api/*` only, with one exception: `/health`, polled to watch the gateway leave
    and return across a restart. During a restart there is no session and no authenticated surface
    to probe, so liveness is the one question `/api/*` cannot answer. It may import
    `@omni/store/types`, `@omni/ir`, and catalog subpath, but not provider adapters, HTTP client, or
    runtime store code.
13. `packages/rtk` stays pure like `ir` and `router`: no I/O, clocks, or randomness. It rewrites
    tool-result content only and preserves errors and non-tool-result blocks. `@omni/rtk/catalog` is
    a leaf holding the filter-id union; `@omni/store` imports that subpath alone.
14. `packages/ratelimit` stays pure the same way; `now` is always a parameter and the counters are
    supplied by the caller, so the package never learns where they came from. `@omni/ratelimit/catalog`
    is a leaf holding the dimension and window unions, `LimitConfig`, and its zod schema;
    `@omni/store` imports that subpath alone and re-exports `LimitConfig` from `@omni/store/types`,
    which is the import the dashboard is already permitted. Limiter state — rings and gauges — lives
    in `apps/gateway`, because state is not the package's job.

## Adding a provider

The nine-step procedure lives in [docs/adding-a-provider.md](docs/adding-a-provider.md): what the
compiler will enumerate for you, what it cannot find, the per-provider files, and why `wire.ts` and
`decode.ts` are forked rather than shared. Read it before adding one — several steps exist because
skipping them produced a bug that read as something else entirely.

## TypeScript and dashboard style

- Strict TypeScript; `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` stay enabled.
- Never commit `any`, including tests. Use `unknown` plus narrowing or named types.
- Use ESM imports with explicit `.ts` extensions. Match nearby naming and comment density.
- Biome uses 2-space indentation and 100-column lines. Avoid unrelated refactors.
- Dashboard uses styled-components, never Tailwind or CSS files.
- Palette CSS variables live in `theme/GlobalStyle.ts`; `theme/tokens.ts` references them.
- Colour means provider identity or state only. Prefix transient props with `$`.
- Self-host fonts through `@fontsource`; never add third-party origins.

## Testing

- Prefer behavior tests at narrowest stable boundary.
- Use in-memory stores, synthetic credentials, and stub `HttpClient`; never call live providers.
- Dispatch or adapter changes cover streaming and non-streaming paths.
- Preserve pre-commit failover versus post-commit stream behavior.
- Shared proxy changes test Anthropic and OpenAI error surfaces.
- Auth changes cover Bearer and `x-api-key`, malformed/conflicting input, revoked keys, allowlists,
  and relevant rate limits.
- Deadline tests distinguish gateway timeout from client cancellation and leave no timers/listeners.
- Dashboard tests run under happy-dom. Use `test/helpers/fetchStub.ts`, `renderWithProviders`, and
  `renderWithRouter`; assert visible text, roles, and accessible names. Re-query after async loads.

## Security and privacy

- Never log prompt/response bodies, OAuth tokens, API keys, passwords, encryption keys, or arbitrary
  headers/metadata.
- `LogFields` is a closed allowlist and redaction boundary. Treat new free-text fields as security
  changes; never add an index signature.
- Return raw gateway API keys once and store only hashes.
- Encrypt provider credentials with required `OMNI_ENCRYPTION_KEY`; never add default secrets or
  commit `.env` files/databases.
- Client errors omit provider tokens, credential IDs, and internal stacks.
- Preserve admin sessions on every `/api/*` route except documented setup/status/login flows.

## Client contracts

Client surface:

- `POST /v1/messages`: Anthropic-compatible request, response, SSE, and errors
- `POST /v1/chat/completions`: OpenAI-compatible request, response, SSE, and errors
- `GET /v1/models`: authenticated and filtered by key model allowlist
- `POST /v1/messages/count_tokens`: authenticated local estimate; no dispatch or usage row
- `GET /health`: unauthenticated liveness

Every `/v1/*` request accepts Bearer or `x-api-key`; reject conflicts. `null` model allowlist means
unrestricted; empty array denies all models.

Preserve these translation invariants:

- Keep mid-conversation system messages in place; never fold them into request-level `system`.
- Forward `thinking` forms exactly. Never derive budgets from effort. Drop unsigned thinking before
  Anthropic replay; preserve and accumulate Anthropic signatures.
- Carry `anthropic-beta` as both header and body passthrough. Never synthesize a missing beta.
- `ToolDef` is a union. `CustomToolDef` stays portable; `AnthropicToolDef` carries an exact
  versioned `type` that is never normalized or upgraded. Versions live in
  `packages/providers/src/anthropic/tools.ts`; unknown dated types are rejected, not prefix-matched.
- Anthropic-native content blocks use the `anthropicNative` IR variant, keep their payload verbatim,
  and stay out of tool-id correlation, orphan removal, cross-provider translation, and RTK.
- An `AnthropicToolDef` or `anthropicNative` history block excludes every provider whose
  `ANTHROPIC_NATIVE_TOOLS` entry is false at routing — currently everything except Anthropic.
- `pauseTurn` is its own stop reason; never fold it into `endTurn` or `toolUse`.
- Unknown Anthropic block types and SSE events fail visibly rather than being skipped.
- Preserve cache-control breakpoint block, TTL, and order when target can express them. Record
  degradations for requested features a provider cannot express.
- `Usage.inputTokens` is uncached input. Cache reads and 5m/1h writes are disjoint classes priced
  once. Use `promptTokens()` when a client surface needs total prompt tokens.
- Adapters stream upstream. OpenAI chat usage requires `stream_options.include_usage`; Responses API
  reports usage on `response.completed`.
- `/v1/models` reports smallest target window in a pool. Limits are advertised, not enforced.
- Normalize `claude/<id>` aliases and `[1m]` before key allowlist checks. `claude/` remains reserved.
- Gateway does not validate request-shape support per model; unsupported combinations surface as
  upstream errors.
- The OpenAI surface reads images from `messages[].images` (bare base64) and from `attachments` /
  `experimental_attachments` as well as from `content`. Neither sidecar is an OpenAI field; they are
  read because the clients that send them send no other copy. The payload's own container header
  beats any declared type, and a remote URL is never fetched.
- The two sidecars differ on what an unusable payload means, and the split is the contract.
  `images` is Ollama's images-only field, so anything in it that is not image data is a
  `BAD_REQUEST`. `attachments` is the SDK's general file envelope, where a PDF or a hosted URL is
  ordinary: those are dropped, never refused, because they were dropped before the gateway read the
  field and refusing now would break a caller that worked yesterday. Same reasoning as
  `looseCacheControl`.

Detailed compatibility rules and measured client behavior belong in relevant specs under
`docs/superpowers/specs/`.

## Runtime and data traps

- `OMNI_EXPOSE_CLAUDE_CODE_ALIASES` defaults off and is read at boot. `OMNI_BASE_URL` must be public
  reverse-proxy origin. Changing `OMNI_ENCRYPTION_KEY` invalidates stored credentials.
- CLI root resolution: `--root` > `OMNI_ROOT` > installation in cwd >
  `~/.config/omnigateway`. Root `.env` intentionally overrides ambient environment.
- CLI database path: `--db` > that root's own `.env` > ambient `OMNI_DB_PATH` > `omnigateway.db` in
  the root. A `--root` flag suppresses ambient `OMNI_DB_PATH` entirely — Bun preloads the cwd's
  `.env`, so otherwise the flag picks the root and an unrelated checkout picks its database. The
  suppression is warned on stderr, reported by `doctor`, and removed from the env a spawned gateway
  inherits. `OMNI_ROOT` does not suppress it: both are ambient.
- Quota cooldowns are process-local and reset on restart. So are `1m` and `concurrency`; `5h` and
  `1w` come from the database and survive one.
- `usage.append` must run at most once per request ID; duplicate completion double-counts
  `usage_daily` and `usage_rollup` alike. Pending rows contain placeholder metrics; inspect `state`,
  not `status`.
- `usage_rollup` is derived, never authoritative: `request_logs` is the source of truth and
  `rebuildRollup` reproduces every bucket from it. Written in `append`'s transaction, pruned with the
  rows it summarizes, rebuilt after a restore, compared by `omni doctor`. It replaced a `SELECT SUM`
  whose cost grew without bound — and `bun:sqlite` is synchronous, so that scan blocked the whole
  event loop, not one request. For the same reason a timeout around a store read cannot fire; do not
  add one back.
- `quota_windows` stores provider observations, not gateway counts. Missing data means unknown, not
  unlimited. Probe failure must never disable a credential.
- RTK filter ids are persisted in `request_logs.rtk_filters`, so `RTK_FILTER_IDS` is a storage
  contract, not an internal enum. `isRtkFilterId` drops unknown ids on read, so renaming one loses
  history silently rather than failing. Add ids freely; rename or remove only with a migration.
- Rate limiting is explained in `ARCHITECTURE.md#rate-limiting`; these are the invariants a change
  must not break, and each has already been broken once.
- `DIMENSIONS` and `WINDOWS` in `@omni/ratelimit/catalog` are the JSON keys of `api_keys.limits`, so
  a storage contract like RTK ids — but failing **closed**: an unknown name is a parse failure, never
  a silent drop. Rename or remove only with a migration.
- `admit`/`consume` claim the ring stamp and gauge **synchronously**, before any `await`, and roll
  back on refusal. Reading counters first and recording after lets concurrent requests judge one
  pre-burst snapshot — a ceiling of 3 admitted 10 parallel requests, and it needs no I/O to fire.
- Refuse at auth, degrade at list. An unparseable `limits` reads back as `null`, distinct from `{}`,
  and `authenticateApiKey` turns it into `INTERNAL` — not `AUTH`, which would blame a credential that
  is fine. `keys.list()` must never throw over such a row: `toKey` serves the listing too, and the
  listing is how an operator finds the row to fix. Nothing may collapse that `null` into `{}`.
- `limits` is the only field editable after minting (`setKeyLimits`, `PUT /api/keys/:id/limits`);
  `bodyLoggingOptOut` deliberately is not — an opt-out is a promise to whoever holds the key, a limit
  is the operator's own ceiling. The matrix is written whole: `{}` is how the last limit goes away,
  never a husk like `{"requests":{}}`.
- Windows *slide*. `1m` is an exact ring in `apps/gateway`; longer windows are `usage.sumSince` —
  which must filter `state = 'done'` — plus an in-memory delta, cached 30s. The composition may
  over-count and must **never** under-count, so the delta keeps everything at or after the read
  instant; the other direction is walkable by timing the refresh. A failed `sumSince` serves the
  request and logs through existing `LogFields` keys, degrading long windows only, because `1m` and
  `concurrency` never touch the store.
- The token and spend debit lives in `finishLog` beside `usage.append`, never inside `@omni/store`:
  that site already runs at most once per request id, which is the guarantee the debit needs.
- The concurrency gauge is released at request scope and nowhere else. A streaming handler returns
  while the request still runs, so a `finally` around the handler body fires at head-send, and a
  decrement beside the debit sits behind a store write; streams free it from `sseResponse`'s
  run-once completion. No window expires a gauge — a leak locks the key out until restart, silently.
- `ApiKeySummary.limitUsage` counts committed rows only: a floor on what the limiter sees, never its
  number. `concurrency.used` is `null`, not `0`, because the gauge is not stored.
- `ProviderModelChoice.auth` is enforced at write time in `putModel`, never at routing. Which ways
  in exist is installation state, so the catalog exports the fact (`catalogModelAuths`) and control
  owns the rule. A provider with no credential is unknown rather than blocked, an unlisted model is
  unknown rather than forbidden, disabled credentials still count, and a target already stored under
  that id is exempt so removing a credential cannot make an unrelated edit unsavable.
- Streaming responses need downstream `: keepalive` comments because provider heartbeats are
  decoded away. Keep server idle timeout above request deadline.
- Stdout holds operational events; `request_logs` holds completed requests. Do not restore duplicate
  per-request access lines. `requestId` joins both.
- Console can read only captured stdout: `OMNI_LOG_FILE`, journald, or none. `OMNI_LOG_FILE` names an
  existing capture; it does not create one.
- Docker image contains gateway only; npm package contains CLI, gateway, and dashboard.
- OpenAI OAuth routes to narrower Codex surface. OAuth-specific encoding stays behind existing
  `oauth` flag.
- A snapshot is the database alone. `request_bodies/` is excluded, so a downloaded snapshot is never
  a prompt corpus and its size never tracks prompt volume. After a restore, body rows and artifact
  files disagree until `sweepOrphans` reconciles them; that is expected, not a bug.
- A snapshot still carries encrypted credentials and API-key hashes. Downloads are `no-store`, and
  the file is inert only because `OMNI_ENCRYPTION_KEY` is not in it.
- The lifecycle and swap rules below are explained in `ARCHITECTURE.md#replacing-the-database-while-it-is-open`
  and `#stopping-and-restarting`. Each one looks arbitrary alone and is not; read the section before
  changing any of them.
- Restart asks systemd, never self-SIGTERM (which stops the gateway for good), and `--no-block` is
  required.
- The quiesce latch gates `/v1/*` only; `/api/*` and `/health` stay live through a swap.
- `store.close()` is idempotent and `reopen()` tolerates a closed handle, so restore is close → swap
  → reopen. Repo methods forward per call: bind one to a local and it dies at the next swap.
- `vacuum()` must checkpoint, or page count falls while the file keeps every page.
- Restore compares the admin password hash across the swap and invalidates sessions only when it
  differs. **Nothing may sit between the swap and that comparison** — the swap has already succeeded,
  so anything throwing in front of it skips the invalidation while the new password is live.
- `swapIn` rebuilds `usage_rollup` last and guarded, for that reason. It blocks the loop; the cost is
  measured in `README.md` and must stay documented rather than hidden.
- `omni db restore` refuses while a gateway is running and has no override.

## Subagent workflow

- Orchestrator creates implementation subagent, then separate review subagent. Subagents do not spawn
  nested subagents.
- Use `feat/*` branches for subagent implementation work; do not use worktrees.

## graphify

This project can carry a knowledge graph at `graphify-out/` with god nodes, community structure, and
cross-file relationships. `graphify-out/` is gitignored, so a fresh clone has none: if
`graphify-out/graph.json` is absent, run `/graphify .` to build one, or skip the graph and read
source directly. Every rule below is conditional on that file existing.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- AST extraction does not follow barrel re-exports: an import of `GatewayError` from `@omni/ir`
  targets `packages_ir_src_index_gatewayerror`, but the symbol is defined in `errors.ts`, so the
  edge dangles and is dropped at build. That silently zeroes the inbound degree of the types the
  whole architecture turns on — `GatewayError`, `ChatRequest`, `Store`, `ProviderId`, `StreamEvent`,
  `Logger`, `HttpClient` — so god-node rankings under-weight `packages/ir` and `packages/store`
  until the endpoints are remapped to their defining module. Every `graphify update .` brings it
  back.
