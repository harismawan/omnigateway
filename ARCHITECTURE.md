# Architecture

How OmniGateway is put together, for contributors and anyone auditing the
design. The [README](README.md#how-it-is-built) has the package map and the
layering rules; this document is the detail behind them.

For the conventions that govern changes — architectural boundaries, testing
expectations, and the traps worth knowing — see [CLAUDE.md](CLAUDE.md). Approved
designs live in `docs/superpowers/specs/`.

## Contents

- [What a request actually does](#what-a-request-actually-does)
- [Routing](#routing)
- [Dispatch](#dispatch)
- [Providers](#providers)
- [Storage](#storage)
- [Background loops](#background-loops)
- [The console and the CLI](#the-console-and-the-cli)

## What a request actually does

`POST /v1/messages` and `POST /v1/chat/completions` are the same handler; the
dialect is a parameter.

```mermaid
sequenceDiagram
  autonumber
  actor Client
  participant Route as routes/proxy
  participant In as ingress
  participant RTK as @omni/rtk
  participant Router as @omni/router
  participant Disp as dispatch
  participant Cred as @omni/store
  participant Prov as provider adapter
  participant Out as egress
  participant Log as request_logs

  Client->>Route: POST /v1/messages
  Route->>Route: Bearer or x-api-key<br/>(both = reject), hash lookup
  Route->>Route: per-key rate limit
  Route->>In: validate + translate
  In-->>Route: ChatRequest (provider-neutral IR)
  Route->>Route: model allowlist,<br/>after alias normalization
  Route->>Disp: dispatch(request, signal)
  Disp->>RTK: filter tool results (off by default)
  RTK-->>Disp: rewritten request + savings report
  Disp->>Router: rank(snapshot, load)
  Router-->>Disp: ordered candidates + exclusion reasons
  Disp->>Log: pending row
  Disp->>Cred: openForInference()
  Note over Cred: decrypted here, not before
  Disp->>Prov: send(request, creds, http)
  Prov-->>Disp: StreamEvent stream
  Disp->>Out: events
  Out-->>Client: SSE in the client's dialect<br/>+ : keepalive every 10s
  Disp->>Log: close out — tokens, cost, status
```

Two details the diagram flattens. Credentials are decrypted at step 13 and not a
moment earlier, so ranking ten candidates costs zero decryptions. And the log row
is opened before the first attempt and closed exactly once — a client that hangs
up mid-stream is recorded as such, not as a success.

`GET /v1/models` is answered from the routing snapshot with no provider call, and
`POST /v1/messages/count_tokens` is estimated locally — it deliberately writes no
usage row.

## Routing

The router is a pure function over an immutable snapshot of credentials, health,
quota, models, and settings, plus a live count of in-flight requests. It returns
candidates in the order to try them, and every excluded account with its reason —
which is exactly what `omni models dry-run` prints.

```mermaid
flowchart LR
  vm["virtual model<br/><b>fast</b>"] --> targets["targets<br/>credential × model"]

  targets --> filter{eligible?}
  filter -- no --> excl["<b>excluded</b>, with reason<br/>capability mismatch · disabled<br/>expired, no refresh token<br/>rate limited · breaker open"]
  filter -- yes --> score

  subgraph score["score — six normalized terms"]
    direction TB
    t["tier ×10"]
    h["health ×3"]
    q["quota headroom ×2"]
    l["load ×2"]
    c["cost ×1"]
    lat["latency ×1"]
  end

  score --> mult["× credential weight<br/>× target weight"]
  mult --> strat{strategy}
  strat --> out["ordered candidates<br/><i>walked on failover</i>"]
  strat -.- opts["priority · roundRobin<br/>weighted · score"]
```

Weights shown are the defaults and are configurable. A request carrying an
Anthropic-defined tool is excluded from every non-Anthropic target at the filter
stage — which is why it fails at routing with the requirement named, rather than
quietly losing the tool. The breaker's cooldown scales with consecutive failures.

Nothing here is thrown away: the exclusion list with its reasons is exactly what
`omni models dry-run` prints.

## Dispatch

Dispatch is where the side effects the router refuses to have actually live: the
request deadline, retries, failover, token refresh, health writes, cost pricing,
and load accounting.

The important rule is the **commit point**:

```mermaid
flowchart TD
  start([candidate 1]) --> att["attempt<br/><i>refresh token if inside lead window</i>"]
  att --> ev{first event?}

  ev -- error --> retryable{retryable<br/>and attempts left?}
  retryable -- yes --> next["next candidate<br/><i>breaker opens on the old one</i>"] --> att
  retryable -- no --> fail(["error response<br/><i>client never saw a byte</i>"])

  ev -- "first content delta" --> commit{{"COMMITTED<br/>record ttft"}}
  commit --> stream["stream to client"]
  stream --> late{error now?}
  late -- yes --> inband(["reported in-band<br/><i>no failover possible</i>"])
  late -- no --> done(["end · usage · cost"])
```

Everything left of the commit point is invisible to the client: a rate-limited or
broken account is swapped for another and the request simply succeeds. Everything
right of it is not, and pretending otherwise would corrupt the stream.

Circuit-breaker state and latency are written back on every terminal outcome, so
the next request's ranking reflects this one.

## Providers

Four adapters, each a directory of the same four files:

```mermaid
flowchart LR
  ir(["ChatRequest<br/>(IR)"]) --> wire["wire.ts<br/><i>IR → provider body</i>"]
  wire --> http["http-client.ts<br/><b>node:http, not fetch</b>"]
  http --> up[("Anthropic · OpenAI Responses<br/>Kimi · custom origin")]
  up --> dec["decode.ts<br/><i>SSE → StreamEvent</i>"]
  dec --> ev(["StreamEvent<br/>(IR)"])
  cat["models.ts → catalog<br/><i>pricing + limits, defaults only</i>"] -.-> wire
```

The `custom` adapter points another provider's codec at a different origin.

All outbound HTTP goes through one client, and that client is built on
`node:http` rather than `fetch` for a specific reason: Bun's `fetch` alphabetizes
request headers, which destroys the header order and casing providers use to
recognize a first-party CLI. The client preserves both verbatim, and logs only
host, path, status, and duration.

The catalog supplies defaults — pricing and context limits — at the moment you
create a target. The router then prices from the saved target, so editing the
catalog affects new targets only.

## Storage

One SQLite file, WAL mode, six migrations.

```mermaid
flowchart TB
  subgraph accounts[Accounts]
    cred["<b>credentials</b><br/>access_token 🔒 refresh_token 🔒<br/>api_key 🔒 id_token 🔒"]
    health["<b>credential_health</b><br/>breaker · failures · ewma ttft"]
    quota["<b>quota_windows</b><br/>provider observations,<br/>not gateway counts"]
  end

  subgraph config[Configuration]
    vm["<b>virtual_models</b><br/>targets, pricing, weights"]
    keys["<b>api_keys</b><br/>hash only, never the key"]
    settings["<b>settings</b>"]
  end

  subgraph history[History]
    logs["<b>request_logs</b><br/>metadata + tokens, state pending→done<br/><i>pruned at logRetentionDays</i>"]
    daily["<b>usage_daily</b><br/>rollup<br/><i>kept 400 days</i>"]
  end

  cred --- health
  cred --- quota
  logs == "same transaction" ==> daily
```

Writing the rollup in the *same transaction* as the log row is what lets a year of
usage history survive the 30-day pruning of the detailed logs.

Encryption is a boundary, not a pass. Only the four 🔒 fields are sealed, with
AES-256-GCM under a key derived from `OMNI_ENCRYPTION_KEY`, and decryption is
lazy and purpose-scoped — a credential opens *for inference*, *for refresh*, or
*for usage*, so ranking ten candidates costs zero decryptions. Gateway API keys
are not stored at all, only their hashes.

## Background loops

Three, started at boot and stopped on signal:

```mermaid
flowchart LR
  boot([boot]) --> sweep["sweep pending rows<br/><i>once</i>"]
  boot --> oauth
  boot --> quota
  boot --> maint

  oauth["<b>OAuth refresh</b><br/>every 60s"] --> oauthJob["renew inside lead window<br/>disable if expired, no refresh token"]
  quota["<b>Quota poller</b><br/>every quotaPollIntervalMs"] --> quotaJob["ask providers what is left<br/><i>failed probe ⇒ unknown, never disabled</i>"]
  maint["<b>Maintenance</b><br/>every 1h"] --> maintJob["prune request_logs at retention<br/>prune usage_daily at 400d"]

  oauthJob -.-> oauth
  quotaJob -.-> quota
  maintJob -.-> maint
```

Setting `quotaPollIntervalMs` to zero disables the poller entirely; it is read
once at boot. Retiring the `pending` rows at startup is what stops a crash from
double-counting usage.

## The console and the CLI

Two front ends, one set of operations, two very different paths to it:

```mermaid
flowchart LR
  browser(["browser"]) -- "/api/* + session cookie" --> admin["routes/admin<br/><i>requireAdmin, then exactly<br/>one control call</i>"]
  admin --> control["@omni/control"]
  term(["terminal"]) --> omni["omni<br/><i>no HTTP at all</i>"]
  omni --> control
  control --> db[("SQLite")]

  spa["dashboard SPA<br/><i>static files, same origin</i>"] -.- browser
  gw["apps/gateway serves both"] -.- spa
  gw -.- admin
```

The console is a React SPA the gateway serves as static files from its own
origin; it may import types and the model catalog, never a provider adapter or
the HTTP client. The CLI skips the server completely and opens the database
itself — same operations, no running gateway required.
