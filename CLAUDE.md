# OmniGateway Repository Guidance

## Scope

OmniGateway is a Bun/TypeScript monorepo for a self-hosted AI gateway. Core gateway is implemented under `apps/gateway`; dashboard remains planned work. Treat approved documents under `docs/superpowers/specs/` and `docs/superpowers/plans/` as product requirements, but verify current code before assuming plan snippets still match implementation.

## Commands

Use Bun from repository root:

```bash
bun install
bun run dev
bun run start
bun test
bun run typecheck
bun run lint
bun run fmt
```

Run focused tests with `bun test <path>`. Before claiming completion, run tests covering changed behavior plus full `bun test`, `bun run typecheck`, and `bun run lint`.

## Repository map

- `apps/gateway/src/app.ts`: dependency-injected Elysia application composition
- `apps/gateway/src/index.ts`: production bootstrap, config, SQLite, maintenance, server lifecycle
- `apps/gateway/src/ingress/`: Anthropic/OpenAI request parsing into canonical IR
- `apps/gateway/src/router/`: pure candidate selection and routing state
- `apps/gateway/src/dispatch/`: upstream attempts, refresh, failover, deadlines, stream commit
- `apps/gateway/src/routes/`: client, admin, and OAuth control surfaces
- `apps/gateway/src/auth/`: admin sessions and gateway API-key authentication
- `packages/ir/`: provider-neutral domain types and error mapping
- `packages/providers/`: provider adapters, OAuth, HTTP client, wire rendering/parsing
- `packages/store/`: store interfaces, encryption, SQLite repositories, migrations
- `apps/gateway/test/`: gateway unit, route, integration, and end-to-end tests

## Architectural boundaries

Preserve these constraints:

1. `packages/ir` stays provider-independent and side-effect-free.
2. Provider-specific wire formats, headers, signing, and stream decoding stay in `packages/providers`.
3. Router stays pure: no network, database, token refresh, or timers.
4. Dispatch owns side effects, retries, refresh, request deadlines, and streaming commit semantics.
5. Gateway routes authenticate, parse, apply key policy, call dispatch, render client-compatible responses, and record metadata.
6. Store rows and secrets remain behind `@omni/store`; never expose encrypted or raw provider secrets through control APIs.
7. All outbound provider HTTP goes through the `HttpClient` seam. Do not add direct production `fetch` calls.

## TypeScript and style

- Strict TypeScript is required.
- `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are enabled.
- Never commit `any`, including tests. Use `unknown` and narrow it, or define a named type.
- Use ESM imports with explicit `.ts` extensions, matching surrounding code.
- Match existing naming, comment density, and formatting.
- Biome uses 2-space indentation and 100-column lines.
- Avoid unrelated refactors while changing behavior.

## Testing conventions

- Prefer behavior tests at narrowest stable boundary.
- Use in-memory stores and stub `HttpClient`; tests must not call live providers.
- Use synthetic tokens and credentials only.
- Cover both non-streaming and streaming paths when changing dispatch or adapters.
- Preserve pre-commit failover versus post-commit stream behavior.
- Test both Anthropic and OpenAI error surfaces when changing shared proxy behavior.
- Authentication changes must cover Bearer and `x-api-key`, malformed input, conflicts, revoked keys, allowlists, and rate limits where relevant.
- Deadline tests must distinguish gateway timeout from downstream client cancellation and must not leave timers/listeners active.

## Security and privacy

- Never log prompt bodies, response bodies, OAuth tokens, API keys, admin passwords, or encryption keys.
- Raw gateway API keys are returned once at creation and stored only as hashes.
- Provider credentials are encrypted at rest with `OMNI_ENCRYPTION_KEY`.
- Do not introduce default encryption secrets or commit `.env` files/databases.
- Keep client-facing errors free of provider tokens, credential IDs, and internal stack traces.
- Preserve admin session checks on every `/api/*` route except documented setup/status/login flows.

## API contracts

Client surface:

- `POST /v1/messages`: Anthropic-compatible request, response, SSE, and error shape
- `POST /v1/chat/completions`: OpenAI-compatible request, response, SSE, and error shape
- `GET /v1/models`: authenticated and filtered by calling key model allowlist
- `GET /health`: unauthenticated liveness

Every `/v1/*` request accepts `Authorization: Bearer <key>` or `x-api-key: <key>`. Conflicting credentials must be rejected. A `null` model allowlist means unrestricted; an empty array denies all models.

Control surface uses `/api/*`, never `/admin/*`. Dashboard code must call `/api/*` and must not assume WebSocket log streaming; current design polls logs.

## Configuration

`OMNI_ENCRYPTION_KEY` is mandatory and changing it invalidates existing encrypted credentials. `OMNI_BASE_URL` must be public origin behind reverse proxy. Provider identity environment overrides are startup configuration; validate and keep built-in defaults when absent or invalid.

## Subagent workflow

- For subagent-driven work, orchestrator creates implementation subagent, then separately creates review subagent; subagents must not spawn nested subagents.
- Use `feat/*` branches for subagent implementation work; do not use worktrees.

## Known constraints

- Version 1 is single-node and single-operator.
- API-key rate limits are process-local, reset on restart, and are not shared across instances.
- Dashboard is not implemented yet; follow dashboard plan rather than inventing a competing control API.
- Biome currently emits an informational deprecation notice for `linter.recommended`; do not treat that notice as a task-specific failure unless changing Biome config.
