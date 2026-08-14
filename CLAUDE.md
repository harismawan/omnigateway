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
12. Dashboard calls `/api/*` only. It may import `@omni/store/types`, `@omni/ir`, and catalog subpath,
    but not provider adapters, HTTP client, or runtime store code.
13. `packages/rtk` stays pure like `ir` and `router`: no I/O, clocks, or randomness. It rewrites
    tool-result content only and preserves errors and non-tool-result blocks. `@omni/rtk/catalog` is
    a leaf holding the filter-id union; `@omni/store` imports that subpath alone.

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
- An `AnthropicToolDef` or `anthropicNative` history block excludes OpenAI and Kimi at routing.
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

Detailed compatibility rules and measured client behavior belong in relevant specs under
`docs/superpowers/specs/`.

## Runtime and data traps

- `OMNI_EXPOSE_CLAUDE_CODE_ALIASES` defaults off and is read at boot. `OMNI_BASE_URL` must be public
  reverse-proxy origin. Changing `OMNI_ENCRYPTION_KEY` invalidates stored credentials.
- CLI root resolution: `--root` > `OMNI_ROOT` > installation in cwd >
  `~/.config/omnigateway`. Root `.env` intentionally overrides ambient environment.
- API-key rate limits and quota cooldowns are process-local and reset on restart.
- `usage.append` must run at most once per request ID; duplicate completion double-counts
  `usage_daily`. Pending rows contain placeholder metrics; inspect `state`, not `status`.
- `quota_windows` stores provider observations, not gateway counts. Missing data means unknown, not
  unlimited. Probe failure must never disable a credential.
- RTK filter ids are persisted in `request_logs.rtk_filters`, so `RTK_FILTER_IDS` is a storage
  contract, not an internal enum. `isRtkFilterId` drops unknown ids on read, so renaming one loses
  history silently rather than failing. Add ids freely; rename or remove only with a migration.
- Streaming responses need downstream `: keepalive` comments because provider heartbeats are
  decoded away. Keep server idle timeout above request deadline.
- Stdout holds operational events; `request_logs` holds completed requests. Do not restore duplicate
  per-request access lines. `requestId` joins both.
- Console can read only captured stdout: `OMNI_LOG_FILE`, journald, or none. `OMNI_LOG_FILE` names an
  existing capture; it does not create one.
- Docker image contains gateway only; npm package contains CLI, gateway, and dashboard.
- OpenAI OAuth routes to narrower Codex surface. OAuth-specific encoding stays behind existing
  `oauth` flag.

## Subagent workflow

- Orchestrator creates implementation subagent, then separate review subagent. Subagents do not spawn
  nested subagents.
- Use `feat/*` branches for subagent implementation work; do not use worktrees.
