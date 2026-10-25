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
- [docs/operations.md](docs/operations.md) — key limits, logs, log export, recording bodies, snapshots and restore
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
- **Exports its request log.** Every completed request's metadata, durably, to
  Elasticsearch, a webhook, or an OTLP collector such as Langfuse.
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

- [Bun](https://bun.sh/) 1.4.4 or later. Bun is the runtime, not just the
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

One model can be held to a stricter ceiling than the rest of the key's traffic
with `--model-limit <model>:<dimension>:<window>=<value>` (or
`<model>:concurrency=<value>`) — `omni keys create --label ci --limit
requests:1m=600 --model-limit opus:requests:1m=20`. The model is the one the
request names, matched exactly; an override stacks with the key-wide limits, so
a request for that model must pass both. `omni keys limits <id>
--unset-model-limit opus:requests:1m` removes a slot, and the last slot takes
the override with it. **Rolling back** to a build without per-model limits
refuses every key that carries an override (the older build cannot parse the
stored limits, so the key answers 500 until its overrides are removed); keys
without one are unaffected.

A key can also carry an expiry, which is optional and off by default — a key
with none works until it is revoked, and no upgrade ever attaches one:

```bash
omni keys create --label contractor --expires 2027-01-01
omni keys expiry <id> --at 2027-06-01T12:00:00Z   # move it
omni keys expiry <id> --never                     # take it away
```

Past the instant, every request the key makes is refused with the same answer a
revoked or unknown key gets — deliberately indistinguishable. Unlike
`omni keys revoke` this is reversible: a date already behind the clock is
accepted and means "stop it now", and `--never` brings the key back. Expired
keys stay listed, with their own state in `omni keys list` and on the console's
keys board, so a client that stopped working can be found rather than guessed at.

A key can also carry a **usage policy**: what it may be used *for*, in plain
language. Each request through that key is then judged by a classifier model you
choose, before it is routed:

```bash
omni settings set guardrailModel anthropic/claude-haiku-4   # or a virtual model id
omni keys guardrail <id> --policy "Only software engineering and office documents. Refuse roleplay, homework, personal content."
omni keys guardrail <id> --policy-file policy.txt
omni keys guardrail <id> --clear
```

The classifier sees the request's system prompt and the last few messages a human
wrote (`guardrailHistoryTurns`, default 3, 1..10), oldest first, and judges the
newest in their light — so "continue" after a forbidden ask is judged as that
ask. It also sees the text of the tool results that came back after the oldest of
those messages (capped at 16,000 characters, newest first), as data the client
received. It never sees images, files, tool-call arguments, or assistant replies,
and only a plain `ALLOW` lets the request through. Tool output can sway the
verdict either way — a fetched page can talk the classifier round or push it to
refuse legitimate work — and an agent pays one classifier call per tool turn. A deny is refused as `CONTENT_FILTER` (400); a
classifier that times out (`guardrailTimeoutMs`, default 10s), errors, or answers
anything else refuses as `UPSTREAM` (502), and a key with a policy while
`guardrailModel` is unset refuses as `INTERNAL` (500): **it fails closed**.
Streaming requests receive the same refusals as in-stream errors. The refusal
messages are fixed; the classifier's words never reach the client. Each check is
its own request row under the key, tagged `guardrail:classifier` and charged to
it, and verdicts are cached for an hour per key, policy, model and judged text,
so a repeated request is judged once, though each new tool turn is a new one. The key holder sees
the policy and those rows on their client dashboard. A key without a policy is
never judged and pays nothing. `omni doctor` warns when keys carry a policy and
nothing can judge them.

**This is a guardrail, not a security boundary.** It stops ordinary misuse, not a
client set on getting past it — by talking the classifier round, spreading a
request over more messages than the window holds, leaving it out of the history
it sends, hiding it in images, or planting text in tool output the classifier
reads. **Rolling back** to
a build without usage policies ignores them: every key's requests are served
unjudged until you upgrade again.

A key can also be set to **route confidential requests to a local model**. A
classifier running on your own infrastructure reads what the request carries; if
anything in it is confidential, the request is served by a model you host instead
of the one the client asked for. It is active only when the global switch
`smartRouterEnabled` **and** the key's flag are both on:

```bash
omni settings set smartRouterClassifierModel local-judge   # a virtual model, every target a custom endpoint
omni settings set smartRouterLocalModel local-llm          # same rule
omni settings set smartRouterEnabled true
omni keys smart-routing <id> --on                          # or: omni keys create --smart-routing
omni keys smart-routing <id> --off
```

Both models must be configured virtual models whose every target is the `custom`
provider, and the gateway re-checks that at the moment of each send, so a model
edited later cannot quietly start pointing at an external provider. Anything
else is refused, never routed externally. `smartRouterPolicy` says what
"confidential" means (personal data, credentials, salaries and HR records,
customer records, non-public financials, documents marked internal, by default;
editable on the console's Settings screen, which can reset it) and
`smartRouterTimeoutMs` bounds each classifier call (default 10s, 1..60000).

Everything the request carries is judged — system and mid-conversation system
turns, user and assistant text, thinking, tool-call arguments, tool results, tool
names, descriptions and input schemas, citations, the text inside provider-native
blocks (a text document, a search result, an MCP result, a shell output) and
pass-through vendor fields — not just the newest message, because a client
resends the whole conversation. Only images, files and base64 payloads are not
judged. The text is split into segments of up to
8,000 characters, each judged `PUBLIC` or `CONFIDENTIAL` by the local classifier,
at most four at a time. Verdicts are cached for an hour per classifier, policy
and segment, so a conversation that grows is judged only on what is new; failures
are not cached. A request with more than 64 segments still to judge goes local
without being judged.

| Outcome | Result | Row tag |
| --- | --- | --- |
| everything public | served by the model the client asked for | `smart-router:public` |
| anything confidential | served by `smartRouterLocalModel` | `smart-router:local` |
| more than 64 segments still to judge | served by `smartRouterLocalModel`, not judged | `smart-router:local`, `smart-router:oversize` |
| asked for a local-only model already | served as asked, not judged | `smart-router:already-local` |
| classifier timeout, error, or unreadable reply | refused, `UPSTREAM` (502) | `smart-router:unavailable` |
| either model unset, unresolved, or not local-only | refused, `INTERNAL` (500) | `smart-router:unconfigured` |

**It fails closed and never falls back to an external provider**: if the local
model itself fails, the client gets that failure. A confidential request the local
model cannot serve is refused with `NO_CANDIDATES` (503) rather than sent out — one
carrying provider-native content (an Anthropic `search_result` or `document`, a
server-tool result) or provider-defined tools (`web_search`, `bash`, …), which only
that provider can accept, or tools or images the local model lacks. The row still
carries `smart-router:local`. Each check is its own request
row under the key, tagged `smart-router:classifier` and charged to it. When a
key also has a usage policy, smart routing runs first, and a request that goes
local has its policy judged by the smart-router classifier, never by
`guardrailModel`. `omni doctor` has a "smart routing" row; the console's
Settings screen warns under each model picker when the model is unset (switch
on), does not resolve, or is not local-only, and the Keys board says when
flagged keys' requests are refused or unscreened. The client
dashboard shows "Confidential routing: on/off" for the key. The client-visible
signals are in [docs/client-api.md](docs/client-api.md#confidential-routing).

**This reduces leaks of ordinary confidential content; it is not a security
boundary.** It does not stop deliberate evasion (encoding, splitting a secret
across messages, prompt injection aimed at the classifier), confidential content
inside images or files, or a classifier that simply misses. **Rolling back** to a
build without it ignores the flag and sends every request to the external
provider (it fails open) until you upgrade again.

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

Every response carries `x-omni-request-id`. Claude Code, OpenCode, Codex and Pi
sessions are recognised from their own headers and grouped in the console's
Sessions tab; any client can label requests with `x-omni-session-id`,
`x-omni-tags` and `x-omni-metadata`.

Rate-limit headers, request ids and traceability headers, the `/v1/models`
listing shape, and why an Anthropic-defined tool pins a request to an Anthropic
account are in [docs/client-api.md](docs/client-api.md).

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
| `omni logs` | recent requests as the gateway recorded them; filter and page with `--failed`, `--key`, `--since`, `--cursor` |
| `omni logs export` | matching request metadata as CSV or JSONL on stdout; `--since` and `--until` required |
| `omni logs sessions` | per-session requests, turns, tokens and cost, highest cost first; filter the log with `--session`, `--agent`, `--tag` |
| `omni logs show <request-id>` | everything recorded about one request: routing, cost, session, tags, client and provider request ids |
| `omni export …` | log export destinations: list, show, add, `set`, remove; see [Exporting request logs](#exporting-request-logs) |
| `omni bodies <request-id>` | captured bodies for one request; withheld unless you pass `--full` |
| `omni console` | the gateway process's own output: boot, refreshes, quota, errors |
| `omni usage` | spend and tokens, by provider, model, key, or day; `--account <id>` and `--key <id>` narrow to one account or gateway key |
| `omni quota` | provider quota per window: use, burn rate, and when it runs out |
| `omni quota refresh <id> \| --all` | read provider quota now, without waiting for the next poll |
| `omni quota resets <id>` / `omni quota reset <id>` | list / spend a banked Codex or Claude quota reset (irreversible) |
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
| `OMNI_EXPORT_BODIES_ALLOWED` | No | unset | Reserved for exporting captured bodies to [log export](#exporting-request-logs) destinations, which is not available yet; export sends metadata only |
| `OMNI_METRICS_TOKEN` | No | unset | Registers authenticated `GET /metrics`; unset means no route |
| `OMNI_METRICS_MAX_SERIES` | No | `5000` | Series cap before new `api_key_id` values fold to `other` |
| `OMNI_OTLP_ENDPOINT` | No | unset | Enables OTLP/HTTP span export to `<endpoint>/v1/traces` |
| `OMNI_OTLP_HEADERS` | No | unset | Comma-separated `k=v` headers sent to the collector |
| `OMNI_TRACE_SAMPLE` | No | `1.0` | Head sampling ratio from `0` to `1`; inbound sampled trace context is honoured |
| `OMNI_ROOT` | No | the installation in the current directory, else `~/.config/omnigateway` | Which installation the CLI acts on, when `--root` is not passed |
| `OMNI_PLUGIN_REGISTRY` | No | the public npm registry | Registry `omni plugin install <name>` resolves through; must be `https://` |
| `OMNI_CLUSTER_MODE` | No | unset | `true` selects [cluster mode](docs/deploying.md#running-more-than-one-gateway) and requires the two URLs below; unset is one process on SQLite, and then the URLs must be unset too |
| `OMNI_DATABASE_URL` | In cluster mode | — | The shared Postgres store |
| `OMNI_REDIS_URL` | In cluster mode | — | The coordinator every process of a cluster shares: rate-limit counters, sessions, leases, push fan-out |
| `OMNI_DAY_OFFSET_MINUTES` | No | host's UTC offset at boot | Fixed minutes east of UTC for daily usage buckets; set explicitly and identically on every replica |

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
`breakerCooldownMs`, `logRetentionDays`, `bodyRetentionDays`, `quotaPollIntervalMs`, `rtkEnabled`,
`ponytailMode` (`off` | `lite` | `full` | `ultra`),
and the two body-capture switches. Edit them with `omni settings set` or in the
console. `quotaPollIntervalMs` is the one exception: the poller reads it once at
boot, so a change to it takes a restart. `requestDeadlineMs` defaults to `0`,
which imposes no deadline at all; what that means for whatever sits in front of
the gateway is
[Behind a reverse proxy](docs/deploying.md#behind-a-reverse-proxy). Snapshot retention —
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

## Exporting request logs

The gateway can ship every completed request-log row to a store you already run, so the local
30-day log is not the only record: Elasticsearch or OpenSearch, any HTTP endpoint that takes JSON,
or an OTLP collector (and through it Langfuse). Delivery is durable and resumable — each
destination keeps a cursor that survives restarts, crashes and, in cluster mode, failover to
another replica — and the rows a destination selects (its start position and filter) are sent
**at least once**: a crash between send and commit resends, so a row can arrive twice. Every
record carries a stable `id` to dedupe on; Elasticsearch writes are idempotent by it.

What is not delivered is counted or flagged, never silent: records the receiver rejects one by
one (Elasticsearch item errors, OTLP `partialSuccess`), a record too large for one request, and
rows passed by *Skip to now* are counted as dropped; rows pruned by retention before they were
sent raise the gap warning. One documented limit: a completion whose write commits more than
10 seconds after its timestamp can be passed over
([details](docs/operations.md#log-export)).

**Metadata only.** A record is the row's metadata: timestamps, key id and label, requested and
resolved model, provider, account id, status, error code, tokens, cost, latency, RTK figures,
session, turn, agent, tags, metadata and request ids, as JSON with
`"schema": "omni.request_log/v1"`. Body export is not available yet; the per-destination switch
exists and is refused, and `OMNI_EXPORT_BODIES_ALLOWED` is reserved for it.

Add destinations on the console's **Export** page or with `omni export`. Up to ten; ids are
`[a-z0-9-]{1,40}`. Secrets — API keys, passwords, secret headers, the webhook signing secret —
are encrypted with `OMNI_ENCRYPTION_KEY`, never shown again, and on the CLI read only from
`--secret-file <path>` or stdin (`--secret-file -`):

```bash
echo '{"apiKey":"<base64 id:key>"}' > es.json
omni export add elasticsearch es --url https://es.internal:9200 --auth apiKey --secret-file es.json
omni export add webhook hook --url https://hooks.example.com/omni --secret-file - <<< '{"signingSecret":"…"}'
omni export add otlp collector --endpoint http://otel:4318 --signal logs --start-from oldest
omni export list                   # type, state, target, secret set / not set, filter
omni export set es --filter-key key_ci --failed-only   # the filter is written whole
```

- **Start position.** `--start-from now` (the default) exports what completes from creation on;
  `oldest` starts from the oldest row still retained. Nothing older than retention can be
  exported, and the position is fixed at creation — a worker that starts late skips nothing.
- **Filter.** Optional: gateway key ids, model names (matched exactly against requested or
  resolved), and failed requests only (status ≥ 400). An empty list selects nothing.
- **Send test**, **Skip to now** and **Preview a record** run inside the gateway, so they are on
  the console only; `omni export test|skip` say so. `omni export` administers SQLite
  installations and refuses on a Postgres (cluster) one: use the console there.

Rows go out 10–15 seconds after the request completes, in batches of at most 500 records or
5 MiB. Lag, failures, the retention-gap warning, skip-to-now and what a restore does to export
are in [docs/operations.md](docs/operations.md#log-export).

**Elasticsearch / OpenSearch.** `_bulk` to `<url>/_bulk`, gzipped, one `index` action per row
with `_id` = the request id, so a resend overwrites. Index pattern defaults to
`omni-logs-{yyyy.MM.dd}`, the date taken from the row's `at` in UTC. Auth is `apiKey`
(`{"apiKey":"…"}`, sent as `Authorization: ApiKey …`), `basic`
(`{"username":"…","password":"…"}`) or `none`. Per-item mapping errors are counted as dropped
and the batch commits; per-item 429/5xx retry the batch. The gateway creates no index template;
this one is recommended:

```
PUT _index_template/omni-logs
{
  "index_patterns": ["omni-logs-*"],
  "template": {
    "mappings": {
      "dynamic": false,
      "properties": {
        "schema": { "type": "keyword" }, "id": { "type": "keyword" },
        "at": { "type": "date" }, "completedAt": { "type": "date" }, "nodeId": { "type": "keyword" },
        "apiKey": { "properties": { "id": { "type": "keyword" }, "label": { "type": "keyword" } } },
        "model": { "properties": { "requested": { "type": "keyword" },
          "resolved": { "type": "keyword" }, "provider": { "type": "keyword" } } },
        "credentialId": { "type": "keyword" }, "status": { "type": "short" },
        "errorCode": { "type": "keyword" }, "attempts": { "type": "short" },
        "tokens": { "properties": { "input": { "type": "long" }, "output": { "type": "long" },
          "cacheRead": { "type": "long" }, "cacheWrite": { "type": "long" } } },
        "costUsd": { "type": "double" }, "ttftMs": { "type": "long" }, "durationMs": { "type": "long" },
        "degradations": { "type": "keyword" },
        "rtk": { "properties": { "applied": { "type": "boolean" }, "filterHits": { "type": "long" },
          "originalCodeUnits": { "type": "long" }, "compressedCodeUnits": { "type": "long" },
          "estimatedTokensSaved": { "type": "long" }, "filters": { "type": "keyword" } } },
        "session": { "properties": { "id": { "type": "keyword" }, "turn": { "type": "keyword" },
          "agent": { "type": "keyword" } } },
        "tags": { "type": "keyword" }, "metadata": { "type": "flattened" },
        "requestIds": { "properties": { "client": { "type": "keyword" },
          "upstream": { "type": "keyword" } } }
      }
    }
  }
}
```

`metadata` keys are caller-supplied, hence `flattened` (OpenSearch: `flat_object`) rather than
one mapped field per key. `dynamic: false` keeps any field added to the schema later in
`_source` without mapping it.

**Webhook.** `POST` to the URL exactly as configured, uncompressed, with
`{"schema":"omni.request_log/v1","records":[…]}`. Any 2xx accepts the batch; the response body is
ignored. Plain headers go in the config, credential headers in the secret
(`{"headers":{…},"signingSecret":"…"}`). With a signing secret, every request carries
`x-omni-timestamp: <unix seconds>` and `x-omni-signature: sha256=<hex>`: HMAC-SHA256, keyed with
the secret's UTF-8 bytes, over the exact string `<timestamp>.<raw body>`. Verify it before
parsing:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody: Buffer, headers: Headers, secret: string, toleranceSeconds = 300): boolean {
  const timestamp = headers.get("x-omni-timestamp") ?? "";
  const signature = headers.get("x-omni-signature") ?? "";
  if (!/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) return false; // replay
  const mac = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  const expected = Buffer.from(`sha256=${mac}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

**OTLP.** OTLP/HTTP JSON, gzipped, to `<endpoint>/v1/logs` or `<endpoint>/v1/traces`; headers
come from the secret (`{"headers":{…}}`). `logs` sends one log record per row; `traces` one
`CLIENT` span per row, named `chat <requested model>`, from `at` to `at + durationMs`, status
`ERROR` with the gateway's error code on failure. Trace and span ids derive from the request id
alone, so a resend is the same span. Attributes are the GenAI conventions
`gen_ai.operation.name` (`chat`), `gen_ai.request.model`, `gen_ai.response.model`,
`gen_ai.system` (the gateway's provider id), `gen_ai.usage.input_tokens` (the whole prompt,
cached tokens included) and `gen_ai.usage.output_tokens`, the session as `session.id`, and
everything else under `omni.*`. `partialSuccess` rejections count as dropped. These are separate
from the sampled live spans `OMNI_OTLP_ENDPOINT` sends.

**Langfuse**, through its OTLP endpoint — a traces destination whose secret carries the Basic
auth built from the project's public and secret keys:

```bash
printf '{"headers":{"authorization":"Basic %s","x-langfuse-ingestion-version":"4"}}' \
  "$(printf '%s' 'pk-lf-…:sk-lf-…' | base64 -w0)" > langfuse.json
omni export add otlp langfuse --signal traces \
  --endpoint https://cloud.langfuse.com/api/public/otel --secret-file langfuse.json
```

Spans arrive as generations with model and token usage, grouped by session. Other regions and
self-hosted URLs: see
[Langfuse's OpenTelemetry docs](https://langfuse.com/integrations/native/opentelemetry).

**Outbound requests.** URLs are `http:` or `https:` with no credentials, query or fragment in a
base URL; private and loopback hosts are allowed. Redirects are never followed (a 3xx is a
configuration error). Connect timeout 5 s, request timeout 20 s.

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
  days by default; a daily rollup is kept for 400 days. A day uses a fixed UTC
  offset, defaulting to the host's current offset; fleets must set it explicitly.
  Keep rows longer by [exporting them](#exporting-request-logs).
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
- **Thinking controls retain their wire intent.** Anthropic `between_tools` passes
  through; other providers treat it as off and report a degradation. Unparsed
  Anthropic thinking fields (including beta controls) pass through only to
  Anthropic; supply any required beta header yourself. Hidden adaptive display
  omits generated Responses reasoning summaries, without inventing a default.
- **Claude Code auto mode supports Anthropic server-side classifier results.**
  On Anthropic targets, the gateway forwards `safeguards`, protocol headers, and
  original `safeguard_results` in both streaming and buffered replies. Safeguard
  requests retain the client's system blocks and tool names/IDs rather than the
  ordinary OAuth system/tool transformations. Eligibility and no-charge checks
  still depend on Anthropic's rollout for the upstream credential/model; routing
  to another provider does not supply them. This is not a byte-transparent proxy:
  gateway policies and other request normalization still apply.
  After deploying this version, start a **new Claude Code session** and check
  `/status` → **Auto mode server: Enabled**. If the upstream is not eligible,
  `CLAUDE_CODE_AUTO_MODE_SERVER=0` before starting Claude Code uses its separate
  classifier calls instead; these remain billed as token usage. See
  [Anthropic's notice guide](https://code.claude.com/docs/en/auto-mode-classifier-billing).
- **An OpenAI OAuth (ChatGPT) target presents itself as Codex, and answers like
  it.** Requests on that leg match Codex 0.163.0's TUI field by field, which
  changes model behaviour for every client routed there, Claude Code included:
  one tool call per turn (`parallel_tool_calls: false`), terser answers
  (`text.verbosity: "low"`), and a request that names no reasoning effort —
  including adaptive thinking with no effort — runs at the model's Codex catalog
  default (`low` or `medium`) rather than `medium`. A client's own `text`,
  `reasoning` or tool choice still wins field by field. OpenAI API-key targets
  are unaffected. Credentials connected before this pick up their per-credential
  identity on their next token refresh. Details:
  [the fingerprint design](docs/superpowers/specs/2026-10-16-codex-0163-fingerprint-design.md).
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
- The gateway talks to your providers and to nobody else — except your collector, if you name
  one with `OMNI_OTLP_ENDPOINT`, and the [log export](#exporting-request-logs) destinations you
  add. No CDN fonts or undeclared third-party origins. A plugin may
  declare outbound origins of its own, and `omni plugin verify <id>` shows exactly which ones it
  asked for — as does its manifest, which is a plain file you can read before installing.
- A log-export webhook with a signing secret sends `x-omni-timestamp: <unix seconds>` and
  `x-omni-signature: sha256=<hex>`, the HMAC-SHA256 (keyed with the secret's UTF-8 bytes) of the
  exact string `<timestamp>.<body>`: the timestamp header's value, a `.`, then the raw request
  body. Recompute it, compare in constant time, and refuse a timestamp outside your own tolerance
  window to stop replays; [the snippet](#exporting-request-logs) does all three. Export records
  carry key labels and account ids, so treat a destination as you would the request log itself.
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

The checkout pins Bun 1.4.4 for local builds, CI, and releases. See the
[Bun built-ins audit](docs/bun-builtins-audit.md) for native-tool migrations and
compatibility boundaries.

```bash
git clone https://github.com/harismawan/omnigateway.git
cd omnigateway
bun install
cp .env.example .env          # then set OMNI_ENCRYPTION_KEY
bun run build:dashboard       # the gateway serves this build
bun run dev                   # gateway on 9000, with file watching
```

For dashboard development, run `bun run dev:dashboard` in another terminal
(port 5173, API/health proxied to 9000). Bun rebuilds after source changes and
reloads the page; component state resets, with no React Fast Refresh.
`bun run --cwd apps/dashboard preview` serves an existing build on port 4173.
Both commands accept `--host`, `--port` and `--upstream` options.

Releases are published to npm from a `v*` tag, with provenance attesting which
commit produced them.
