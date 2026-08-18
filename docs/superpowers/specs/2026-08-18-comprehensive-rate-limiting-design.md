# Comprehensive Rate Limiting Design

## Goal

Give an operator enough control over an API key to bound what it can do per minute, per five hours,
and per week — in requests, tokens, and dollars — and tell the client enough that it can back off
without being told twice.

Today the whole mechanism is thirty-eight lines. `ApiKeyRateLimiter`
(`apps/gateway/src/auth/rateLimit.ts:8`) counts requests per key in a fixed sixty-second window held
in a process-local `Map`, and `proxy.ts` consumes from it at two sites (`:299`, `:594`). That is one
dimension, one window, no persistence, and no client-facing signal beyond a 429 whose `retryAfterMs`
lives in the error body where no SDK looks for it.

Three consequences follow, and each is a thing an operator hits in practice:

- **The window boundary is a hole.** `Math.floor(now / WINDOW_MS) * WINDOW_MS`
  (`apps/gateway/src/auth/rateLimit.ts:18`) resets the count on a clock edge, so a key with a limit
  of 60 can send 60 requests at `T+59s` and 60 more at `T+61s` — 120 requests in two seconds, twice
  the configured ceiling, with no rule broken.
- **A minute is the only horizon.** Requests-per-minute says nothing about the agent loop that has
  been running for four hours, or the key that burned three hundred dollars over a weekend. The
  costly failures are slow, and a per-minute limiter cannot see them.
- **The client is told nothing until it is too late.** No `Retry-After` header, no
  `anthropic-ratelimit-*`, no `x-ratelimit-*`. A client learns it is near a limit by crossing it.

This design replaces the limiter with a sparse matrix of `(dimension, window)` limits, evaluated by
a pure package, counted from state that already exists, and reported in each client surface's own
header dialect.

## Scope

In scope: the limit model and its storage, a new `packages/ratelimit` evaluator, sliding-window
counting for all windows, enforcement across the three `/v1` surfaces, per-surface rate-limit
headers, and the CLI and console surfaces to read and edit limits.

Out of scope, deliberately:

- **Admin and `/api/*` rate limiting, including the login throttle.** Considered and cut. Every
  mechanism there needs a client identity, the gateway has none — there is no `x-forwarded-for`
  handling anywhere in the codebase — and `OMNI_BASE_URL` is required to be the public reverse-proxy
  origin, so the socket peer is normally the proxy. Building it correctly means a trusted-proxy CIDR
  setting and a forwarded-header parser, which is a security surface of its own and unrelated to
  bounding API-key traffic. It stays a separate design. Nothing here adds partial IP handling that a
  later design would have to unpick.
- **Installation-wide default limits.** Limits are per-key. An unset limit is unlimited, exactly as
  today. Defaults would introduce an inherit-versus-explicitly-unlimited distinction that has to be
  representable, migrated, and explained, and it buys nothing on an install where keys are minted by
  hand.
- **A `spend` limit at one minute.** A per-minute dollar ceiling is a rate limit in costume;
  `requests` and `tokens` already shape burst at that horizon. Spend is a budget, and budgets are
  measured in hours and weeks.
- **A one-day window.** `usage_daily` remains the reporting rollup. Every added window is another
  cached counter and another rendered header, and 5h/1w already bracket the horizons that matter.
- **Distributed or multi-process limiting.** The gateway is one process. In-memory state is stated
  as process-local wherever it is, not apologised for.
- **Enforcing provider-side quota.** `quota_windows` holds provider observations and is untouched
  here. A provider's quota and a gateway key's limit answer different questions and must not be
  conflated — see "Relationship to quota cooldowns".

## The limit model

A limit is a `(dimension, window)` pair. Not every pair is meaningful, so the matrix is sparse:

| Dimension     | 1m  | 5h  | 1w  | Enforcement                                |
| ------------- | --- | --- | --- | ------------------------------------------ |
| `requests`    | yes | yes | yes | 1m pre-flight and exact; 5h/1w on completion |
| `tokens`      | yes | yes | yes | Post-hoc debit; overshoots by ≤1 request   |
| `spend` (USD) | —   | yes | yes | Post-hoc debit, priced from `cost_usd`     |
| `concurrency` | instantaneous gauge  ||| Pre-flight increment, `finally` decrement  |

`tokens` is the awkward one and the shape of the compromise should be explicit: an exact token count
exists only after a response completes. A token limit therefore admits a request based on usage
already recorded, and debits the request's own usage afterwards. A key at its ceiling is refused on
its *next* request, not its current one. The overshoot is bounded by one request per limit and is
inherent to the dimension — pre-estimating from `count_tokens` would trade a bounded, understood
overshoot for an unbounded, silent inaccuracy on output tokens, which cannot be estimated at all.

`requests` splits across its windows, which the table above compresses. At `1m` the count is an
exact in-memory ring and the check is genuinely pre-flight. At `5h` and `1w` it derives from
`sumSince`, which counts committed rows only — so an admission recorded into the in-memory delta and
then pruned before its row landed would be counted in neither place, and under-counting is the one
direction this design must never take. Long-window request counts therefore debit on completion like
tokens and spend.

The consequence is that a burst of N concurrent requests can overshoot a long request ceiling by up
to N. That is exactly what `concurrency` bounds, and it is why the gauge is not optional garnish.

`concurrency` is not a window. It is a gauge: in-flight requests for this key, right now. It exists
because the other dimensions cannot see a runaway agent loop that opens forty streams and holds
them — that is one request per stream, few tokens so far, and no dollars yet.

## Storage

Limits live in one JSON column, validated on read and write.

Migration `009_key_limits.sql`:

```sql
ALTER TABLE api_keys ADD COLUMN limits TEXT NOT NULL DEFAULT '{}';

UPDATE api_keys
   SET limits = json_object('requests', json_object('1m', rate_limit_per_min))
 WHERE rate_limit_per_min IS NOT NULL;

ALTER TABLE api_keys DROP COLUMN rate_limit_per_min;

CREATE INDEX idx_request_logs_key_at ON request_logs (api_key_id, at DESC);
```

The stored shape:

```jsonc
{
  "requests": { "1m": 60, "5h": 2000, "1w": null },
  "tokens": { "1m": 100000, "5h": null, "1w": 50000000 },
  "spend": { "5h": null, "1w": 25.0 },
  "concurrency": 8
}
```

An absent key and an explicit `null` both mean unlimited. Because limits are per-key with no
inheritance, nothing distinguishes the two and nothing needs to.

### These JSON keys are a storage contract

The dimension and window names are persisted in every row. This is the same class of hazard as
`RTK_FILTER_IDS`, which `CLAUDE.md` already calls out: adding a name is free, renaming or removing
one loses data. Unlike `isRtkFilterId`, which drops unknown ids silently on read, an unknown limit
key is a **parse failure**, not a silent drop — a limit the gateway cannot understand must never be
read as "no limit", because that fails open on a control the operator explicitly set. Unknown keys
are rejected by the zod schema.

**Where that failure lands matters as much as that it happens.** `ApiKey.limits` is
`LimitConfig | null`: `{}` means no limits configured, `null` means the stored value could not be
parsed. They are distinct types, so strict TypeScript forces every consumer to tell them apart
rather than letting a broken key quietly read as unlimited.

The failure is then **refused at authentication and tolerated everywhere else**. A malformed key is
rejected at `apps/gateway/src/auth/apiKey.ts`, the single chokepoint every `/v1` request passes, with
`INTERNAL` rather than `AUTH` — the client's credentials are fine and no retry will help; it is the
operator's configuration that is unreadable. But `keys.list()` still returns every key, with the
broken one marked.

Throwing inside the row parser was implemented first and rejected. Because that parser serves both
`list()` and `findByHash()`, one malformed row locked the operator out of seeing *any* of their keys
in the console, leaving no way to identify or repair the offending one short of hand-editing SQL.
Failing closed at the point of enforcement is a safety property; failing closed at the point of
*diagnosis* is just a locked door.

### The index is load-bearing

`request_logs` currently indexes `(at DESC)`, `(credential_id, at DESC)`, and a partial index on
pending state (`packages/store/src/sqlite/migrations/001_init.sql:81-82`,
`004_request_state.sql:18`). Nothing leads with `api_key_id`. A weekly sliding sum for one key
against `idx_request_logs_at` scans every row in the week for every key on the install.

`idx_request_logs_key_at` is therefore a correctness-adjacent requirement, not an optimisation, and
it must not be dropped later as redundant with `idx_request_logs_at`. Composite order matters:
`(api_key_id, at DESC)` allows the range scan to start at the key; `(at DESC, api_key_id)` does not.

### One new repo method

`UsageRepo` (`packages/store/src/types.ts:644-673`) has `aggregate`, `recent`, `prune`, and
`pruneDaily`. `aggregate` groups by reporting dimension and is the wrong shape and the wrong cost
for a hot-path check. Added:

```ts
sumSince(apiKeyId: string, sinceMs: number): { requests: number; tokens: number; costUsd: number };
```

**Pending rows must be excluded.** `CLAUDE.md`: *"Pending rows contain placeholder metrics; inspect
`state`, not `status`."* A sum that omits `WHERE state = 'done'` adds placeholder metrics for every
in-flight request into every 5h and 1w count, inflating them invisibly and increasingly under load —
which is exactly when the limiter matters. This filter gets its own test.

`tokens` sums `input_tokens + output_tokens + cache_read_tokens + cache_write_tokens`. All four are
tokens the key caused to move; `Usage.inputTokens` being uncached input (per `CLAUDE.md`) means the
four columns are disjoint and summing them double-counts nothing.

## `packages/ratelimit`

A pure leaf package, structured exactly like `rtk` and `router`: no I/O, no clocks, no randomness,
`now` is a parameter.

- `@omni/ratelimit` — the evaluator.
- `@omni/ratelimit/catalog` — the `Dimension` and `Window` unions, `LimitConfig`, and its zod schema.
  `@omni/store` imports **this subpath alone** and re-exports `LimitConfig` from `@omni/store/types`,
  which is the import the dashboard is already permitted (boundary rule 12). This mirrors the
  `@omni/rtk/catalog` arrangement in rule 13 rather than inventing a second pattern.

One function carries the design:

```ts
evaluate(config: LimitConfig, counters: CounterSnapshot, now: number): Decision
```

`Decision` reports the violated limit if any — dimension, window, configured limit, observed usage,
and reset time — plus per-dimension `remaining` and `resetAt` for the header renderers. The gateway
supplies `counters`; the package never learns where they came from.

That split is the point. The sliding-window arithmetic is the load-bearing logic and it becomes
unit-testable without gateway scaffolding, a store, or a clock. Given this repo's standing position
that a green suite is not evidence of coverage, arithmetic that can be mutation-tested cheaply is
arithmetic that will be.

## Counting

All windows are sliding. A fixed window is what produces the 2x-burst hole described in the Goal,
and it produces the same hole at every size — a fixed weekly window would let a key spend two weeks'
budget across a Sunday midnight.

Counts are assembled per dimension from two sources:

- **1m: exact, in memory.** A ring of timestamps per key. At sixty requests per minute this is sixty
  numbers. Precision is free at this size, so it is not approximated.
- **5h and 1w: `sumSince(key, now - window)` plus the in-memory delta since that read.** The store
  side is a real range sum and therefore exactly sliding as of its read; the delta covers everything
  after it.

### The error direction is chosen, not incidental

The composition has one bounded inaccuracy: events that **age out** of the window between the cached
read and now are not subtracted. The count therefore runs slightly **high**, never low.

Concretely, a 1w limit with a 30s cache can include traffic from a 30s slice one week stale. It
fails toward denying early, never toward letting a key past a ceiling its operator set. A limiter
whose error runs the other way can be walked through by timing the cache refresh, which is a
property an attacker can discover and exploit and an operator cannot.

Cache TTL is 30s for the 5h and 1w windows. A key whose usage is within 10% of any long-window
ceiling reads through eagerly on debit instead of waiting out the TTL, so precision rises exactly
where a decision is close and an idle key costs nothing.

### Store read failure fails open, loudly

If `sumSince` fails or times out, the request is served and a structured event is logged.

The reasoning is proportionality. This is a self-hosted gateway; a transient store fault that 429s
all traffic is a worse outage than briefly under-enforcing a weekly budget. Crucially, the limits
that stop abuse *fastest* — `requests` at 1m and `concurrency` — are pure memory and keep enforcing
exactly through the fault. Only the slow budget ceilings degrade, and only while the store is down.

The event uses existing `LogFields` keys. `LogFields` is a closed allowlist and a redaction boundary;
nothing here adds a free-text field to it.

## Enforcement

Three hooks. Two are traps.

**Pre-flight**, replacing `rateLimiter.consume()` at `proxy.ts:299` and `:594`, and added at
`count_tokens`. Limits arrive on the key row from auth, so there is no extra lookup. Build the
snapshot, `evaluate()`, and on allow increment the requests ring and the concurrency gauge. On deny,
`GatewayError("RATE_LIMIT", …)` carrying which limit was violated and its reset.

`count_tokens` counts against `requests` only — never `tokens`, never `spend`. It performs no
dispatch, so it consumes no upstream tokens and costs nothing; charging it against a token budget
would bill an operator for a local estimate.

**Debit**, inside `usage.append` (`packages/store/src/sqlite/usage.ts:258`, called from
`apps/gateway/src/logging.ts:197`). Not a new callback. `CLAUDE.md` already guarantees append runs
at most once per request ID and warns that a duplicate double-counts `usage_daily`. A second
lifecycle hook beside it would need that guarantee re-established; a debit inside it inherits it.
Tokens and `costUsd` debit here.

**Concurrency decrement**, in a `finally` at request scope and nowhere else.

This is the worst failure available in this design and it fails silently. If the decrement lived
beside the debit, a client that disconnects mid-stream would never reach it, the gauge would leak by
one, and after N aborts the key is locked out **permanently** — no window expiry rescues a gauge,
and no error is raised. It therefore gets dedicated tests on both cancellation paths the repo
already distinguishes: gateway deadline versus client cancellation, per the existing rule that
deadline tests separate the two and leave no timers or listeners behind.

The gauge is process-local and resets on restart. For concurrency this is *correct* rather than a
compromise: in-flight requests die with the process, so a surviving count would be the bug.
Per-window in-memory deltas are also process-local, but the long windows rehydrate from the store on
the next read, so a restart costs at most the delta since the last cache read.

## Headers

Each client surface gets its own dialect, because each vendor's SDK already parses its own and will
back off automatically without a line of client code.

On `/v1/messages`, rendered beside the existing Anthropic error shapes in
`apps/gateway/src/egress/anthropic.ts`:

```
anthropic-ratelimit-requests-limit: 2000
anthropic-ratelimit-requests-remaining: 1841
anthropic-ratelimit-requests-reset: 2026-08-18T14:32:07Z
anthropic-ratelimit-tokens-limit: 50000000
anthropic-ratelimit-tokens-remaining: 48120334
anthropic-ratelimit-tokens-reset: 2026-08-18T14:32:07Z
```

On `/v1/chat/completions`, in `apps/gateway/src/egress/openai.ts`:

```
x-ratelimit-limit-requests: 2000
x-ratelimit-remaining-requests: 1841
x-ratelimit-reset-requests: 4h51m22s
x-ratelimit-limit-tokens: 50000000
x-ratelimit-remaining-tokens: 48120334
x-ratelimit-reset-tokens: 4h51m22s
```

Both surfaces send `Retry-After` in seconds on a 429. This is the gap that exists today: the 429
already carries `retryAfterMs`, but in the error body, where no SDK looks.

**A long window's reset is computed exactly, and only when refusing.** In the allow path a long
window reports `now + windowMs`, because the true instant it frees a slot needs the oldest retained
row's timestamp and that is a second query. Overstating is the safe direction there — nobody acts on
it. But a `Retry-After` is acted on: a client refused one request over a weekly ceiling would be
told to stop for seven days when a slot may free in an hour, and a well-behaved SDK would obey.

So the deny path queries the oldest row inside the window and reports the truth. A 429 is by
definition the path where nothing is being served, so the extra read costs nothing that matters and
never touches the hot path.

**Which window is reported.** A key may have three windows per dimension and there is one header per
dimension. The reported window is the one **nearest exhaustion by proportion** — the one that will
deny first. Reporting the shortest window unconditionally would show a comfortable per-minute figure
to a key that is one request from its weekly ceiling.

`spend` and `concurrency` get no headers. Neither vendor defines one, and inventing
`x-ratelimit-remaining-dollars` puts a number no client parses into every response.

Plumbing threads through three sites in `proxy.ts`: `jsonResponse()` (`:116`), `SSE_HEADERS` /
`sseResponse()` (`:98`, `:212`), and `errorResponse()` (`:123`). Streaming responses carry the
headers computed at pre-flight, since the response head is sent before usage is known.

## Three unrelated things are called a rate limit

Naming collision worth fixing in the reader's head before it is fixed in a debugging session. The
codebase has three mechanisms with "rate limit" in the name, at three different scopes:

| Name                                   | Scope               | Set by                | This design |
| -------------------------------------- | ------------------- | --------------------- | ----------- |
| `api_keys.limits` (was `rate_limit_per_min`) | Gateway API key | Operator              | Replaced    |
| `credential_health.rate_limited_until` | Provider credential | Upstream `Retry-After` | Untouched   |
| `RATE_LIMIT_COOLDOWN_MS`               | Quota probe loop    | Constant, 180s        | Untouched   |

Only the first is a policy an operator authors. The second is the router recording that a provider
refused us and routing around it (`packages/store/src/sqlite/migrations/001_init.sql:27`). The third
throttles the gateway's own polling of a usage endpoint. A change to any one of them must not be
assumed to affect the others, and the shared `RATE_LIMIT` error code does not make them the same
mechanism.

## Relationship to quota cooldowns

These are separate mechanisms and must stay separate. `RATE_LIMIT_COOLDOWN_MS`
(`packages/control/src/quota/poll.ts:19`) throttles the gateway's own probes of a provider's usage
endpoint, and `quota_windows` holds a provider's report of a credential's consumption. Both are
about a *provider credential*. This design is about a *gateway API key*.

The existing rule that missing quota data means unknown rather than unlimited, and that a probe
failure never disables a credential, is untouched. No limit defined here consults `quota_windows`,
and no quota observation adjusts a key's limits.

## CLI

```
omni keys create --label L [--limit requests:1m=60] [--limit spend:1w=25] …
omni keys limits <id>                       # show configured limits and current usage
omni keys limits <id> --set tokens:1w=50000000
omni keys limits <id> --unset spend:5h
```

`--rate-limit N` is **removed**, not aliased. One syntax for limits, no second spelling of the same
setting to keep working, document, and test. A script passing it fails immediately with an unknown
flag rather than silently taking a deprecated path — a loud break on a flag with a one-line fix
beats a quiet one that outlives the release that introduced it.

Limits are **editable after creation**, unlike `bodyLoggingOptOut`, which is creation-only. The
distinction is deliberate and worth stating: an opt-out is a promise to whoever holds the key and
must not be revocable behind their back. A limit is the operator's own ceiling on their own
installation, and a weekly spend cap that cannot be adjusted without minting a new key and
redeploying every client is a cap that will be set to `null` instead.

`omni keys list` shows a compact summary; the full matrix needs `omni keys limits <id>`.

## Dashboard

`KeysBoard.tsx:111` currently renders `rateLimitPerMin` as a single cell. It becomes a summary — the
count of configured limits and the one nearest exhaustion — with the matrix behind a disclosure,
following the precedent set by quota history: a table per key is not what an at-a-glance board is
for.

`MintKeyDialog.tsx` gains the matrix as an optional section, collapsed by default, so minting a key
with no limits stays a two-field operation. A separate edit dialog reaches the same component.

Usage bars use the existing `Meter` and its established tones (green below 70%, amber 70–90%, red at
or above 90%) rather than a new scale. Colour continues to mean provider identity or state only.

## Staged rollout

Three branches, each shippable and reviewable on its own.

1. **Engine and parity.** `packages/ratelimit`, migration `009`, `sumSince`, the index, and the
   1m sliding window replacing the fixed one. Behaviour visible to operators: the boundary hole
   closes. No new dimensions.
2. **Dimensions and windows.** Tokens, spend, concurrency; the 5h and 1w windows; the cache and its
   eager-refresh rule; fail-open handling. This is where the debit hook and the `finally` land.
3. **Surfaces.** Headers on both dialects and `Retry-After`; CLI and console.

Stage 1 alone is a real improvement, which is the test of whether the split is honest.

## Testing

Behaviour tests at the narrowest stable boundary, per the repo's standing preference.

`packages/ratelimit`, pure and clock-free:

- A key at exactly its limit is allowed; one over is denied. Both directions, every dimension.
- Sliding windows do not admit a 2x burst across a boundary — the specific regression this design
  exists to fix, written against the old fixed-window behaviour so it fails on a revert.
- `evaluate` reports the window nearest exhaustion by proportion, not the shortest.
- Absent limit and explicit `null` both mean unlimited; an unknown dimension or window key is a
  parse failure, never an unlimited read.

Store:

- `sumSince` excludes `state = 'pending'` rows. Seeded with pending rows carrying deliberately
  absurd placeholder metrics, so an unfiltered implementation fails loudly rather than by a margin.
- `sumSince` sums all four token columns without double-counting.
- Migration `009` backfills `rate_limit_per_min` into `requests["1m"]`, including the `NULL` case.

Gateway:

- Concurrency decrements on normal completion, on gateway deadline, and on client cancellation
  mid-stream — the last asserted by draining the gauge to zero after an aborted stream, and by
  leaving no timers or listeners behind.
- Token and spend debits happen exactly once per request ID; a duplicate `usage.append` does not
  double-debit.
- A failing `sumSince` serves the request, logs the event, and still enforces 1m and concurrency.
- Both surfaces: headers on non-streaming success, streaming success, and 429; `Retry-After` present
  on 429; Bearer and `x-api-key` both reach the same limiter.
- `count_tokens` consumes `requests` and never `tokens` or `spend`.

Every assertion above is mutation-tested — the anchor is broken and the test confirmed to fail —
because a test existing is not the behaviour being covered. Priority order for mutation runs: the
sliding-window arithmetic, the pending-row filter, and the concurrency `finally`.

## Consequences

- `rate_limit_per_min` leaves the schema. Anything reading that column directly breaks at compile
  time, which is the intent; `ApiKeySummary` carries the new shape.
- **`omni keys create --rate-limit N` is a breaking CLI change.** The flag is removed outright, so a
  script using it exits with an unknown-flag error until it is changed to
  `--limit requests:1m=N`. This is the only breaking change in the design and it warrants a release
  note. `rateLimitPerMin` also leaves the `/api/keys` request and response bodies, which is internal
  — the dashboard ships with the gateway that serves it.
- The limit JSON keys join `RTK_FILTER_IDS` as a persisted vocabulary. `CLAUDE.md` gains a line
  under "Runtime and data traps" saying so.
- Long-window limits are only as accurate as `request_logs` retention. A key with a 1w limit on an
  install pruning logs at 3 days silently enforces a 3-day window. `omni doctor` reports the
  conflict; the spec does not attempt to prevent the configuration.
- `idx_request_logs_key_at` adds write cost to every request log insert and disk to every snapshot.
- Nothing here bounds admin surface abuse. That gap is now explicit rather than incidental, and is
  the subject of its own design.
