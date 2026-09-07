# Credential health: stop writing on the path that succeeds

## Problem

Every completed request writes a `credential_health` row before it is allowed to finish.
`persistHealth` (`apps/gateway/src/dispatch/index.ts:394-411`) is awaited at three sites, and
one of them is the success path — `dispatch/index.ts:717`, before `log.status = 200`.

On SQLite that is 16.4µs of synchronous `db.transaction()` and costs nothing worth naming. On
Postgres the same call is `sql.begin` wrapping three statements
(`packages/store/src/postgres/credentials.ts:314-338`): `pg_advisory_xact_lock(hashtext($1))`,
`SELECT … FOR UPDATE`, then the upsert. With `BEGIN`/`COMMIT` that is about six sequential
round-trips holding one advisory lock keyed on `(credentialId, model)`.

Three consequences, in increasing order of how badly they were understood.

**A per-credential throughput ceiling.** Every replica's every request through one credential
queues on one lock, at roughly `1 / (6 × RTT)` — near 170/s on a 1ms LAN, near 30/s across an
availability-zone boundary. This applies to *successful* traffic.

**A self-reinforcing failure herd.** When a credential starts failing, every in-flight request
on every replica calls `recordFailure` for the same pair and they all queue. The breaker exists
to shed that load, but the write that records it opening is the one stuck in the queue: until
it commits, other replicas still see the credential closed, keep routing to it, and keep
lengthening the queue.

**Every request invalidates every replica's routing snapshot.** Unverified against a live
Postgres — read from the schema and the cache, and it must be measured before it is relied on.
`packages/store/src/postgres/migrations/001_init.sql:285-287` bumps a global counter on every
`credential_health` write; `apps/gateway/src/dispatch/snapshotCache.ts:69-70` compares that
counter on every `get()`, and a change means `buildSnapshot` — five queries
(`packages/router/src/snapshot.ts:12-18`). So a health write on any replica costs every replica
a full rebuild. Worse, `bump_config_version` is `UPDATE config_version SET version = version + 1
WHERE id = 1`: **one row**, updated by every request on every credential on every replica. That
is a tighter serialization point than the advisory lock, which at least partitions by
credential.

Meanwhile `snapshotCache.ts:43-48` already knows how to patch a `healthSaved` row into the held
map without rebuilding. That path is written, and dead, because the version check at `:69-70`
runs first.

### What the successful write actually says

`recordSuccess` (`packages/router/src/breaker.ts:63-83`) returns `breakerState: "closed"`,
`consecutiveFailures: 0`, `openedAt: null`, `rateLimitedUntil: null`, plus `ewmaTtftMs` and
`lastUsedAt`.

On a healthy credential the first four are already those values. **Four of the six fields
re-assert what the row already holds**, and the remaining two are a latency estimate and a
timestamp. The fleet takes a cluster-wide lock, once per request, to write that.

## Design

> A successful request writes nothing, unless it is the one that brings a credential back.

That is the whole design. Everything below is what it takes to hold it.

### Successes

`persistHealth` on the success path becomes conditional on one question: **was the breaker
open?** If yes, write through as today — this is a recovery, and other replicas need it now.
If no, return without touching the store.

Recovery must write, and this is not negotiable: `recordSuccess` is the only thing that sets
`breakerState: "closed"` and `openedAt: null`. Without it an open breaker never closes, the row
stays `open` forever, and `cooldownMs` — doubling per failure past threshold, capped at an hour
(`packages/router/src/filters.ts:116-119`) — throttles a fully recovered account to one request
an hour, permanently. That is not stale health; that is a credential that never comes back.

Recoveries are rare. The common case writes nothing.

### Failures

Unchanged. Every failure writes, exactly as today.

Batching them was designed and discarded. Once the breaker opens, routing sheds the traffic at
`filters.ts`, so the failure burst is bounded by what was in flight at that moment — tens, once
— not by the ongoing request rate. That does not need an accumulator, a flush loop, a delta
merge, or a rule for what `consecutiveFailures` means when two replicas count concurrently. All
of that was solving a problem the breaker already solves.

### `ewmaTtftMs` becomes process-local

It is never persisted again. It feeds a scoring *preference* (`packages/router/src/score.ts:114-152`),
not an admission decision, and at α=0.3 it reconverges in a handful of requests.

Per-replica is also more correct than shared: a replica's time-to-first-token to a provider is
a property of that replica's network path, and averaging it with another pod's describes
neither.

### Round-robin stops needing `lastUsedAt`

`packages/router/src/index.ts:86-101` sorts `roundRobin` candidates by quota-spent, then
in-flight, then least-recently-used. The last term reads `lastUsedAt`, which is the only
remaining hot-path reader.

Replace it with `rand`:

```
sort by: quota-spent, then in-flight   (unchanged)
tie-break: rand                         (was: idle time descending)
```

`RankInput.rand` already exists (`packages/router/src/types.ts:72`), already injected to keep
ranking pure. No new plumbing.

**This is better than what it replaces, not merely cheaper.** Per-replica LRU converges: every
pod sees the same credential as idle, because none of *it* has used it, so all pods
independently pick the same one — the opposite of spreading. Independent random choices spread
uniformly across pods with zero communication and no shared state. And in-flight, which stays
the primary key, is already fleet-exact through the shared gauge (`loadRegistry.ts:92-93`), so
the random tiebreak only fires on an exact tie — the case where the choice matters least.

The codebase already found LRU to be the weak signal. `loadRegistry.ts:9-11`: *"`lastUsedAt`
only moves when a request finishes, so twenty requests that arrive together all read the same
history and all pick the same credential."* That is why in-flight was introduced and why it
outranks idle time. This change finishes that reasoning rather than starting a new one.

Costs, stated: random has variance where LRU was deterministic, so with two or three accounts
at low volume it can transiently favour one — self-correcting as soon as anything is in flight.
And `roundRobin` becomes a misnomer; the strategy spreads load rather than rotating. Rename it
in prose only. The stored `strategy` value is a storage contract
(`virtual_models.targets`) and does not move.

### `lastUsedAt` after that

Display-only: the CLI's LAST USED column (`apps/cli/src/commands/credentials.ts:441`) and the
dashboard (`apps/dashboard/src/lib/vitals.ts:243-246`).

Keep the column, keep writing it on the writes that still happen — failures and recoveries —
and **relabel both surfaces**, because it no longer means "last used". It means the last time
this credential's state changed. A column labelled LAST USED that only moves on failure is
worse than one honestly labelled.

Deriving true last-use from `request_logs` is out of scope and has a reason:
`packages/control/test/credentials.test.ts:395-417` explicitly forbids `credentialHealth` from
aggregating request logs, because the console refetches it every 10s on the same connection
that serves `/v1/messages`. If an operator wants "is this account active right now", the shared
gauge behind `loadRegistry` already answers it, better, and that is a separate change.

### The `config_version` trigger

With successes silent the counter mostly stops moving, but a failure write still invalidates
every replica's snapshot when the `healthSaved` patch at `snapshotCache.ts:43-48` could have
handled it. The trigger fires blind because it is statement-level, and a statement-level
trigger has no `OLD`/`NEW` to test. Make the `UPDATE` arm row-level and conditional:

```sql
CREATE TRIGGER credential_health_config_version
  AFTER UPDATE ON credential_health
  FOR EACH ROW
  WHEN (OLD.breaker_state      IS DISTINCT FROM NEW.breaker_state
     OR OLD.rate_limited_until IS DISTINCT FROM NEW.rate_limited_until
     OR OLD.opened_at          IS DISTINCT FROM NEW.opened_at)
  EXECUTE FUNCTION bump_config_version();
```

`INSERT` and `DELETE` keep an unconditional trigger — a new pair, or a credential removal
cascading — both rare, and neither has a prior row to compare against.

The three columns in the `WHEN` clause are the same three the success path tests to decide
whether it is a recovery. That is one question asked in two languages, and they must not drift:
they belong in one definition with a test asserting both sides cover the same set.

What this narrows: for decision changes the counter still moves, so a dropped `coord.pubsub`
publish still costs one late rebuild rather than a replica routing into an open breaker. For
everything else the counter is no longer a fallback behind a fire-and-forget publish
(`app.ts:277`, fails open on a Redis fault per `coord/redis.ts:216-227`). Acceptable, because
after this change "everything else" is only `lastUsedAt` — and it is on the record rather than
discovered later.

## Decisions taken before design

Each closes a door, and each was reached by trying the other side first.

- **A scheduler that probes providers was proposed and rejected.** A probe against an inference
  provider is a billed request; a one-token probe succeeds on a credential that would fail the
  real 100k-token request; a 30s schedule detects a dead credential *slower* than the first real
  failure does; and `rateLimitedUntil` is read from the provider's own `Retry-After` on a real
  429 (`breaker.ts:47`), which a probe can only learn by getting itself rate-limited. The half
  of that proposal which survives — requests must not write — is this spec.
- **Moving `credential_health` into `@omni/coord` was chosen, then rejected on four counts.**
  `Coord` has no compare-and-set or read-modify-write, so a record fits only in `kv` under
  `mutex.withLock`, and `memoryCoord.mutex` carries `// ponytail: contenders race, no fairness`.
  `kv` is the one Redis primitive that does *not* fail open (`coord/redis.ts:222-226`) — it
  answers `OVERLOADED`, which would land before `log.status = 200`, turning a Redis blip into a
  5xx on every successful request. `kv` requires a TTL and forbids serving past it
  (`packages/coord/src/index.ts:128-133`), while a `QUOTA_EXHAUSTED` park is an hour-long claim
  about the *provider* that must survive a restart. And `kv` has no listing primitive, which
  `buildSnapshot` needs. Solvable, all of it — but it is a new durability story, not a code
  move, and none of it is required here.
- **Batching writes behind an accumulator and a flush loop was designed in full, then
  discarded** when "does it still rebuild every five seconds?" turned out to be "yes". Making
  successes silent removes the writes outright instead of rescheduling them, which is both
  smaller and strictly better.
- **Single-node SQLite keeps today's behaviour.** It has no race to fix — `db.transaction()`
  with a contractually synchronous `apply` (`packages/store/src/types.ts:759-768`) cannot
  interleave, which is why that backend takes no lock. It still gets the change, because fewer
  pointless writes is not worse anywhere, and one code path beats two.
- **`saveHealth` is deleted, not kept.** Zero production callers; every call site is a test, and
  its doc comment (`packages/store/src/types.ts:751-757`) exists to steer readers away. Leaving
  a second write door open in front of a rule about writes is how the rule gets bypassed.

## Testing

- **A successful request against a healthy credential issues no store write.** A store double
  that throws on `updateHealth`, N successful dispatches, assert none reached it. This is the
  central claim; if it passes while the ceiling remains, the check is not on the path.
- **A success against an open breaker writes through.** Same double, breaker open, one success,
  assert the write happened before the dispatch returned. This is the case whose absence
  strands a recovered credential at one request per hour, so it is the one to write first.
- **Failures still write.** Guards against fixing the ceiling by making the breaker unable to
  open.
- **A measurement-only write does not move `config_version`; a decision write does.** Two
  `updateHealth` calls against Postgres, read `routing.version()` either side. This is the
  trigger's whole contract. Postgres-only, so it must skip cleanly without
  `OMNI_TEST_DATABASE_URL` rather than pass vacuously.
- **The trigger's `WHEN` columns and the recovery predicate name the same set**, asserted from
  the shared definition — so adding a fourth decision field to one and not the other fails here
  rather than becoming a replica that never learns about it.
- **The snapshot is patched, not rebuilt, across a failure write.** Count `buildSnapshot` calls:
  expected zero. Without this the trigger fix regresses silently — everything still works, five
  queries at a time.
- **Round-robin spreads across pods.** Rank the same candidate set from several `rand` values
  and assert the selection distributes, rather than asserting one specific pick. An
  example-shaped test here passes for a tiebreak that always returns the first candidate.

Do not add a test per call site. One dispatch-level test with a store double that refuses
writes kills every mutant that reintroduces a per-request write — the same instrument
`apps/gateway/test/dispatch/dispatch.test.ts` already uses for registry threading.

## Out of scope

- **`halfOpen` is never written.** It is read at `breaker.ts:114`, `score.ts:97`, and the
  dashboard's "probing" lamp (`vitals.ts:261-264`), and assigned nowhere in the codebase. So the
  "a failed probe re-opens immediately" rule cannot fire and that lamp cannot light. Found while
  writing this spec; pre-existing, unrelated, needs its own fix.
- **The advisory lock's shape.** `pg_advisory_xact_lock(hashtext($1))` uses the single-argument
  form, sharing one lock space with `MIGRATION_LOCK = 7_140_641` (`postgres/db.ts:48`), and
  `hashtext` returns int4. Worth fixing; not load-bearing once the lock is taken on failures
  only.
- **The other four `config_version` triggers.** `credentials`, `quota_windows`, `virtual_models`
  and `settings` bump the same single row unconditionally. Only `quota_windows` is written often
  enough to matter, and only `quotaSaved` has a patch path like health's. Same treatment, later.
- **Per-request Postgres round-trips generally.** `keys.findByHash` is uncached and `usage.begin`
  is awaited before dispatch. Real, unrelated.

## History

- **2026-09-07.** Found while tracing what blocks the event loop on the streaming path in
  cluster mode.
- The first survey reported the health write as failure-path-only. Wrong: `dispatch/index.ts:717`
  writes on every success, unguarded, which moved this from an incident-time concern to a
  steady-state ceiling.
- The `config_version` trigger was found by asking "but does it still rebuild the snapshot every
  five seconds?" of a draft that batched writes. The answer was yes, and following it back found
  the larger fact that draft had missed entirely — every request invalidating every replica's
  snapshot, and one row the whole fleet updates per request. The draft's error was structural,
  not careless: it read the write path and stopped there, and nothing at the write site says
  that `snapshotCache.ts:43-48` has a working patch path that is dead.
- The design shrank three times, each time from a question that refused the current shape rather
  than optimising it: *why write on success at all* deleted the accumulator and the flush loop;
  *why not change round-robin instead* deleted the last hot-path reader of `lastUsedAt` and, with
  it, the coord interface addition that sharing it would have required. Both questions came from
  outside the code. The recorded lesson is that each of the three drafts was internally
  well-argued, and the argument was what kept the unnecessary machinery alive.
