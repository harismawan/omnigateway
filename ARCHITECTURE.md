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
  - [Replacing the database while it is open](#replacing-the-database-while-it-is-open)
- [Background loops](#background-loops)
  - [Stopping and restarting](#stopping-and-restarting)
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

Five adapters, each a directory of the same four files:

```mermaid
flowchart LR
  ir(["ChatRequest<br/>(IR)"]) --> wire["wire.ts<br/><i>IR → provider body</i>"]
  wire --> http["http-client.ts<br/><b>node:http, not fetch</b>"]
  http --> up[("Anthropic · OpenAI Responses<br/>Kimi · xAI · custom origin")]
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

One SQLite file, WAL mode, eight migrations — plus, when body capture is on, a
tree of encrypted artifacts beside it.

```mermaid
flowchart TB
  subgraph accounts[Accounts]
    cred["<b>credentials</b><br/>access_token 🔒 refresh_token 🔒<br/>api_key 🔒 id_token 🔒"]
    health["<b>credential_health</b><br/>breaker · failures · ewma ttft"]
    quota["<b>quota_windows</b><br/>provider observations,<br/>not gateway counts"]
    samples["<b>quota_samples</b><br/>one row per changed reading<br/><i>pruned at logRetentionDays</i>"]
  end

  subgraph config[Configuration]
    vm["<b>virtual_models</b><br/>targets, pricing, weights"]
    keys["<b>api_keys</b><br/>hash only, never the key"]
    settings["<b>settings</b>"]
  end

  subgraph history[History]
    logs["<b>request_logs</b><br/>metadata + tokens, state pending→done<br/><i>pruned at logRetentionDays</i>"]
    daily["<b>usage_daily</b><br/>rollup<br/><i>kept 400 days</i>"]
    hourly["<b>usage_rollup</b><br/>per-key hourly counters, derived<br/><i>pruned with request_logs</i>"]
    bodies["<b>request_bodies</b><br/>pointer + sha256, never a body<br/><i>pruned at logRetentionDays, capped at 100k rows</i>"]
    artifact["<i>request_bodies/YYYY/MM/DD/&lt;id&gt;.json.enc</i> 🔒<br/>client pair + one pair per attempt"]
  end

  cred --- health
  cred --- quota
  quota == "same transaction" ==> samples
  logs == "same transaction" ==> daily
  logs == "same transaction" ==> hourly
  logs -. "requestId" .- bodies
  bodies -. "rel_path" .-> artifact
```

Writing the rollup in the *same transaction* as the log row is what lets a year of
usage history survive the 30-day pruning of the detailed logs.

`quota_samples` is written in the same transaction as the snapshot it describes, and only
when the reading actually changed — an idle account is re-read every poll interval and moves
nothing. `quota_windows` therefore answers "what is true now" and carries liveness in its
`observed_at`; `quota_samples` answers "how did it get here". The burn estimate needs only
the former, so it works on an install with no accumulated history.

Encryption is a boundary, not a pass. Only the four 🔒 fields are sealed, with
AES-256-GCM under a key derived from `OMNI_ENCRYPTION_KEY`, and decryption is
lazy and purpose-scoped — a credential opens *for inference*, *for refresh*, or
*for usage*, so ranking ten candidates costs zero decryptions. Gateway API keys
are not stored at all, only their hashes.

`request_bodies` is the one table whose payload is not in the database. Bodies
are the largest thing this gateway could store — one conversation with a pasted
file in it dwarfs the whole of `request_logs` — and inlining them would carry
every prompt through the same page cache, the same WAL, and the same `VACUUM` as
the routing tables, one `sqlite3` invocation from plaintext. The row therefore
holds a pointer and a `sha256` **over the ciphertext**, so on-disk truncation is
detectable by a reader that does not hold the key at all. That is what lets the
reader answer `missing` or `corrupt` instead of raising: a file tree and a table
that are not written transactionally together *will* drift, and expiry deletes
file and row explicitly rather than by `ON DELETE CASCADE`, because a silently
disabled `foreign_keys` pragma would turn expiry of a prompt corpus into
indefinite retention of one.

Capture needs two keys — `OMNI_BODY_LOGGING_ALLOWED` at boot and
`settings.bodyLoggingEnabled` at runtime — and a third can veto it: an API key
carrying `body_logging_opt_out` is never captured. Both are checked in
`apps/gateway/src/routes/proxy.ts` before any capture work begins. Reading back
is `readRequestBody` in `@omni/control`, served by `GET /api/requests/:id/body`
behind the same admin session as every other `/api/*` route.

One artifact holds the client pair and every wire pair together, so a failover
incident reads as one ordered story. The two are not the same payload: RTK's
`transformRequest` runs in dispatch before routing, so `client.request` is the
pre-filter conversation and every `attempts[].request` is the post-filter one.
`request_logs` already records which filters ran and how much they removed but
not *what*, and the artifact is the only place that can be read — which is why
the console labels each side rather than presenting them as interchangeable.

### Replacing the database while it is open

A snapshot is `VACUUM INTO` a file in `snapshots/` beside the database. That
folds the write-ahead log in by definition, so there is no `-wal` or `-shm` to
handle on the way out, and it reads through SQLite rather than copying the file,
so taking one against a live gateway yields a consistent database rather than a
torn one. The `request_bodies/` tree is excluded by construction: including it
would make every downloaded copy a prompt corpus and would make snapshot size
track prompt volume rather than database size. A restore therefore leaves the two
sides out of step, which is a state that already exists and is already handled:
the orphan sweep above collects files the restored `bodies` table no longer
references, and a row whose file is gone reads back as *captured, then lost*
rather than raising.
Retention — `keepLatest` and `maxAgeDays`, both enforced, newest always kept —
prunes when a snapshot is written *and* on the hourly sweep. Both, because the
create path alone is not a policy: an installation that stops taking snapshots
never expires one, and lowering `keepLatest` does nothing until somebody happens
to take another. The forced copy taken on the way into a restore skips the prune
during its own creation and stays exempt from every later one, because the undo
for an operation must not be deletable by the policy that operation runs under —
nor by ordinary housekeeping five manual snapshots later. The same sweep removes
staging files no operation is holding any more: an upload a refused import wrote,
and the `${db}.incoming` a swap that failed after its rename left behind. Both
are database-sized and nothing else looks at that directory.

Restoring one replaces the file every repo reads from, inside the process that is
reading it. Three pieces make that survivable.

**The store is swappable.** `createStore` returns a stable outer object whose repo
methods forward, *per call*, to a replaceable inner handle; `reopen()` closes the
inner handle and opens a new one at the same path, and `close()` is idempotent so
a restore can close, move a file, and reopen without a separate primitive. The
indirection is not decoration. The store is captured by value into five long-lived
holders at boot — the app, the refresher, and the three loops — and two dozen
modules are typed against `Store`, so closing and re-opening a connection
underneath them would leave every one of them holding repos bound to a dead
`Database`. Reading the handle per call is what makes the swap invisible to them.
It also means binding a repo method to a local defeats the whole mechanism and
strands that local on the closed handle. Routing subscribers live on the outer
object for the same reason: a listener registered at boot has to survive a
restore.

**A quiesce latch gates client traffic, and only client traffic.** `/v1/*` is
refused with a 503 and a `retry-after`, rendered by the same encoders the proxy
uses so an SDK gets an error in the dialect it already parses. `/api/*` and
`/health` stay live for the whole operation: the console is how an operator
watches a restore and how they hear that it failed, so a latch that covered the
whole server would black out the dashboard at the exact moment it is needed and
take the load balancer's health check with it.

What the latch waits for is requests being *answered*, not streams draining.
Elysia's `onAfterResponse` fires when the response is handed back, which for SSE
is long before the body ends. So the wait is bounded — ten seconds — and the latch
stays shut for the whole swap rather than only until the in-flight count reaches
zero, because a stream admitted before the close is still reading through the
handle the swap is about to replace.

**The sequence is ordered so that neither of the two things making it recoverable
can be skipped:** nothing is closed until the candidate has been judged, and
nothing is swapped until the undo exists.

```mermaid
flowchart TD
  req(["restore or import"]) --> latch["close latch<br/><i>/v1 refused · drain, bounded at 10s</i>"]
  latch --> insp["inspect candidate<br/><b>read-only, separate handle</b><br/>quick_check + migration-001 tables"]
  insp -- "corrupt, or not ours" --> abort(["BAD_REQUEST<br/><i>live database untouched</i><br/>latch reopens"])
  insp -- ok --> undo["pre-restore snapshot<br/><i>forced, exempt from retention</i>"]
  undo --> stage["stage beside the live file<br/><i>nothing closed yet</i>"]
  stage -- "no room" --> abort
  stage --> swap["close handle · unlink stale -wal/-shm<br/>rename into place · reopen()"]
  swap -- fails --> wedged(["<b>SwapFailedError</b><br/>best-effort reopen, then latch stays shut<br/><i>pre-restore id logged</i>"])
  swap -- ok --> inval["invalidate the routing snapshot<br/>end admin sessions <i>iff</i> the password hash changed"]
  inval --> open(["latch reopens"])
```

The error seam is the distinction worth internalizing. Everything before the swap
— a file that fails `quick_check`, a file that is a database but not one of ours,
no room on disk for the undo, **no room for the staging copy** — fails with the
live database untouched, and the latch reopens immediately. The staging copy in
particular sits outside the swap's `try`, because a full disk is where it
actually fails and it fails having moved nothing: classing that as a failed swap
would refuse `/v1` until an operator restarted the process, over a database that
was never opened.

A failure *during* the swap raises `SwapFailedError`, and the gateway
deliberately leaves the latch shut: the file it would serve from is in an unknown
state, and refusing client traffic beats answering out of a half-swapped
database. The handle itself is reopened on the way out, best effort, and the
error carries whether that worked — because both halves of the documented
recovery run through it. `GET /api/database` reads PRAGMAs through that handle
and a second attempt takes its own undo snapshot through it, so a swap that left
the database closed would leave the panel blank and turn the retry into a
different, unrecognised failure. `/api/*` is still up, which is how an operator
reaches the pre-restore snapshot named in the log line.

The latch is reopened only by the call that shut it, and only on a failure. Two
mutating requests can overlap — a double-clicked button, two tabs — and the
single-flight guard that refuses the second lives *inside* the operation, which
the gateway reaches only after closing the latch. Without that rule the refused
request reopens the gate while the first is mid-swap, which is precisely the
window the latch exists to cover. Success reopens unconditionally, because
restoring the undo snapshot is the documented way out of a failed swap and it has
to end that outage rather than inherit it.

The required-tables check is the set migration 001 creates, not today's schema.
`openDb` migrates a snapshot forward on the way in, so asserting the current
tables would reject exactly the old backup an operator reaches for.

Two smaller placements carry weight. The candidate is copied to a staging name
*before* the handle closes, so the window with no database open is a rename and
not a file copy. And an uploaded database is streamed to a temp file beside the
live one rather than into `/tmp`, because the swap renames that file into place
and a rename across filesystems fails. That upload is bounded twice: by the byte
cap this gateway will accept at all, and by what the disk can take with room left
for the undo snapshot the import is about to write — the same precheck
`createSnapshot` runs, on the one path that accepts operator-supplied bytes. The
stale
`-wal` and `-shm` go while the handle is shut: they belong to the file being
replaced, and SQLite reopening a new database beside another database's
write-ahead log is how a restore becomes corruption.

Two pieces of derived state do not survive the swap on their own. The routing
snapshot cache checks staleness with SQLite's `data_version`, which is
connection-local — a freshly opened handle over a different file can report the
same number and serve a stale snapshot — so it is invalidated explicitly. Admin
sessions live in a `Map` rather than in the database, but `setPassword` clears
them, so a restore that writes a different password hash is that same "log
everyone out" event arriving by another door. The hashes are compared across the
swap and only a boolean leaves the operation, so restoring this installation's own
snapshot leaves the operator signed in.

The CLI cannot do any of this, and refuses rather than trying: `omni db restore`
stops if a gateway is running against that installation, with no override. A
second process can reopen its own handle but cannot quiesce the gateway's, and
renaming the file under a live SQLite connection corrupts the database being
rescued.

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
  maint["<b>Maintenance</b><br/>every 1h"] --> maintJob["prune request_logs and usage_rollup at retention<br/>prune quota_samples at retention<br/>prune usage_daily at 400d<br/>prune body rows at retention, cap at 100k<br/>sweep artifact files with no row<br/>prune snapshots at retention<br/>sweep staging files older than 1h"]

  oauthJob -.-> oauth
  quotaJob -.-> quota
  maintJob -.-> maint
```

Setting `quotaPollIntervalMs` to zero disables the poller entirely; it is read
once at boot. Retiring the `pending` rows at startup is what stops a crash from
double-counting usage.

Body rows expire on the same sweep as the request logs they belong to, rather
than on a schedule of their own, so an artifact can never outlive its log line.
The row cap runs beside the window because the window bounds nothing: at
sustained load a seven-day retention over full traffic is unbounded in practice.
The orphan sweep exists because a crash between the file write and the row write
leaves a file nothing will ever come back for.

### Stopping and restarting

A signal and `POST /api/lifecycle/shutdown` reach the same teardown. They used to
be unable to: the server, the store, and the three loop stoppers are locals of the
bootstrap, so a handler defined anywhere else had nothing to stop. `createShutdown`
closes over them once, and both callers get the same shutdown — loops first,
because a timer that fires while the socket drains reaches a store that is about
to close, then the server, then the store, then exit. A second request while the
first is draining escalates, on the theory that the first one is evidently stuck.

The drain is bounded at five seconds. Bun stops a server by letting its
connections finish, and a shutdown asked for over HTTP arrives on one of them, so
the request that asked for the shutdown is itself a reason the shutdown cannot
complete — the gateway answered `ok` and then stayed alive until a second signal
escalated. A signal never hits this, because a shell holds no socket. On timeout
the process exits **0**: a nonzero code would read to `Restart=on-failure` as a
crash and resurrect a gateway an operator just asked to stop.

Restart is not shutdown, and what it takes depends on what is watching. The
capability is detected rather than assumed. `JOURNAL_STREAM` is systemd's own
statement that it is capturing this process, which beats looking for an installed
unit file — that says a unit exists, not that this process is the one it started —
and `MANAGERPID` distinguishes the user manager from the system one, because the
uid is wrong in both directions. Failing that, `/.dockerenv` means a container.
Failing both, nothing would respawn the process and restart is refused.

Under systemd the gateway asks the manager instead of signalling itself:

```
systemctl [--user] --no-block restart omnigateway.service
```

The unit the CLI installs sets `Restart=on-failure`, and a handled `SIGTERM` exits
zero, which systemd reads as success — a self-signalling gateway would stop and
stay stopped. `--no-block` is load-bearing: restarting the unit tears down its
whole cgroup, which contains the `systemctl` client just spawned, so a blocking
call is killed mid-wait while the queued job survives. Asking also fails better.
A refused `systemctl` is an ordinary error response from a gateway that is still
running and still serving, rather than a process that killed itself and hoped.

A container's restart policy is the one capability here that is a hope rather than
a fact — it is not readable from inside the container — so a restart is an exit
with code 0 and the console reports the uncertainty instead of promising. With no
supervisor at all `canRestart` is false, because `omni start` without a unit is a
detached spawn with a pidfile and nothing watching it. Shutdown stays available in
every shape; stopping is the point of it.

`describeLifecycle` is a pure function of the environment and one path probe,
which is what lets the console disable a control and print the reason rather than
letting an operator press it and find out.

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

Reading a captured body is one of those operations, not a route's own logic:
`readRequestBody` decides that a swept or undecryptable artifact is a state to
report rather than an error to raise, and the handler adds no error mapping that
could quote a path or a stack back. It carries no CLI command yet, which is the
only asymmetry between the two front ends. `GET /api/settings` additionally
reports `bodyLoggingAllowed` beside the settings, because the runtime toggle is
meaningless without the boot-time key and a console that knew only the setting
would render a switch that silently does nothing.
