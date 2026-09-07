# Credential health: observe on every request, save on a schedule

## Problem

Every completed request writes a `credential_health` row before it is allowed to finish.
`persistHealth` (`apps/gateway/src/dispatch/index.ts:394-411`) is awaited at three sites, and
one of them is the success path:

| Site | Path | Position |
| --- | --- | --- |
| `dispatch/index.ts:717` | stream ended cleanly → `recordSuccess` | awaited **before** `log.status = 200` |
| `dispatch/index.ts:797` | attempt threw → `recordFailure` | awaited **before** the failover decision at `:809` |
| `dispatch/index.ts:672` | streaming rejection frame → `recordFailure` | awaited after the terminal frame reached the client |

On SQLite this is 16.4µs of synchronous `db.transaction()` and costs nothing worth naming.
On Postgres the same call is `sql.begin` wrapping three statements
(`packages/store/src/postgres/credentials.ts:314-338`):

```
pg_advisory_xact_lock(hashtext('<credentialId>|<model>'))
SELECT * FROM credential_health WHERE credential_id = $1 AND model = $2 FOR UPDATE
INSERT … ON CONFLICT DO UPDATE
```

With `BEGIN`/`COMMIT` that is roughly six sequential round-trips holding one advisory lock,
and the lock is keyed on `(credentialId, model)`. Every replica's every request through one
credential therefore queues on one lock, at a throughput of about `1 / (6 × RTT)` — near
170/s on a 1ms LAN, near 30/s across an availability-zone boundary. **This is a fleet-wide
ceiling per credential, and it applies to successful traffic, not to errors.**

The same mechanism degrades further under failure. When a credential starts failing, every
in-flight request on every replica calls `recordFailure` for the same pair, and they all
queue. The circuit breaker exists to shed that load, but the write that *records* the breaker
opening is the one stuck in the queue: until it commits, other replicas' snapshots still show
the credential closed, so they keep routing to it, keep failing, and keep lengthening the
queue. The load-shedding mechanism is gated behind the resource its own load saturates.

### The write also invalidates every replica's routing snapshot

Unverified against a live Postgres; read from the schema and the cache, and it should be
measured before it is relied on.

`packages/store/src/postgres/migrations/001_init.sql:285-287`:

```sql
CREATE TRIGGER credential_health_config_version
  AFTER INSERT OR UPDATE OR DELETE ON credential_health
  FOR EACH STATEMENT EXECUTE FUNCTION bump_config_version();
```

`bump_config_version` is `UPDATE config_version SET version = version + 1 WHERE id = 1`, and
`apps/gateway/src/dispatch/snapshotCache.ts:69-70` compares that counter on every `get()`:
a change sets `stale`, and `stale` means `buildSnapshot` — five queries
(`packages/router/src/snapshot.ts:12-18`).

Chained, on Postgres:

1. a request finishes and writes health,
2. the trigger bumps a counter every replica polls,
3. every replica's next request rebuilds its whole routing snapshot.

Two consequences, both worse than the lock this spec started from:

- **The cache cannot stay warm under load.** `snapshotCache.ts:43-48` already knows how to
  patch a `healthSaved` row into the held map without rebuilding — that path is written and
  is dead, because the version check at `:69-70` runs first and marks the snapshot stale
  before the patch can matter. CLAUDE.md's claim that own writes "still patch, not rebuild"
  holds for the pubsub filter and is defeated by the trigger.
- **`config_version` is one row.** Every request, on every credential, on every replica,
  updates it. That is a tighter serialization point than the per-credential advisory lock:
  the advisory lock at least partitions by credential.

Both are consequences of writing on every request, so the design below addresses them with
the same change — plus one trigger edit, [below](#the-version-trigger).

### What the write actually says

`recordSuccess` (`packages/router/src/breaker.ts:63-83`) returns:

```
breakerState:        "closed"
consecutiveFailures: 0
openedAt:            null
rateLimitedUntil:    null
ewmaTtftMs:          <smoothed>
lastUsedAt:          <now>
```

On a healthy credential the first four are already those values. **Four of the six fields are
re-asserting what the row already holds.** The fleet takes a cluster-wide lock, once per
request, to write down facts that did not change.

## Decisions taken before design

- **The health data stays derived from real traffic.** An earlier proposal was a scheduler
  that probes each provider and writes the result, so requests only read. Rejected on four
  counts, recorded because the idea is a natural one and will recur:
  1. A probe against an inference provider is a billed request. Ten credentials × five models
     on a 30s schedule is ~100k billed requests a day to learn what real traffic reports free.
  2. A probe is not the request it stands in for. A one-token prompt succeeds on a credential
     that would fail the real 100k-token request with tools attached.
  3. Detection gets slower, not faster. The first real failure opens the breaker now; a 30s
     schedule keeps routing to a dead credential for up to 30s.
  4. `rateLimitedUntil` is read from the provider's own `Retry-After` on a real 429
     (`packages/router/src/breaker.ts:47`, `QUOTA_PARK_MS`). A probe can only learn it by
     getting itself rate-limited, which is the condition it is checking for.

  The half of that proposal which survives — **requests must not write** — is what this spec
  implements, by scheduling the *save* rather than the *observation*.

- **The durable tier stays in the store.** Moving `credential_health` into `@omni/coord` was
  considered and rejected; see [Why not coord](#why-not-coord).

- **Single-node SQLite keeps today's behaviour.** It has no race to fix: `db.transaction()`
  with a contractually synchronous `apply` (`packages/store/src/types.ts:759-768`) cannot
  interleave, which is why that backend takes no lock. The batching layer is a no-op there by
  configuration, not by a second code path.

- **`saveHealth` is deleted, not ported.** It has zero production callers; every call site is
  a test, and its doc comment (`packages/store/src/types.ts:751-757`) exists to steer readers
  away from it. Keeping a second write door open while adding a batching layer in front of the
  first is how the batching gets bypassed.

## Design

### The rule

> Urgent facts are written through immediately. Routine measurements accumulate in memory and
> are flushed on a schedule.

A fact is urgent when it changes what the router would *decide*: the breaker opening or
closing, or a rate-limit park being set. Those are rare, and their whole value is being seen
by other replicas at once. A measurement is routine when it only changes what the router would
*prefer*: `ewmaTtftMs`, `lastUsedAt`, and the running `consecutiveFailures` count once the
breaker is already open. Those are frequent and tolerate being seconds late.

This is the whole design. Everything below is what it takes to hold it.

### `HealthAccumulator` — `apps/gateway/src/dispatch/healthAccumulator.ts`

One per process. Holds a `Map<healthKey, Pending>` where `Pending` carries the fields that
have moved since the last flush:

```ts
type Pending = {
  failureDelta: number;         // failures observed since last flush
  lastFailureAt: number | null; // most recent failure this replica saw
  lastSuccessAt: number | null; // most recent success this replica saw
  ewmaTtftMs: number | null;    // this replica's smoothed value
  lastUsedAt: number;           // max over the interval
};
```

`persistHealth` is replaced by two calls on the accumulator, which return **synchronously**:

- `observeSuccess(candidate, ttftMs, now)`
- `observeFailure(candidate, transition, now)`

Each applies the transition to the replica's own view of the row, exactly as today, and asks
one question: **did a decision field change?** If yes, it writes through — `store.credentials.updateHealth`,
awaited, as today. If no, it merges into `Pending` and returns without touching the store.

The decision fields are `breakerState`, `openedAt`, and `rateLimitedUntil`. `consecutiveFailures`
is deliberately not one: it changes on every failure, and what it drives — `cooldownMs()`
doubling, capped at an hour (`packages/router/src/filters.ts:115-119`) — is a backoff curve,
not a decision boundary.

Because the breaker state is what gates the write-through, a herd of concurrent failures on
one credential produces **one** write per replica: the failure that flips the state. The rest
increment `failureDelta` and arrive at the next flush. That is the herd fixed, and it is fixed
by the same rule that fixes the steady-state ceiling.

### The flusher — one more loop in `apps/gateway/src/index.ts`

Every `HEALTH_FLUSH_MS` (5,000 default), drain the accumulator and write one row per pair that
moved. Runs on **every** replica, not under `coord.lease`: each replica has its own
observations to report, so electing a single flusher would simply discard the others'.

The write is the existing `updateHealth` with an `apply` that merges the pending delta into
whatever the row now holds:

- `consecutiveFailures` — `current + failureDelta`, or `0` when `lastSuccessAt` is later than
  `lastFailureAt`. Approximate under concurrency and monotone in the
  safe direction: two replicas each observing failures make the backoff longer, never shorter.
  The field's ceiling is one hour, so the approximation is bounded by construction.
- `ewmaTtftMs` — last writer wins. It is a smoothed estimate feeding a scoring term
  (`packages/router/src/score.ts:114-152`), with α=0.3, and it reconverges in a handful of
  requests. Averaging two replicas' estimates would be more defensible and is not worth a
  read-modify-write.
- `lastUsedAt` — `max(current, pending)`. It is operator-facing (`omni credentials health`,
  `apps/cli/src/commands/credentials.ts:441`; the dashboard at
  `apps/dashboard/src/lib/vitals.ts:243-246`), and a later replica must not move it backwards.

`shutdown()` flushes once. A replica killed without one loses up to five seconds of
measurements, never a decision field — those were written through when they happened.
`packages/control/src/copyStore.ts:22-28` already declares credential health non-durable
across a copy, so this is a narrower loss than one the codebase has accepted.

### The version trigger

Batching alone leaves the rebuild storm in place, only slower: the flusher writes, the trigger
bumps, and every replica rebuilds on a five-second cycle. That is still five queries per
replica per flush to react to a latency measurement moving.

The trigger fires blind because it is statement-level, and a statement-level trigger has no
`OLD`/`NEW` to test. Make the `UPDATE` arm row-level and conditional:

```sql
CREATE TRIGGER credential_health_config_version
  AFTER UPDATE ON credential_health
  FOR EACH ROW
  WHEN (OLD.breaker_state       IS DISTINCT FROM NEW.breaker_state
     OR OLD.rate_limited_until  IS DISTINCT FROM NEW.rate_limited_until
     OR OLD.opened_at           IS DISTINCT FROM NEW.opened_at)
  EXECUTE FUNCTION bump_config_version();
```

`INSERT` and `DELETE` keep an unconditional trigger — a new pair, or a credential removal
cascading — both rare, and neither has a prior row to compare against.

**The `WHEN` clause names the same three fields the accumulator uses to choose write-through.**
That is not a coincidence to be maintained by hand: both are asking "did a decision change",
and they must not drift. The columns belong in one place with both sides reading it, and a
test asserting the trigger condition and the accumulator's predicate cover the same set.

With this in place the flush writes only measurement columns, the counter does not move, the
`healthSaved` patch at `snapshotCache.ts:43-48` does the job it was written for, and no rebuild
happens at all. Rebuilds return to meaning what they should: routing configuration changed.

### What this costs, stated plainly

Write-through keeps emitting `healthSaved`, so `snapshotCache.ts:43-48` patches, `app.ts:276-282`
re-publishes onto the `routing` pubsub topic, and other replicas apply it. For **decision**
changes the version counter still moves, so a dropped publish still costs one late rebuild
rather than a replica routing into an open breaker. That safety net is intact, and it is why
decisions are written through rather than batched: flushing a breaker transition on the
schedule would put a five-second hole in exactly the fact the fan-out exists to carry.

For **measurement** changes the safety net is gone, deliberately. `coord.pubsub` is
fire-and-forget (`app.ts:277`) and fails open to a per-process emitter on a Redis fault
(`coord/redis.ts:216-227`), so a dropped publish now means that replica's `ewmaTtftMs` and
`lastUsedAt` for that pair stay stale until something else invalidates the snapshot.

That is acceptable — those two fields feed a scoring *preference* (`packages/router/src/score.ts:114-152`),
not an admission decision, and α=0.3 reconverges in a handful of requests. But it is a real
narrowing of a guarantee that used to be total, and it is written here so it is a choice on the
record rather than a surprise found later. The operator-visible edge: `omni credentials health`
and the dashboard's LAST USED column read the stored row, so on a replica that missed a publish
they can lag by more than the flush interval.

### Why not coord

Recorded because "health is ephemeral process state, it belongs in Redis" is the intuitive
read and it is wrong here in four specific ways.

1. **`Coord` has no compare-and-set and no read-modify-write.** Every mutation in
   `packages/coord/src/index.ts` is unconditional. A health record fits only in `kv` as JSON
   with `mutex.withLock` around each update — and `memoryCoord.mutex` carries
   `// ponytail: contenders race, no fairness` (`packages/coord/src/index.ts:392-393`).
   The every-request write would move from a Postgres lock to an unfair in-process one.
2. **`kv` is the one Redis primitive that does not fail open.** `apps/gateway/src/coord/redis.ts:222-226`
   — window, gauge, buckets, pubsub and incr degrade to an embedded memory coordinator; `kv`
   refuses with `OVERLOADED`, deliberately, because a session verified against a fallback map
   is one a password change cannot end. That refusal would land on `dispatch/index.ts:717`,
   before `log.status = 200`, turning a Redis blip into a 5xx on every *successful* request.
3. **`kv` requires a TTL and forbids serving past it** (`packages/coord/src/index.ts:128-133`).
   `rateLimitedUntil` from a `QUOTA_EXHAUSTED` park is an hour-long claim about the provider,
   not about this process. Losing it on restart re-hammers a credential the provider explicitly
   asked to be left alone.
4. **`kv` has no listing primitive.** `buildSnapshot` (`packages/router/src/snapshot.ts:14`)
   needs every row; `delPrefix` exists and its own comment says it is "not for listing".
   Serving that read would mean extending the interface, both implementations, and the Redis
   Lua scripts.

None of these is unsolvable. All of them together are a new durability story, not a code move,
and none of them is required to remove the ceiling this spec is about.

### Not in this spec

- **The advisory lock's shape.** `pg_advisory_xact_lock(hashtext($1))` uses the single-argument
  form, sharing one lock space with `MIGRATION_LOCK = 7_140_641` (`packages/store/src/postgres/db.ts:48`),
  and `hashtext` returns int4. Both are worth fixing — two-argument form, wider hash — and
  neither is load-bearing once the lock is taken at a few writes per second instead of a few
  thousand. Separate change.
- **The other four `config_version` triggers.** `credentials`, `quota_windows`,
  `virtual_models` and `settings` all bump the same single row unconditionally. Only
  `quota_windows` is written often enough to matter (the quota poller, per interval), and only
  `quotaSaved` has a patch path like health's. Worth the same conditional treatment; not needed
  to fix this problem, and bundling it would put four tables' invalidation semantics into one
  change.
- **Per-request PG round-trips generally.** Auth (`keys.findByHash`) is uncached and
  `usage.begin` is awaited before dispatch. Real, unrelated, separate spec.

## Testing

- **`observeSuccess` on a healthy credential issues no store write.** A store double that
  throws on `updateHealth`, N successful dispatches, assert none reached it. This is the
  central claim; if it passes while the ceiling remains, the accumulator is not on the path.
- **A breaker transition writes through immediately.** Same double, one failure crossing the
  threshold, assert the write happened before the dispatch returned — not on the next flush.
- **A herd produces one write per replica.** M concurrent failures on one pair, assert exactly
  one `updateHealth` and a `failureDelta` of M − 1 pending.
- **Delta merge is monotone.** Two accumulators flushing into one store leave
  `consecutiveFailures` at least as large as either alone, and `lastUsedAt` at the later of the
  two. Property-shaped, not example-shaped.
- **Shutdown flushes.** Observations made after the last tick reach the store on `shutdown()`.
- **Both backends.** The merge `apply` runs inside `updateHealth`, so it belongs in
  `packages/store/test/contract/credentials.test.ts` where it runs against SQLite and Postgres
  both, rather than against whichever one is convenient.
- **A measurement write does not move `config_version`; a decision write does.** Two
  `updateHealth` calls against Postgres, one changing only `ewmaTtftMs`, one opening the
  breaker; read `routing.version()` either side. This is the trigger's whole contract and
  nothing else pins it. Postgres-only, so it must sit where the suite skips cleanly without
  `OMNI_TEST_DATABASE_URL` rather than passing vacuously.
- **The trigger's `WHEN` columns and the accumulator's predicate name the same set.** Assert
  it from the shared definition, so adding a fourth decision field to one and not the other
  fails here instead of becoming a replica that never learns about it.
- **The snapshot is patched, not rebuilt, across a flush.** Count `buildSnapshot` calls over a
  flush cycle that carries only measurements: expected zero. Without this the trigger fix can
  regress silently — everything still works, just five queries at a time.

Do not add a test per `observe*` call site. One dispatch-level test with a store double that
refuses writes kills every mutant that reintroduces a per-request write, the same instrument
`apps/gateway/test/dispatch/dispatch.test.ts` already uses for registry threading.

## Rollout

`HEALTH_FLUSH_MS` is a constant chosen by mode, not an operator setting: `5_000` when
`clusterMode` is on, `0` otherwise. Zero means write through always — today's behaviour, byte
for byte, with the accumulator on the path but never holding anything between calls.

One code path, not two. The SQLite suite then exercises the accumulator's write-through branch
on every existing test, and the interval only has to be correct where it is non-zero.

## History

- **2026-09-07.** Found while tracing what blocks the event loop on the streaming path in
  cluster mode. The first survey reported the health write as failure-path-only; that was
  wrong — `dispatch/index.ts:717` writes on every success, unguarded, which moved this from an
  incident-time concern to a steady-state throughput ceiling. The correction is why the design
  targets `recordSuccess` first and treats the failure herd as the same bug under load.
- The `Coord` rejection was reached after choosing the opposite. The four blockers in
  [Why not coord](#why-not-coord) were found by reading the interface rather than by
  reasoning about it, and the `kv`-does-not-fail-open one in particular inverts the intuition
  that Redis is the more forgiving home.
- The scheduler-probes-providers shape was proposed and rejected on cost and fidelity, but it
  is what produced the design's central rule: schedule the save, not the observation.
- **The version trigger was found by asking "but does it still rebuild the snapshot every five
  seconds?" of the first draft.** The answer was yes, and following it back found the larger
  fact the first draft had missed entirely: the trigger fires on every health write, so today
  every request invalidates every replica's routing snapshot, and `config_version` is a single
  row the whole fleet updates per request. The advisory lock this spec was opened to fix at
  least partitions by credential; that row does not. Both were invisible while the write was
  treated as a local cost rather than followed to what observes it.

  Recorded because the first draft's error was structural, not careless: it read the write
  path and stopped there. `snapshotCache.ts:43-48` had a working patch path that was dead, and
  nothing about the write site says so.
