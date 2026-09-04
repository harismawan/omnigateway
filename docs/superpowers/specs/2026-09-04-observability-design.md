# Observability: a scrape endpoint and request traces

Status: designed, not built.

Two surfaces, one subsystem. `GET /metrics` answers *how is this gateway doing right
now* in Prometheus exposition format. An OTLP span export answers *what happened to
this one request* in whatever APM the operator already runs. Both are off unless
configured, both are process-local, and neither may cost a request that would
otherwise have succeeded.

## Why the obvious approaches are wrong here

Three constraints in this repository rule out the shapes this normally takes, and
each one has already caused an outage or a refusal somewhere in the history below.

**A scrape must not read the store.** `bun:sqlite` is synchronous, so a query blocks
the whole event loop for its duration. The doc on `sumSince` in
`packages/store/src/types.ts` records the scan it replaced taking ten seconds at
eight million rows, and `CLAUDE.md` adds that this is why a timeout around a store
read cannot fire. A `/metrics` handler calling `usage.aggregate` would stall every
in-flight request on a fifteen-second timer, forever, and would look like a network
problem while doing it. The rule is absolute: **the scrape handler performs no store
read at all.** Everything it reports is already in memory.

**Nothing may add a header to a provider request.** `HttpRequest.headers` is an
ordered, case-preserved array, and `packages/providers/src/http-client.ts` goes out
of its way to write it verbatim — Bun's `fetch` sorts headers, which destroys the CLI
fingerprint some providers check, and `FINGERPRINT_REFUSED` in
`packages/router/src/breaker.ts` is the error code for when that goes wrong.
W3C trace context therefore propagates *inbound only*. The gateway joins a client's
trace; it never extends one to Anthropic.

**Fleet-wide and process-local numbers must not be mixed.** The concurrency gauge and
the `1m` ring live behind `packages/coord` and are shared across replicas; the load
registry's local map, the socket registry's stats and anything this process counted
itself are not. A scrape that reported both would make `sum() by (instance)`
multiply fleet-wide values by the replica count, and the resulting dashboard would be
wrong in a way that looks plausible. The rule: **every exported metric is
process-local.** The scrape handler never calls `coord`. Prometheus aggregates across
instances, which is what it is for.

## Where it lives

`apps/gateway/src/telemetry/`, not a new workspace package.

`packages/*` exist here because two consumers need them — `@omni/control` serves the
gateway and the CLI, `@omni/ir` serves the router and dispatch. Telemetry has one
consumer. A package for a single consumer is an interface with one implementation.

The discipline that would have come from being a package is kept anyway, so
promotion stays free: the registry performs no I/O, takes `now` as a parameter, and
holds no timer. The exporter — which owns the interval, the queue and the socket —
is a separate file, the way `packages/coord` keeps its memory implementation pure and
puts the Redis one in `apps/gateway/src/coord/redis.ts`.

```
apps/gateway/src/telemetry/
  registry.ts    counters, gauges, histograms; pure, `now` injected
  render.ts      registry -> Prometheus text exposition; pure
  spans.ts       span collection and the OTLP JSON encoding; pure
  otlp.ts        the bounded queue, the batch timer, the POST
  index.ts       wiring: one `Telemetry` object the gateway threads
```

## `GET /metrics`

### Access

Declared beside `/health` in `apps/gateway/src/app.ts`, before the `.use()` chain, so
it inherits the quiesce exemption — `isClientTraffic` returns false for it, and a
database restore must not blind monitoring at the moment it matters most.

The route **does not exist** unless `OMNI_METRICS_TOKEN` is set. Not 401, not 404
with a body explaining itself: unregistered. An install that has not opted in
presents no new surface at all.

When set, the scraper sends `Authorization: Bearer $OMNI_METRICS_TOKEN`. Comparison is
constant-time. A wrong token answers exactly like a missing one — 401, empty body —
for the same reason a wrong admin password answers like a failed login.

This is stricter than the Prometheus convention of an open `/metrics`, and
deliberately so: every route in this repository except `/health` and `/api/status` is
guarded, and a gateway behind a reverse proxy is reachable from more places than a
pod in a mesh.

### What it exposes

Labels are `provider`, `model`, `status`, `code`, `api_key_id`, `dimension`,
`window`, `kind`. Metric names are prefixed `omni_`.

| Metric | Type | Labels | Source |
|---|---|---|---|
| `omni_requests_total` | counter | provider, model, status, code, api_key_id | `finishLog` |
| `omni_request_duration_seconds` | histogram | provider, model | `log.durationMs` |
| `omni_ttft_seconds` | histogram | provider, model | `log.ttftMs`, streaming only |
| `omni_tokens_total` | counter | provider, model, api_key_id, kind | `finishLog` |
| `omni_cost_usd_total` | counter | provider, model, api_key_id | `finishLog` |
| `omni_upstream_duration_seconds` | histogram | provider | `nodeHttpClient` |
| `omni_inflight` | gauge | provider | `loadRegistry` local map |
| `omni_breaker_open` | gauge | provider | observed at `persistHealth` |
| `omni_ratelimit_rejected_total` | counter | dimension, window | limiter refusals |
| `omni_stream_connections` | gauge | — | `registry.stats()` |
| `omni_stream_queued` | gauge | — | `registry.stats()` |
| `omni_stream_dropped_total` | counter | — | `registry.stats()` |
| `omni_coord_fallback` | gauge | — | `coord.healthy()` |
| `omni_metrics_series_folded_total` | counter | — | the cardinality cap |
| `omni_otlp_spans_dropped_total` | counter | reason | the export queue |
| `omni_build_info` | gauge | version | constant 1 |

`kind` on `omni_tokens_total` is `input`, `output`, `cache_read`, `cache_write` —
the four disjoint classes `Usage` already prices separately. `Usage.inputTokens` is
*uncached* input, so the four sum to the billable total and no member double-counts
another. A dashboard wanting total prompt tokens sums `input` and both cache classes,
which is what `promptTokens()` does in code.

`omni_breaker_open` is recorded when this process *observes* a transition at
`persistHealth`, never read back from the store on scrape. A replica that has not
served a request for a credential reports nothing for it, which is honest: it has
not seen one.

`omni_inflight` reads `loadRegistry`'s **synchronous local map**, not its
`counts()`, which returns `max(local, remote)` and folds in a `coord.gauge.snapshot`
that is one round trip stale by construction. `counts()` is the right answer for
ranking a candidate and the wrong one for a scrape: it would report fleet-wide load
under a per-instance label. This is the process-local rule biting the one metric
where the fleet-wide value is sitting right there and looks better.

`omni_coord_fallback` reads the same in-process health flag `/health` already
reports — `"healthy" in coord && !coord.healthy()` — which is a boolean this process
maintains after its own failures, not a call across the network. It is a statement
about *this replica's* view of coordination, which is what an operator needs to see
per instance.

Three counters are deliberately about the telemetry itself. A subsystem that can
drop data and does not say so is worse than one that is absent.

### Cardinality

`api_key_id` on request, token and cost metrics makes the series count grow with
every key minted — `keys × models × status`. Unbounded, one script minting keys turns
the operator's Prometheus into the outage.

The registry tracks distinct label-sets against `OMNI_METRICS_MAX_SERIES`, default
5000. Past the cap, **new keys fold to `api_key_id="other"` rather than being
dropped**: totals stay arithmetically correct, attribution degrades. Every fold
increments `omni_metrics_series_folded_total`, so the degradation is visible on the
same scrape that suffers it.

Fold, not drop, because a missing series and a zero series look identical in a graph,
while a fat `other` bucket is a question an operator will ask.

`model` is bounded by the catalog and `provider` by the descriptor table, so neither
needs a cap. `code` is the closed `ErrorCode` union.

## Traces

### The collection problem, and why nothing is threaded

The natural implementation gives dispatch a tracer and threads it through routing,
attempts, adapters and the HTTP client. That is precisely the shape of this
repository's most repeated bug — `CLAUDE.md` names it: *"Registry threaded into some
of the call graph, not all, is this repository's most repeated bug, and the sweep
that keeps failing."* It has its own sentinel test in
`apps/gateway/test/cluster/sharedCoord.test.ts` because threading `coord` failed the
same way. A tracer would need a second such test and would eventually fail it.

`AsyncLocalStorage` avoids the threading and fails a different rule: every side
effect in this codebase is injected, and ambient context is the opposite of that.

**So nothing is threaded.** The request already accumulates everything a span tree
needs, on an object that already reaches every site that has a timing worth
recording. `proxy.ts` mints `requestId` and `startedAt`; dispatch sets `log.ttftMs`
at the stream commit point and knows each attempt's provider, model and credential;
`nodeHttpClient` already computes a per-call `durationMs` for its debug line.

A `spans: SpanRecord[]` array hangs off the per-request log object. Each site that
already has a start and an end pushes one flat record:

```ts
type SpanRecord = {
  id: number;                // index into the array; assigned on push
  parent: number | null;     // null for the root
  name: SpanName;            // closed union, below
  startMs: number;           // relative to the request's startedAt
  endMs: number;
  attrs: SpanAttrs;
};
```

`parent` is an index, not a name. A failover produces several `dispatch.attempt`
records, so naming the parent would leave `provider.http` unable to say *which*
attempt it belonged to — and the whole point of tracing a failover is seeing the dead
account's latency attributed to the attempt that spent it. Indices are assigned on
push and converted to OTLP span ids once, at flush.

`finishLog` emits the batch. That function is already documented as *the one place
that runs exactly once per request id, on both the success and the error path* —
which is why `usage.append`, the rate-limiter debit and the plugin emit all hang off
it. A span flush inherits the same guarantee rather than re-establishing it, and sits
in a `try` of its own beside the body write, for the reason the body write is in one:
the row is the record every operator relies on, and an optional export must not be
able to cost them one.

No new injection point. No pure package touched. The spans ride the object the
timings already ride.

### The tree

| Span | Parent | Attributes |
|---|---|---|
| `gateway.request` | — | surface, requested_model, api_key_id, status, code |
| `dispatch.route` | request | candidates, chosen_provider, chosen_model |
| `dispatch.attempt` | request | attempt, provider, model, credential_id, code |
| `provider.http` | attempt | provider, host, path, status |
| `stream.commit` | attempt | provider, model |

One `dispatch.attempt` per candidate tried, so a failover renders as siblings and the
waterfall shows the dead account's latency before the live one's — which is the
picture an operator wants and cannot currently get.

`provider.http` measures the response *head*, not the body drain, because that is
what the choke point measures. The span is named and documented so a stream's total
time is read from `stream.commit` and the request span, not mistaken for this one.

Span status is `ERROR` when `classify()` produced an `ErrorCode`, and carries the code
as an attribute.

### Attributes are a closed allowlist

`SpanAttrs` is closed the way `LogFields` is closed, and for the same reason: it is a
redaction boundary, and a free-text attribute is a place a prompt or a token ends up.
`CLAUDE.md` records that `fields?: LogFields` did **not** enforce this — excess
property checking applies only to a fresh literal, so a conditional spread walked
straight past it — and that the fix was
`<T extends LogFields>(msg, fields?: OnlyLogFields<T>)`, pinned with `@ts-expect-error`
in `packages/ir/test/logFields.test.ts`.

`SpanAttrs` takes the same treatment, with the same `OnlyLogFields`-shaped generic and
the same style of test. Adding a member is a security change.

Any attribute that could carry an upstream message is gated by the existing
`gatewayAuthored` rule — `reasonField` withholds a failure's message unless debug is
on, because `httpError` fills one from up to 500 characters of upstream body. A span
attribute is stdout with extra steps and gets the same gate.

### Trace context

Inbound only. If the request carries a well-formed W3C `traceparent`, the gateway
adopts its trace id and parents `gateway.request` to the incoming span id, so a
client's trace and the gateway's are one trace. Malformed values are ignored, not
rejected — an unparseable header is not grounds for failing an inference request.

Nothing is added to any outbound provider request. See the header constraint above.

### Export

Enabled by `OMNI_OTLP_ENDPOINT`. Spans are encoded as OTLP/HTTP JSON and POSTed to
`$OMNI_OTLP_ENDPOINT/v1/traces`, which every collector accepts — Jaeger, Tempo,
Honeycomb, Datadog and Grafana Alloy among them. `OMNI_OTLP_HEADERS` carries an API
key where the backend needs one.

The queue is bounded and drop-counted, the way the plugin broadcast burst and the
socket registry's per-connection queue are: a batch timer drains up to
`OTLP_BATCH_MAX` spans; a full queue drops the newest and increments
`omni_otlp_spans_dropped_total{reason="queue_full"}`. Encoding failures are counted
separately under `reason="encode"`, because they are a different diagnosis and a
different line.

The POST is plain `fetch`, not `HttpClient`. That seam exists to hold provider
fingerprint discipline and belongs to `packages/providers`; a collector is not a
provider. The `/health` watcher is the existing precedent for a plain `fetch` in this
codebase.

Failure is fire-and-forget and logged at most once per interval through existing
`LogFields` keys. A collector being down must be invisible to every client.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `OMNI_METRICS_TOKEN` | unset | Registers `/metrics`. Unset, the route does not exist. |
| `OMNI_METRICS_MAX_SERIES` | 5000 | Cardinality cap before `api_key_id` folds to `other`. |
| `OMNI_OTLP_ENDPOINT` | unset | Enables span export. Unset, no spans are collected. |
| `OMNI_OTLP_HEADERS` | unset | `k=v,k=v` sent with each batch, for backends needing a key. |
| `OMNI_TRACE_SAMPLE` | `1.0` | Head sampling ratio. An inbound `sampled` flag is honoured. |

Both surfaces default off. An install that upgrades into this version has no new
route, no new outbound origin, and no new allocation on the request path — when
`OMNI_OTLP_ENDPOINT` is unset, `spans` is never allocated and the push sites are a
single null check.

`README.md`'s security section says the gateway talks to your providers and to nobody
else. That sentence needs a clause: and to your collector, if you name one.

## Failure posture

Stated as invariants, because each is a way this could cost an operator a request:

1. The scrape handler performs **no store read**. Pinned by a test that injects a
   store throwing on every read and asserts the scrape still returns 200.
2. The scrape handler **never calls `coord`**. Every metric is process-local.
3. Span collection **never throws**. Every push site is inside the collector, which
   swallows and counts.
4. Span export **never blocks a request**. The queue is bounded; a full queue drops.
5. `finishLog` keeps its existing contract — it never throws — and the flush sits in
   its own `try` so a broken collector cannot cost an operator a `request_logs` row.

## Testing

At the narrowest stable boundary, per the repository's convention.

- **Exposition format.** Render a registry with known counters and assert the text,
  including `# HELP`/`# TYPE` lines and label escaping. A stored `model` string
  reaches this output, so quote and backslash escaping is a correctness test, not a
  cosmetic one — the same reasoning `providerColor` follows on the dashboard side.
- **No store read on scrape.** Store stub that throws on every method; scrape; expect
  200 and a body. This is the test that catches the regression that matters most.
- **No coord read on scrape.** Same shape, coord stub that throws.
- **Cardinality fold.** Cap of 3, four keys; assert the fourth folds to `other`, that
  totals across all series still sum correctly, and that the fold counter moved.
- **Span tree on failover.** One request, first candidate rate-limited, second
  succeeds. Assert two sibling `dispatch.attempt` spans, correct parents, and that the
  first carries the rate-limit code.
- **Span tree on post-commit failure.** The commit point is the failover cutoff, so
  assert `stream.commit` exists and no third attempt follows it.
- **Traceparent join.** Valid header adopts the trace id; malformed header is ignored
  and the request still succeeds.
- **Attribute allowlist.** `@ts-expect-error` on a non-member, mirroring
  `packages/ir/test/logFields.test.ts`.
- **Queue bound.** Fill past capacity, assert drops counted and no throw.
- **Auth.** Absent env means no route; wrong token means 401 with an empty body;
  correct token means 200. Constant-time comparison asserted by inspection, not
  timing.
- **Off by default.** Boot with neither variable and assert no `/metrics` route and no
  span allocation on a served request.

## Open questions

None blocking. Two worth revisiting after it ships:

- Whether `omni_inflight` should also be published per credential. It is available,
  but credential ids in a shared Prometheus are a wider audience than key ids, and the
  operator asked for key-level attribution, not account-level.
- Whether a future `omni doctor` check should warn when `OMNI_OTLP_ENDPOINT` names an
  origin no plugin declared. Plugins declare outbound origins; the gateway itself
  would now have one that nothing audits.

## History

The per-key label decision was made against the alternative of coarse labels only.
Coarse labels keep the series count flat as keys are minted and keep key identity out
of whatever scrapes the gateway; per-key labels were chosen anyway, for spend
attribution in Grafana. The cardinality cap exists because that choice is the one that
can hurt, and folding rather than dropping exists because a missing series is
invisible where a fat `other` bucket is a question.

The threading decision was made against a tracer in `DispatchDeps`. It was rejected on
the record of `coord`, which needed a dedicated sentinel test after being threaded
into some of the call graph and not all, and of the six module-scope
`Object.keys(PROVIDER_DESCRIPTORS)` snapshots that the same class of mistake produced.
Collecting from the object that already carries the timings avoids the category.

Outbound trace propagation was designed in and then removed, on finding that
`http-client.ts` preserves header order and case specifically because Bun's `fetch`
sorts them and providers fingerprint the result.
