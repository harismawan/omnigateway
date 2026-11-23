# OmniGateway

One endpoint in front of the AI accounts you already pay for.

OmniGateway is a self-hosted gateway that speaks the Anthropic and OpenAI APIs
and answers them using your own Anthropic, OpenAI (including Codex), Google
Antigravity, Kimi, Kilo, Grok, Muse and Qoder subscriptions, plus any
OpenAI-compatible endpoint you add. Point any compatible client at it, ask for a model you defined,
and the gateway picks an account that can serve it — falling back to another
when one is rate-limited, expired, or out of quota.

It runs as one process on a local SQLite file by default, scales out onto
Postgres and Redis when you need a fleet, and never logs the contents of your
prompts or replies.

```bash
curl -fsSL https://raw.githubusercontent.com/harismawan/omnigateway/main/install.sh | sh
```

> Status: in use and complete for its scope — see [Scope](#scope-and-limits).

## What it does

- **Speaks three dialects.** Anthropic Messages, OpenAI Chat Completions and OpenAI Responses
  (the only API Codex CLI speaks), streaming included, translated to whichever provider serves it.
- **Filters bulky tool history, optionally.** Built-in RTK filters shorten eligible large or repetitive
  shell and command output before dispatch, preserve errors and non-tool-result content, and default off.
- **Routes across your accounts.** Define a virtual model like `fast` or `smart` with several
  targets; the gateway ranks them by tier, health, remaining quota, cost, latency, and current load.
- **Fails over.** A rate-limited or broken account is skipped, its circuit breaker opens, and the
  next candidate is tried — before the response starts streaming.
- **Keeps OAuth alive.** Tokens refresh in the background, before a request needs them.
- **Watches provider quota.** It asks each provider what you have left and routes by *pace*:
  5% remaining is fine minutes before a reset and urgent with six days to run.
- **Issues its own keys.** Per-key model allowlists instead of shared provider credentials,
  bounded by requests, tokens, dollars, or requests in flight — per minute, per five hours, per week.
- **Reports usage.** Requests, tokens, and cost by provider, model, key, and day — metadata only.
- **Backs itself up.** Snapshot the database from the console or the CLI, see what it occupies,
  reclaim what deletion left behind, and restore without stopping the gateway.
- **Ships an admin console and a CLI.** Both cover the same ground; use whichever suits the machine.

## Install

On a Linux or macOS machine, one command installs the release binary (no Node needed), writes a
new `.env`, migrates the database, sets an admin password, installs a service and waits for `/health`:

```bash
curl -fsSL https://raw.githubusercontent.com/harismawan/omnigateway/main/install.sh | sh
```

Alternatively `npm i -g omnigateway` (Node 18 or later): one package carries the CLI, the server,
and the console. Linux or macOS on x64/arm64 only — there is no Windows build. Flags, npm details,
release archives, upgrades and manual setup: [docs/install.md](docs/install.md).

## Quick start

```bash
omni connect anthropic     # or: openai, antigravity, kimi, kilo, grok, muse, qoder
omni models put fast --from-catalog anthropic:claude-sonnet-5   # pricing seeded from the catalog
omni keys create --label laptop    # the key is printed once and stored only as a hash
```

```bash
curl http://127.0.0.1:9000/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <gateway-key>' \
  -d '{"model": "fast", "messages": [{"role": "user", "content": "Hello"}]}'
```

Everything above is also available in the browser at `http://127.0.0.1:9000`, which walks the same steps.

- Hold a plain API key rather than a subscription: `omni credentials add-key <provider>` — [docs/install.md](docs/install.md#manual-setup).
- Any other OpenAI-compatible origin: the `custom` provider — [docs/install.md](docs/install.md#manual-setup).
- Bound a key with [limits](docs/operations.md#key-limits), per-model overrides included.
- Give a key an [expiry](docs/operations.md#key-expiry) — reversible, unlike revoke.
- Judge a key's requests against a plain-language [usage policy](docs/operations.md#usage-policies).
- Send a key's confidential requests to a local model with [confidential routing](docs/operations.md#confidential-routing).

## Using it from a client

| Method | Path | Compatible with |
| --- | --- | --- |
| `POST` | `/v1/messages` | Anthropic Messages API |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions API |
| `POST` | `/v1/responses` | OpenAI Responses API (stateless: no stored responses, no `previous_response_id`) |
| `POST` | `/v1/messages/count_tokens` | Anthropic-compatible local token estimation (authenticated) |
| `GET` | `/v1/models` | Listing in both dialects, filtered by your key's allowlist |
| `GET` | `/health` | Unauthenticated liveness check |

Authenticate with either header — sending both is an error:

```http
Authorization: Bearer <gateway-key>
x-api-key: <gateway-key>
```

Ask for a virtual model by name; a bare provider model also works if an account can serve it.
Rate-limit headers, the listing shape, and how tools pin routing: [docs/client-api.md](docs/client-api.md).

## The CLI

`omni --help` lists everything; `omni <command> --help` explains one. Every command takes `--json`.

| | |
| --- | --- |
| `omni status` | the gateway, its accounts, and their quota, on one screen |
| `omni start` / `stop` / `restart` | run the gateway; `--foreground` attaches it to your terminal |
| `omni connect <provider>` | authorize an account from the terminal |
| `omni models …` | list, show, put, `rm`, `dry-run`, `catalog` |
| `omni keys …` | list, create, `limits`, revoke |
| `omni logs` | recent requests as the gateway recorded them |
| `omni usage` | spend and tokens, by provider, model, key, or day |
| `omni doctor` | which installation it resolved, and whether it can act on it |

The full table, and `--root` / `--db` behaviour: [docs/cli.md](docs/cli.md).

## Configuration

Configuration is environment variables, read from the installation's `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMNI_ENCRYPTION_KEY` | required | Encrypts provider credentials at rest; 16 characters minimum |
| `OMNI_HOST` | `127.0.0.1` | Listener host |
| `OMNI_PORT` | `9000` | Listener port |
| `OMNI_BASE_URL` | derived from host and port | Public origin for OAuth callbacks; set behind a reverse proxy |
| `OMNI_DB_PATH` | `./omnigateway.db` | SQLite database path |

**Keep `OMNI_ENCRYPTION_KEY`. Changing it makes every stored credential unreadable.** Everything else is
runtime settings, edited with `omni settings set` or in the console. Full table: [docs/configuration.md](docs/configuration.md).

## Deploying

`omni service install --enable` writes a systemd unit. Behind a reverse proxy, set `OMNI_BASE_URL`
and pass WebSocket upgrades and unbuffered SSE through. Several replicas behind a load balancer
are **cluster mode** on Postgres and Redis. Docker:

```bash
docker build -t omnigateway .
docker run --rm \
  -p 9000:9000 \
  -e OMNI_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -v omnigateway-data:/data \
  omnigateway
```

The nginx block, the Kubernetes base and GitOps releases: [docs/deploying.md](docs/deploying.md).

## Scope and limits

- **One process on SQLite by default; a fleet is opt-in.** Without cluster mode, `1m` and `concurrency`
  are process-local and reset on restart; `5h` and `1w` survive. Two gateways over one SQLite file are not a cluster.
- **One operator, with two narrower views.** An optional read-only console password and a per-key
  client dashboard; no multi-tenancy — every provider account is the operator's.
- **Two grains of usage history.** Request logs prune after 30 days, a daily rollup keeps 400;
  a day uses a fixed UTC offset (the host's at boot — fleets set it explicitly).
- **Body capture is forensics, not an archive.** Off unless both keys turn it on, expires on the
  log window, capped at 100,000 rows; `omni bodies` reads one request, nothing searches across them.
- **Snapshots are manual and local.** Nothing takes one on a schedule and there is no off-host
  target; retention bounds them and a restore takes one first. On Postgres, `pg_dump` is the backup.
- **Quota readings come from the providers**, whose usage endpoints are undocumented; nothing reported is unknown, never unlimited.
- **The gateway does not know which model accepts which request shape.** Unsupported combinations surface as the provider's own 400.
- **Provider-specific behaviour** — thinking controls, Claude Code auto mode, the Codex-shaped
  OpenAI OAuth leg, GPT-6.2 tiers, xAI/Kilo pricing: [docs/providers.md](docs/providers.md).
- Not in scope: semantic caching, billing.

What is missing on purpose, for now, or designed but not built: [docs/roadmap.md](docs/roadmap.md).

## Security

- Treat `OMNI_ENCRYPTION_KEY`, gateway keys, and the SQLite file as secrets. Anyone with the file
  *and* the key has your provider credentials.
- Prompts and responses are never logged; request logs hold metadata and token counts only, and no body
  reaches stdout, the journal, or the Console screen. [Body capture](docs/operations.md#recording-bodies) is opt-in behind two keys, encrypts what it writes, and can be refused per key.
- Gateway keys are stored as hashes. A lost key is reissued, not recovered.
- A [snapshot](docs/operations.md#snapshots-and-restore) carries encrypted credentials and key
  hashes — inert only because `OMNI_ENCRYPTION_KEY` is not in it. Captured bodies are excluded.
- Secrets are never accepted on the command line — `omni` prompts or reads stdin — so they stay
  out of shell history and the process table.
- Behind a reverse proxy, set `OMNI_BASE_URL` to the public HTTPS origin so OAuth callbacks match.
- The gateway talks to your providers and to nobody else — except your collector, if you name one
  with `OMNI_OTLP_ENDPOINT`. No CDN fonts or undeclared third-party origins.
- No plugins are loaded in 1.x: a `plugins/` directory is reported and never run.

## Documentation

- [docs/install.md](docs/install.md) — the install script, npm, release archives, upgrades, manual setup
- [docs/cli.md](docs/cli.md) — every `omni` command, `--json`, `--root` and `--db`
- [docs/configuration.md](docs/configuration.md) — the full environment table and runtime settings
- [docs/client-api.md](docs/client-api.md) — endpoints, authentication, rate-limit headers, tool routing
- [docs/operations.md](docs/operations.md) — key limits, expiry, policies, logs, bodies, snapshots, restore
- [docs/deploying.md](docs/deploying.md) — systemd, reverse proxies, cluster mode, Docker and Kubernetes
- [docs/providers.md](docs/providers.md) — provider- and model-specific behaviour
- [docs/qoder.md](docs/qoder.md) — Qoder setup and limitations
- [docs/rust-quota-runtime.md](docs/rust-quota-runtime.md) — Rust single-node quota support and limits
- [docs/rust-cli-service.md](docs/rust-cli-service.md) — local service commands and their limits
- [docs/rust-cluster-bucket-sweep.md](docs/rust-cluster-bucket-sweep.md) — the bucket sweep after a Postgres lineage replacement or restore
- [docs/rust-packaging.md](docs/rust-packaging.md) — release archives, launch policy, image promotion
- [docs/roadmap.md](docs/roadmap.md) — what is missing on purpose, for now, or designed but not built
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it is built: crate map, a request end to end, routing, storage
- [CONTRIBUTING.md](CONTRIBUTING.md) — running from a checkout and the check commands