# OmniGateway

OmniGateway is a self-hosted, single-node AI gateway that presents Anthropic- and OpenAI-compatible APIs over OAuth-backed Anthropic, OpenAI, and Kimi Coding accounts. It normalizes incoming requests into a provider-neutral representation, routes virtual models across eligible credentials, handles failover and token refresh, and records operational usage without logging prompt or response bodies.

> Current status: core gateway is implemented. Admin dashboard is planned separately and is not included yet.

## Features

- Anthropic-compatible `POST /v1/messages`
- OpenAI-compatible `POST /v1/chat/completions`
- Authenticated `GET /v1/models`
- Virtual-model routing, aliases, credential priority, failover, and cooldowns
- OAuth connection flows for Anthropic, OpenAI, and Kimi Coding
- Encrypted credential storage in SQLite
- Per-key model allowlists and process-local rate limits
- Streaming SSE translation between client and provider formats
- Admin control API for setup, login, credentials, models, keys, settings, health, usage, and logs
- Provider-specific client identity profiles and ordered outbound headers

## Requirements

- [Bun](https://bun.sh/) 1.4 or later
- A persistent filesystem location for SQLite
- A private encryption key used to encrypt stored provider credentials

## Quick start

```bash
bun install
cp .env.example .env
openssl rand -base64 32
```

Put generated value in `.env`:

```dotenv
OMNI_ENCRYPTION_KEY=<generated-value>
```

Changing this key later makes existing stored credentials unreadable.

Start development server with file watching:

```bash
bun run dev
```

Or run normally:

```bash
bun run start
```

Default listener is `http://127.0.0.1:8787`. Check liveness:

```bash
curl http://127.0.0.1:8787/health
```

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OMNI_ENCRYPTION_KEY` | Yes | — | Encrypts provider credentials at rest; minimum 16 characters |
| `OMNI_HOST` | No | `127.0.0.1` | Listener host |
| `OMNI_PORT` | No | `8787` | Listener port |
| `OMNI_DB_PATH` | No | `./omnigateway.db` | SQLite database path |
| `OMNI_BASE_URL` | No | Derived from host and port | Public origin used for OAuth callbacks; set behind reverse proxy |

`.env.example` documents optional provider client-identity version, header, and wire-order overrides. Those values have built-in defaults and are read at process startup.

## First-run setup

Dashboard is not implemented yet, so use `/api/*` control endpoints directly.

1. Check setup state with `GET /api/status`.
2. Configure admin password with `POST /api/setup`.
3. Create a session with `POST /api/login`; retain returned HTTP-only cookie.
4. Connect provider credentials through `/api/connect/:provider/*`.
5. Configure virtual models through `/api/models`.
6. Create gateway API keys through `/api/keys`. Raw key is returned once.

Admin routes use session-cookie authentication. Client routes use either:

```http
Authorization: Bearer <gateway-key>
```

or:

```http
x-api-key: <gateway-key>
```

## Client API

| Method | Path | Compatibility |
| --- | --- | --- |
| `POST` | `/v1/messages` | Anthropic Messages API |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions API |
| `GET` | `/v1/models` | OpenAI-style model listing filtered by key allowlist |
| `GET` | `/health` | Unauthenticated liveness |

Example:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <gateway-key>' \
  -d '{
    "model": "fast",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Workspace

```text
apps/gateway/       Elysia HTTP application, auth, ingress, routing, dispatch, APIs
packages/ir/        Provider-neutral request, stream, error, and usage types
packages/providers/ Provider adapters, OAuth logic, wire formats, HTTP transport
packages/store/     Store contracts, encryption, SQLite repositories and migrations
docs/superpowers/   Approved design specifications and implementation plans
```

Dependency direction matters:

- `@omni/ir` does not depend on provider or gateway code.
- `@omni/providers` translates between provider wire formats and canonical IR.
- Router chooses candidates; dispatch owns side effects, retries, refresh, and streaming commit.
- Gateway composes packages and exposes client and control APIs.

## Development

```bash
bun test             # full test suite
bun run typecheck    # TypeScript project references
bun run lint         # Biome checks
bun run fmt          # format files
```

Run one test file:

```bash
bun test apps/gateway/test/routes/proxy.test.ts
```

Project uses strict TypeScript with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Committed code and tests must not use `any`.

## Docker

```bash
docker build -t omnigateway .
docker run --rm \
  -p 8787:8787 \
  -e OMNI_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -v omnigateway-data:/data \
  omnigateway
```

Container listens on `0.0.0.0:8787` and stores SQLite data at `/data/omnigateway.db`.

## Operational notes

- Treat `OMNI_ENCRYPTION_KEY`, gateway keys, OAuth tokens, and SQLite data as secrets.
- Request logs contain metadata and usage, never prompt or response bodies.
- API-key rate limits are process-local. They reset on restart and are not shared across multiple gateway instances.
- Version 1 targets a trusted, single-operator deployment. Multi-tenancy, distributed coordination, semantic caching, billing, and horizontal scaling are out of scope.
- Set `OMNI_BASE_URL` to public HTTPS origin when running behind a reverse proxy so OAuth callbacks match provider registrations.

## Design documents

- `docs/superpowers/specs/2026-07-31-omnigateway-design.md`
- `docs/superpowers/specs/2026-07-31-client-identity-profiles-design.md`
- `docs/superpowers/plans/2026-07-31-omnigateway-core.md`
- `docs/superpowers/plans/2026-07-31-omnigateway-dashboard.md`
