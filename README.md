# OmniGateway

One endpoint in front of the AI accounts you already pay for.

OmniGateway is a self-hosted gateway that speaks the Anthropic and OpenAI APIs
and answers them using your own Anthropic, OpenAI, Kimi Coding, Kilo, and xAI
subscriptions. Point any compatible client at it, ask for a model you defined,
and the gateway picks an account that can serve it — falling back to another
when one is rate-limited, expired, or out of quota.

It runs as one process on a local SQLite file by default, scales out onto
Postgres and Redis when you need a fleet, and never logs the contents of your
prompts or replies.

```bash
bun install -g omnigateway
omni start
```

> Status: in use and complete for its scope — see [Scope](#scope-and-limits).

**Further reading**, once the gateway is up:

- [docs/client-api.md](docs/client-api.md) — endpoints, authentication, rate-limit headers, and how tools decide where a request can go
- [docs/operations.md](docs/operations.md) — key limits, logs, recording bodies, snapshots and restore
- [docs/deploying.md](docs/deploying.md) — systemd, reverse proxies, cluster mode, Docker and Kubernetes
- [docs/plugins.md](docs/plugins.md) — installing, verifying and removing plugins
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it is built

## What it does

- **Speaks three dialects.** `POST /v1/messages` (Anthropic),
  `POST /v1/chat/completions` (OpenAI) and `POST /v1/responses` (OpenAI
  Responses, which is the only API Codex CLI speaks), including streaming,
  translated to whichever provider actually serves the request.
- **Filters bulky tool history, optionally.** Built-in RTK filters shorten
  eligible large or repetitive shell and recognizable command output before
  provider dispatch, preserve errors and non-tool-result content, and default off.
- **Enforces a coding style, optionally.** With `ponytailMode` set, the gateway
  appends the [ponytail](https://github.com/DietrichGebert/ponytail) ruleset —
  build the smallest thing that works — to the system prompt of every request,
  so any client gets it without installing anything. About 1,240 tokens, cached
  with the prompt it joins; skipped when the client already carries it.
  Defaults off.
- **Routes across your accounts.** Define a virtual model like `fast` or
  `smart` with several targets; the gateway ranks them by tier, health,
  remaining quota, cost, latency, and current load.
- **Fails over.** A rate-limited or broken account is skipped, its circuit
  breaker opens, and the next candidate is tried — before the response starts
  streaming.
- **Keeps OAuth alive.** Tokens refresh in the background, before a request
  needs them.
- **Watches provider quota.** It asks each provider what you have left and
  routes by *pace*: 5% remaining is fine minutes before a reset and urgent with
  six days to run.
- **Issues its own keys.** Hand out gateway keys with per-key model allowlists
  instead of sharing provider credentials, and bound each one by requests,
  tokens, dollars, or requests in flight — per minute, per five hours, and per
  week.
- **Reports usage.** Requests, tokens, and cost by provider, model, key, and
  day — metadata only.
- **Backs itself up.** Snapshot the database from the console or the CLI, see
  what it occupies, reclaim what deletion left behind, and restore a snapshot
  without stopping the gateway.
- **Ships an admin console and a CLI.** Both cover the same ground; use
  whichever suits the machine you are on.

## How it is built

A Bun workspace monorepo: a provider-neutral core at the bottom, provider
knowledge in one place, pure routing above that, and every side effect pushed up
into the gateway process. The gateway and the CLI are two front ends over the
same `@omni/control` functions — the CLI opens the SQLite file directly, so it
works when the gateway is down.

**[ARCHITECTURE.md](ARCHITECTURE.md)** has the package map and layering rules,
then goes a level deeper: a request traced end to end, how routing ranks and
excludes accounts, the commit point that decides whether failover is still
possible, the provider adapter shape, the database schema and its encryption
boundary, and the background loops.

## Requirements

- [Bun](https://bun.sh/) 1.4 or later. Bun is the runtime, not just the
  installer, so a Node-only machine cannot run OmniGateway.
- A directory that persists, for the SQLite database.
- At least one Anthropic, OpenAI, Kimi Coding, Kilo, or xAI account to connect.

## Install

```bash
bun install -g omnigateway     # or: npm i -g omnigateway
```

One package carries the `omni` CLI, the gateway server, and the admin console
the server hosts.

## Getting started

Pick a directory to hold the database and configuration. `~/.config/omnigateway`
is where `omni` looks by default:

```bash
mkdir -p ~/.config/omnigateway && cd ~/.config/omnigateway
printf 'OMNI_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" > .env
```

That key encrypts your provider credentials at rest. **Keep it. Changing it
makes every stored credential unreadable**, and there is no recovery path
except reconnecting the accounts.

Then set up and start:

```bash
omni db migrate            # create the database
omni admin set-password    # prompts; the console signs in with this
omni start                 # serves the API and the console on 127.0.0.1:9000
```

Connect an account. The CLI prints a URL to open, and waits:

```bash
omni connect anthropic     # or: openai, kimi, kilo, grok
```

An installed [plugin](#plugins) that supplies its own provider is connected the
same way, under its plugin id.

Every provider also takes a plain API key, if that is what you hold rather than
a subscription:

```bash
omni credentials add-key anthropic     # prompts for the key, or reads stdin
```

There is a sixth provider, `custom`, which points an existing wire codec at an
origin you supply — an endpoint you host or pay for that is not one of the five.
It has no subscription to authorize, so there is no `omni connect custom`; it is
an API key plus the endpoint to spend it against:

```bash
omni credentials add-key custom \
  --endpoint-id my-endpoint --endpoint-label 'My endpoint' \
  --origin https://api.example.com --protocol chat-completions
```

`--protocol` is `chat-completions` or `responses`, naming which codec to reuse.
`--origin` is a bare origin — scheme and host, no path, query, or credentials in
the URL.

The console offers the same choice per provider on the Connect dialog.

Define a virtual model your clients will ask for, seeding its pricing and
capabilities from the built-in catalog:

```bash
omni models catalog                                  # what is available
omni models put fast --from-catalog anthropic:claude-sonnet-5
```

Two providers price in ways a flat per-target rate cannot express — xAI above
200K context and Kilo's `kilo-auto/*` routers; the caveats are in
[docs/adding-a-provider.md](docs/adding-a-provider.md).

Mint a key for your client. **It is printed once and stored only as a hash:**

```bash
omni keys create --label laptop
```

Bound what the key can do with `--limit <dimension>:<window>=<value>`, repeated
once per pair — `omni keys create --label ci --limit requests:1m=60`. An unset
pair is unlimited. Windows slide, `tokens` and `spend` are debited on
completion, and limits are editable afterwards with `omni keys limits`; the
semantics are in [docs/operations.md](docs/operations.md#key-limits).

Now use it:

```bash
curl http://127.0.0.1:9000/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <gateway-key>' \
  -d '{"model": "fast", "messages": [{"role": "user", "content": "Hello"}]}'
```

Everything above is also available in the browser at
`http://127.0.0.1:9000`, which walks the same steps.

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

Ask for one of your virtual models by name. A bare provider model
(`claude-sonnet-5`, `gpt-5`) also works if an account can serve it. Most tools
that accept a custom base URL work unchanged: set it to `http://127.0.0.1:9000`
and use a gateway key where the provider key goes.

Rate-limit headers, the `/v1/models` listing shape, and why an Anthropic-defined
tool pins a request to an Anthropic account are in
[docs/client-api.md](docs/client-api.md).

## The CLI

`omni --help` lists everything; `omni <command> --help` explains one. Every
command takes `--json` for scripting, and `--root <path>` to manage an
installation other than the default.

`--root` names the installation, so an `OMNI_DB_PATH` exported in your shell is
ignored alongside it and said so on stderr; that root's own `.env` still decides.
Use `--db <path>` to point one command somewhere else.

| | |
| --- | --- |
| `omni status` | the gateway, its accounts, and their quota, on one screen |
| `omni start` / `stop` / `restart` | run the gateway; `--foreground` attaches it to your terminal |
| `omni doctor` | which installation it resolved, and whether it can act on it |
| `omni logs` | recent requests as the gateway recorded them |
| `omni bodies <request-id>` | captured bodies for one request; withheld unless you pass `--full` |
| `omni console` | the gateway process's own output: boot, refreshes, quota, errors |
| `omni usage` | spend and tokens, by provider, model, key, or day |
| `omni quota` | provider quota per window: use, burn rate, and when it runs out |
| `omni connect <provider>` | authorize an account from the terminal |
| `omni credentials …` | list, show, enable, disable, `set`, `rm`, refresh, `add-key`, health |
| `omni models …` | list, show, put, `rm`, `dry-run`, `catalog` |
| `omni keys …` | list, create, `limits`, revoke |
| `omni plugin …` | list, verify, install, update, remove; see [Plugins](#plugins) |
| `omni service install` / `uninstall` | write or remove a systemd unit for this installation |
| `omni setup claude` / `opencode` | point a client's config at this gateway |
| `omni settings get` / `set` | routing weights, retention, deadlines, and the runtime switches |
| `omni admin set-password` | change the console password |
| `omni db migrate` | create or upgrade the database |
| `omni db stats` | size on disk, free pages, schema version, and what snapshots are held |
| `omni db backup` / `snapshots` | take a snapshot, and list the ones retention has kept |
| `omni db restore <id>` | put a snapshot back; shows a live-vs-snapshot count table, then asks. `--dry-run` shows the table and stops |
| `omni db vacuum` | rewrite the database, reclaiming the pages deletion left free |
| `omni db clear-bodies` | delete every captured request and response body; the requests stay logged |

Two worth knowing:

`omni models dry-run fast` shows exactly where a request would go and why —
each candidate's score, and every account that was excluded with the reason.

`omni status` is the "is anything wrong" command: process state, per-account
health, and how much provider quota each account has left.

## Running it somewhere other than your laptop

`omni service install --enable` writes a systemd unit; behind a reverse proxy,
set `OMNI_BASE_URL` and pass WebSocket upgrades and unbuffered SSE through.
Several replicas behind a load balancer are **cluster mode** on Postgres and
Redis. All of it, with the nginx block and the Kubernetes base, is in
[docs/deploying.md](docs/deploying.md).

## Configuration

Configuration is environment variables, read from the installation's `.env`:

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OMNI_ENCRYPTION_KEY` | Yes | — | Encrypts provider credentials at rest; 16 characters minimum |
| `OMNI_HOST` | No | `127.0.0.1` | Listener host |
| `OMNI_PORT` | No | `9000` | Listener port |
| `OMNI_DB_PATH` | No | `./omnigateway.db` | SQLite database path |
| `OMNI_BASE_URL` | No | derived from host and port | Public origin for OAuth callbacks; set this behind a reverse proxy |
| `OMNI_STATIC_DIR` | No | the console shipped with the server | Serve a different console build |
| `OMNI_LOG_LEVEL` | No | `info` | Stdout threshold: `debug`, `info`, `warn`, or `error` |
| `OMNI_LOG_FILE` | No | the systemd journal, when there is one | Where stdout was already redirected, so the Console screen can read it back. Names a file; does not create one |
| `OMNI_BODY_LOGGING_ALLOWED` | No | unset | Permits request/response body capture on this installation. Read at boot. Capture also needs the runtime setting; see [Recording bodies](docs/operations.md#recording-bodies) |
| `OMNI_ROOT` | No | the installation in the current directory, else `~/.config/omnigateway` | Which installation the CLI acts on, when `--root` is not passed |
| `OMNI_PLUGIN_REGISTRY` | No | the public npm registry | Registry `omni plugin install <name>` resolves through; must be `https://` |
| `OMNI_CLUSTER_MODE` | No | unset | `true` selects [cluster mode](docs/deploying.md#running-more-than-one-gateway) and requires the two URLs below; unset is one process on SQLite, and then the URLs must be unset too |
| `OMNI_DATABASE_URL` | In cluster mode | — | The shared Postgres store |
| `OMNI_REDIS_URL` | In cluster mode | — | The coordinator every process of a cluster shares: rate-limit counters, sessions, leases, push fan-out |

`OMNI_ROOT` is the one variable read from your shell and never from a root's `.env`, for the
reason it has to be: a variable that selects the installation cannot live inside the installation
it selects. A `--root` flag additionally suppresses an ambient `OMNI_DB_PATH`, and says so on
stderr, so pointing the CLI at one installation from inside an unrelated checkout cannot pick up
that checkout's database.

The provider client-identity overrides — `OMNI_UA_*`, `OMNI_ORDER_*`, and the per-provider CLI
version pins — are deliberately left out of this table and documented in `.env.example`. They
change how the gateway identifies itself to a provider, which is not configuration in the sense
the rest of this table is.

Gateway events are written to stdout as one greppable line each. `OMNI_LOG_FILE` *names* where
that output was captured; it does not redirect it — see
[docs/operations.md](docs/operations.md#logs).

Everything else lives in the database rather than the environment, so it can be
changed without a restart: the six routing weights, `maxAttempts`,
`requestDeadlineMs`, the circuit breaker's `breakerThreshold` and
`breakerCooldownMs`, `logRetentionDays`, `quotaPollIntervalMs`, `rtkEnabled`,
`ponytailMode` (`off` | `lite` | `full` | `ultra`),
and the two body-capture switches. Edit them with `omni settings set` or in the
console. `quotaPollIntervalMs` is the one exception: the poller reads it once at
boot, so a change to it takes a restart. Snapshot retention —
`snapshotKeepLatest` and `snapshotMaxAgeDays` — is stored alongside them but
deliberately edited on the Database screen instead; see
[Snapshots and restore](docs/operations.md#snapshots-and-restore) for why.

## Recording bodies, snapshots, and the database

By default the gateway records no prompts and no responses; capture is opt-in
and needs both `OMNI_BODY_LOGGING_ALLOWED=1` at boot and a runtime setting, and
a key created with `--no-bodies` is never captured. Snapshots are one SQLite
file each, taken live, never carrying captured bodies, and restorable without
stopping the gateway. Both, with compaction and clearing bodies, are in
[docs/operations.md](docs/operations.md).

## Docker

```bash
docker build -t omnigateway .
docker run --rm \
  -p 9000:9000 \
  -e OMNI_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -v omnigateway-data:/data \
  omnigateway
```

The container listens on `0.0.0.0:9000`, serves the console, and keeps its
database and plugins under `/data`. Fleets, the Kubernetes base under `k8s/`,
GitOps releases and restart policy are in
[docs/deploying.md](docs/deploying.md#docker).

## Scope and limits

Worth knowing before you deploy it:

- **One process on SQLite by default; a fleet is opt-in.** Cluster mode on
  Postgres and Redis shares every limit, session and lease across replicas.
  Without it, the `1m` window and the `concurrency` gauge are counted in the
  gateway process and reset when it restarts; `5h` and `1w` are counted from
  the database and survive one. Two gateways over one SQLite file are not a
  cluster and would not see each other's short-window counts.
- **One operator, with two narrower views.** An optional read-only console
  password and a per-key client dashboard exist; there is no multi-tenancy —
  every provider account is the operator's, whoever is looking.
- **Two grains of usage history.** Detailed request logs are pruned after 30
  days by default; a daily rollup is kept for 400 days. A day is your host's
  local midnight, fixed when the row is written.
- **Body capture is forensics, not an archive.** It is off unless you turn it on
  with both keys, it expires on the request-log window, and it is capped at
  100,000 rows. `omni bodies` reads one request's capture; nothing searches
  across them.
- **Snapshots are manual, and local.** Nothing takes one on a schedule and there
  is no off-host target; retention bounds what you have taken, and a restore
  always takes one first. Copy them somewhere else yourself if the disk failing
  is what you are guarding against. On Postgres there are none; `pg_dump` is
  the backup.
- **Quota readings come from the providers**, and their usage endpoints are
  undocumented. An account with nothing reported is treated as unknown, never
  as unlimited.
- **The gateway does not know which model accepts which request shape.** An
  unsupported combination surfaces as the provider's own 400 rather than being
  caught earlier.
- Not in scope: semantic caching, billing.

What is missing on purpose, what is missing for now, and what is designed but not
built: [docs/roadmap.md](docs/roadmap.md).

## Security

- Treat `OMNI_ENCRYPTION_KEY`, gateway keys, and the SQLite file as secrets.
  Anyone with the file *and* the key has your provider credentials.
- Prompts and responses are never logged. Request logs hold metadata and token
  counts only, and no body ever reaches stdout, the journal, or the Console
  screen. Bodies are stored only if you opt in to
  [body capture](docs/operations.md#recording-bodies), which needs both an environment variable
  and a setting, encrypts what it writes, and can be refused per key.
- Gateway keys are stored as hashes. A lost key is reissued, not recovered.
- A [snapshot](docs/operations.md#snapshots-and-restore) carries whatever the database does —
  encrypted provider credentials, gateway key hashes — and is inert only because
  `OMNI_ENCRYPTION_KEY` is not in it. Captured bodies are excluded, so a snapshot
  is never a prompt corpus.
- Secrets are never accepted on the command line — `omni` prompts for them or
  reads stdin — so they stay out of your shell history and the process table.
- Behind a reverse proxy, set `OMNI_BASE_URL` to the public HTTPS origin so
  OAuth callbacks match what the providers have registered.
- The gateway talks to your providers and to nobody else. No telemetry, no CDN
  fonts, no third-party origins. A plugin may declare outbound origins of its
  own, and `omni plugin verify <id>` shows exactly which ones it asked for — as
  does its manifest, which is a plain file you can read before installing.
- **Plugins run inside the gateway process, with its privileges** — the
  capability context is a guardrail, not a sandbox. Read the
  [security note](#plugins) before installing one you did not write.

## Plugins

A plugin adds routes, storage, a provider, and a screen in the console to one
installation,
without being part of OmniGateway. Most installations run none.

```bash
omni plugin install ./some-plugin     # a directory, or a .tgz
omni plugin install https://…/x.tgz   # a tarball over https, never http
omni plugin install some-plugin@1.2.3 # a package name, through the npm registry
omni plugin verify some-plugin        # every check the next boot will run
omni plugin list                      # what is installed, and whether it would load
omni plugin update some-plugin        # reinstall from whatever it was installed from
omni restart                          # plugins load at boot, so this is required
```

**Nothing in the package is executed by any of these.** There is no dependency
resolution, no `node_modules`, and no lifecycle script — the installer fetches,
checks, and unpacks, and the plugin's own code is first imported at the next boot.
How a spec is resolved, what installing by name refuses, what `list` and
`verify` report, and what `remove` keeps are in
[docs/plugins.md](docs/plugins.md).

There is no curated directory to browse. None ship in this repository; one is
published:

| Plugin | What it does |
| --- | --- |
| [`@omnigateway/pokemon`](https://github.com/harismawan/omnigateway-plugin-pokemon) | A Pokémon companion. Each gateway key raises one that hatches, evolves, and graduates into a Pokédex on the tokens that key spends, with a shop that spends a wallet of those same tokens. |

```bash
omni plugin install @omnigateway/pokemon
omni plugin verify pokemon
omni restart
```

It needs outbound access to `pokeapi.co` and `raw.githubusercontent.com` for
species data and sprites, which its manifest declares and `omni plugin verify
pokemon` prints back. Those assets are Nintendo and Game Freak intellectual
property, fetched at runtime and never vendored — into that repository, this one,
or anything either publishes.

Read the [security note](#security) on what a plugin can reach before installing
one you did not write. To write one, see
[docs/writing-a-plugin.md](docs/writing-a-plugin.md).

## Development

Contributing, or running from a checkout? See
[ARCHITECTURE.md](ARCHITECTURE.md) for how the system fits together,
[CLAUDE.md](CLAUDE.md) for the repository map, architectural boundaries, and
conventions, [docs/adding-a-provider.md](docs/adding-a-provider.md) for the
provider checklist, and `docs/superpowers/specs/` for the design documents
behind each feature.

```bash
git clone https://github.com/harismawan/omnigateway.git
cd omnigateway
bun install
cp .env.example .env          # then set OMNI_ENCRYPTION_KEY
bun run build:dashboard       # the gateway serves this build
bun run dev                   # gateway on 9000, with file watching
```

Releases are published to npm from a `v*` tag, with provenance attesting which
commit produced them.
