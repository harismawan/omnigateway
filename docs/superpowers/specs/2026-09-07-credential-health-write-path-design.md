# Credential health: stop writing on the path that succeeds

## Problem

Every completed request writes a `credential_health` row before it is allowed to finish.
`persistHealth` (`apps/gateway/src/dispatch/index.ts:394-411`) is awaited at three sites, and
one of them is the success path — `dispatch/index.ts:717-724`, before `log.status = 200`,
unconditional.

On SQLite that is 16.4µs of synchronous `db.transaction()` and costs nothing worth naming. On
Postgres the same call is `sql.begin` wrapping three statements
(`packages/store/src/postgres/credentials.ts:314-338`): `pg_advisory_xact_lock(hashtext($1))`,
`SELECT … FOR UPDATE`, then the upsert. With `BEGIN`/`COMMIT` that is about six sequential
round-trips holding one advisory lock keyed on `(credentialId, model)`.

Three consequences, in increasing order of how badly they were understood.

**A per-credential throughput ceiling.** Every replica's every request through one credential
queues on one lock. Magnitude is unmeasured; the mechanism is not.

**A self-reinforcing failure herd.** When a credential starts failing, every in-flight request
on every replica calls `recordFailure` for the same pair and they all queue. The breaker exists
to shed that load, but the write that records it opening is the one stuck in the queue.

**Every request invalidates every replica's routing snapshot.** Unverified against a live
Postgres — read from the schema and the cache, and it must be measured before it is relied on.
`postgres/migrations/001_init.sql:285-287` bumps a global counter on every `credential_health`
write; `apps/gateway/src/dispatch/snapshotCache.ts:67-68` marks the snapshot stale on any
change, and stale means `buildSnapshot` — five queries (`packages/router/src/snapshot.ts:12-18`).
`snapshotCache.ts:76-80` then re-checks the version after the build and calls `get()` again if
it moved, so under constant fleet writes one `get()` can rebuild several times in a row.

`bump_config_version` (`001_init.sql:270-275`) is `UPDATE config_version SET version = version + 1
WHERE id = 1`: **one row**, updated inside the writer's transaction and therefore row-locked
until commit, by every request on every credential on every replica. That is a tighter
serialization point than the advisory lock, which at least partitions by credential.

Meanwhile `snapshotCache.ts:41-46` already knows how to patch a `healthSaved` row into the held
map without rebuilding. On Postgres that path is written and dead, because the version check at
`:67-68` runs first. **On SQLite it is live**: `routing.version()` there is `PRAGMA data_version`
(`sqlite/store.ts:223-224`), which moves only on *other* connections' commits, so a single
process never invalidates itself.

### What the successful write actually says

`recordSuccess` (`packages/router/src/breaker.ts:63-83`) returns `breakerState: "closed"`,
`consecutiveFailures: 0`, `openedAt: null`, `rateLimitedUntil: null`, plus `ewmaTtftMs` and
`lastUsedAt`.

On a credential that is healthy *and has no accumulated failure count*, the first four are
already those values. That qualifier is load-bearing and cost this spec a draft; see the
predicate below.

## Design

> A successful request writes nothing, unless it would change something a router decides on.

### The success predicate

Evaluated against `snapshot.health` **before** the attempt, never inside `updateHealth`'s
`apply` — `apply` runs inside the transaction this design exists to skip.

Do not hand-maintain the field list. Derive it from what `recordSuccess` resets, compared
against `blankHealth`, so the predicate cannot drift from the transition it describes:

```ts
export const SUCCESS_RESETS = [
  "breakerState", "consecutiveFailures", "openedAt", "rateLimitedUntil",
] as const satisfies ReadonlyArray<keyof CredentialHealth>;

export function successWouldChange(current: CredentialHealth | undefined): boolean {
  if (current === undefined) return false;
  const blank = blankHealth(current.credentialId, current.model);
  return SUCCESS_RESETS.some((field) => current[field] !== blank[field]);
}
```

Write through when it returns true; otherwise return without touching the store.

Two things an earlier draft of this section got wrong, both caught by implementing it:

- **`openedAt` belongs in the set.** The draft's literal predicate omitted it while the trigger's
  `WHEN` clause included `opened_at`, so the superset test this spec mandates failed against the
  spec's own predicate. `recordSuccess` resets `openedAt`, so by the predicate's own definition
  it was always a member.
- **A missing row means silence, not a write.** The draft opened with `h === undefined ||` →
  write, which would mint a row on the first success for every credential and contradict this
  spec's own claim that a healthy account commonly has no row. A missing row reads as blank
  everywhere routing looks — `healthScore(undefined)` is 1, the filters admit — so there is
  nothing for a success to reset. Rows come into being on failure.

**`consecutiveFailures > 0` is not optional, and omitting it is the worst bug this design can
have.** `recordFailure` on a sub-threshold hard failure writes `consecutiveFailures: n` with
`breakerState: "closed"` (`breaker.ts:117-122`). Today the next success resets the count to 0
(`breaker.ts:77`). A predicate testing only breaker state makes that success silent, so the
count never resets and **the breaker opens on cumulative failures rather than consecutive
ones**. With the default threshold of 3 (`packages/store/src/types.ts:1432`): one `TIMEOUT` on
Monday, one Wednesday, one Friday, ten thousand successes between — Friday opens the breaker,
and every credential converges on open over a long enough horizon. `healthScore` is
`1 / (1 + consecutiveFailures)` (`score.ts:95`), so scoring permanently deranks anything that
ever hiccuped, and `omni credentials health` lists it as unhealthy forever
(`apps/cli/src/commands/credentials.ts:422`).

`breakerState !== "closed"` rather than `=== "open"`: `halfOpen` is a third state that
[the half-open probe design](2026-09-07-breaker-half-open-probe-design.md) starts writing, and
a narrower comparison would make every probe recovery silent.

**The predicate and the trigger's `WHEN` clause are deliberately different sets, and an earlier
draft claimed they were the same question.** They are not. The predicate asks "would this write
change anything at all", which includes the failure counter. The trigger asks "must every
replica rebuild", which the counter does not require — it patches. One test should assert the
predicate is a strict superset of the trigger's columns; asserting equality would force
`consecutive_failures` into the trigger and reinstate the rebuild storm.

### Failures

Unchanged. Every failure writes, exactly as today.

Batching them was designed and discarded. Once the breaker opens, routing sheds the traffic, so
the failure burst is bounded by what was in flight at that moment — tens, once — not by the
ongoing request rate. That needs no accumulator, flush loop, delta merge, or rule for what
`consecutiveFailures` means when two replicas count concurrently.

### `lastUsedAt` leaves `CredentialHealth`

Its consumers are the round-robin tiebreak (`packages/router/src/index.ts:86-101`) and two
display surfaces — the CLI's LAST USED column (`apps/cli/src/commands/credentials.ts:441`) and
the dashboard (`apps/dashboard/src/lib/vitals.ts:243-247`).

**The tiebreak moves into `loadRegistry`.** That module already owns a synchronous per-key map
and a release hook firing at request end (`apps/gateway/src/dispatch/loadRegistry.ts`), so it
can record `lastReleasedAt` per `healthKey` for free — no I/O, no store read, no coord call. It
reaches ranking as one more field on `RankInput`, the same plumbing shape `load` already uses,
and `packages/router` stays pure.

This preserves today's behaviour where it is most visible. A single-node install alternating two
OAuth accounts keeps exact ABAB rotation. In a fleet, rotation becomes per-replica — which
aggregates to balanced rather than converging, and in-flight counts outrank it anyway.

An earlier draft replaced the tiebreak with `RankInput.rand` and argued that per-replica LRU
"converges". That argument was against a design that does not exist: `lastUsedAt` is in the
shared store today and reaches every replica, so current LRU is fleet-wide at the snapshot's
lag. Random would have been simpler and strictly worse for the single-node case, where nothing
is ever in flight at rank time and the tiebreak *is* the strategy.

Correcting a second claim from that draft: in-flight counts are **not** fleet-exact.
`loadRegistry.ts:15-18` says so — "one round trip stale by construction; a burst split across
processes can stack for that long".

**The display surfaces read `request_logs` instead.** `CREATE INDEX idx_request_logs_cred ON
request_logs (credential_id, at DESC)` exists on both backends
(`postgres/migrations/001_init.sql:156`, `sqlite/migrations/001_init.sql:82`), so
`SELECT MAX(at) FROM request_logs WHERE credential_id = $1` is a seek to the head of one index
range. A narrow repo method, `usage.lastUsedByCredential()`, not `usage.aggregate`.

`packages/control/src/credentials.ts:231-232` says "nothing here may touch `request_logs`" and
`packages/control/test/credentials.test.ts:395` is titled "credentialHealth reads no request
logs at all". **Both must be rewritten, not left standing.** An earlier draft said to leave the
test exactly as it is, which would have made a green test assert something false. The rule being
protected is a cost class — no week-scale aggregate on the connection serving `/v1/messages`,
because the console refetches every ten seconds — so the test should stub `usage.aggregate` to
throw, as it does now, and be retitled to name the aggregate rather than the table.

Two behaviour changes to state: **retention truncates the answer** (a credential unused longer
than the log window reads "never"), and **rows with a `NULL` `credential_id`** — logged before
routing resolves — are excluded, correctly.

**Wire shape.** After this change a healthy credential may have **no `credential_health` row at
all**, since rows are only created by a write. So `lastUsedAt` cannot ride on the health row.
`credentialHealth()` returns `{health, quota, burn}`; it gains a fourth member keyed by
credential id, and `apps/dashboard/src/api/types.ts` plus `vitals.ts:196` mirror it. Absent
health rows are already handled — `vitals.ts:223,232` construct a blank status — but that path
is currently reached only for a credential that has never served, and it becomes the common
case. Worth a test of its own.

### `ewmaTtftMs` leaves `CredentialHealth` too

It rides the same `loadRegistry` map as `lastReleasedAt` — the release hook already knows when
the attempt ended, and `log.ttftMs` is in hand at that point. One field on `RankInput` carries
both, and `score.ts:115,148-150` reads it from there instead of from `snapshot.health`.

Per-replica is also more correct than shared: time-to-first-token is a property of *that*
replica's network path to the provider, and averaging two pods' measurements describes neither.

**The cost, which an earlier draft did not state: the CLI's TTFT column dies.**
`apps/cli/src/commands/credentials.ts:440` reads it through `@omni/control` against the store
directly, and the CLI never talks to the running gateway (CLAUDE.md, boundary 11), so a
process-local value is invisible to it. The column goes. The dashboard's `ttftMs`
(`vitals.ts:244-245`) can be served from the gateway, which holds the registry — or from
`request_logs`, which records `ttft_ms` per request and is the better source for a display
anyway. Either is a separate change; this spec removes the field and says so rather than
pretending the surfaces are unaffected.

### The `config_version` trigger

With successes mostly silent the counter mostly stops moving, but a failure write still
invalidates every replica's snapshot where the `healthSaved` patch could have handled it. The
trigger fires blind because it is statement-level. Make it row-level and conditional:

```sql
CREATE TRIGGER credential_health_config_version_upd
  AFTER UPDATE ON credential_health
  FOR EACH ROW
  WHEN (OLD.breaker_state      IS DISTINCT FROM NEW.breaker_state
     OR OLD.rate_limited_until IS DISTINCT FROM NEW.rate_limited_until
     OR OLD.opened_at          IS DISTINCT FROM NEW.opened_at)
  EXECUTE FUNCTION bump_config_version();

CREATE TRIGGER credential_health_config_version_ins
  AFTER INSERT ON credential_health
  FOR EACH ROW EXECUTE FUNCTION bump_config_version();

CREATE TRIGGER credential_health_config_version_del
  AFTER DELETE ON credential_health
  FOR EACH ROW EXECUTE FUNCTION bump_config_version();
```

**The `INSERT` arm must be `FOR EACH ROW`, and this is the trap that makes the whole fix moot if
missed.** The write is an upsert (`postgres/credentials.ts:71-81`, `ON CONFLICT DO UPDATE`).
PostgreSQL fires *statement-level* `INSERT` triggers on an upsert regardless of which path each
row took, so a statement-level `INSERT` arm bumps on every write and the `WHEN` clause on the
`UPDATE` arm never matters. Row-level `AFTER INSERT` fires only for rows actually inserted.

Measured on PostgreSQL 16 rather than reasoned about, and the current shape is worse than the
paragraph above: a single upsert taking the UPDATE path bumps the counter **twice**, because
`AFTER INSERT OR UPDATE OR DELETE … FOR EACH STATEMENT` fires both the INSERT arm and the UPDATE
arm. So today one health write — one per request — is two increments of the fleet-wide row.

The replacement behaves as specified:

| write | counter |
| --- | --- |
| upsert that inserts | bump |
| upsert, UPDATE path, count only | **no bump** |
| upsert, UPDATE path, breaker changed | bump |

What this narrows: for decision changes the counter still moves, so a dropped `coord.pubsub`
publish (`app.ts:276-281`, fire-and-forget, degrading to a per-process emitter on a Redis fault
per `coord/redis.ts:196-207`) still costs one late rebuild rather than a replica routing into an
open breaker. For a bare `consecutiveFailures` increment the counter no longer moves, so a
dropped publish leaves that replica's count stale until something else invalidates. Acceptable —
it shortens a backoff, and the breaker state itself is not at risk — but on the record.

## Decisions taken before design

- **A scheduler that probes providers was proposed and rejected.** A probe is a billed request;
  a one-token probe succeeds where the real 100k-token request fails; a 30s schedule detects a
  dead credential *slower* than the first real failure; and `rateLimitedUntil` comes from the
  provider's own `Retry-After` on a real 429 (`breaker.ts:47`), which a probe can only learn by
  getting itself rate-limited. The surviving half — requests must not write — is this spec.
- **Moving `credential_health` into `@omni/coord` was chosen, then rejected on four counts.**
  No compare-and-set or read-modify-write, so a record fits only in `kv` under `mutex.withLock`,
  and `memoryCoord.mutex` carries `// ponytail: contenders race, no fairness`. `kv` is the one
  Redis primitive that does *not* fail open (`coord/redis.ts:204-206`, throw at `:641`) — it
  answers `OVERLOADED`, which would land before `log.status = 200`. `kv` requires a TTL
  (`packages/coord/src/index.ts:113-114`, `:344-346`) while a `QUOTA_EXHAUSTED` park is an
  hour-long claim about the provider that must survive a restart. And `kv` has no listing
  primitive, which `buildSnapshot` needs.
- **Batching writes behind an accumulator and a flush loop was designed in full, then
  discarded** when "does it still rebuild every five seconds?" turned out to be "yes".
- **Single-node SQLite keeps working, but is not unaffected.** It has no race to fix, and its
  patch path is already live. It still gets the change — fewer pointless writes is not worse —
  but it loses the CLI TTFT column and, without `consecutiveFailures > 0` in the predicate,
  would be the install *most* hurt by the cumulative-failure bug, since sub-threshold blips are
  its only failures.
- **`saveHealth` is deleted, not kept.** Zero production callers; its doc comment
  (`packages/store/src/types.ts:751-757`) exists to steer readers away.

## Known pre-existing bug, surfaced not fixed

`recordFailure` writes `breakerState: open ? "open" : "closed"` (`breaker.ts:120`), so **a
failure can close a breaker**. An `AUTH` failure opens at `consecutiveFailures: 1`
(`breaker.ts:113`); a later non-`AUTH` failure on that row computes `failures = 2 < threshold`,
is not `halfOpen`, and writes `closed` with the old `openedAt`.

This means the "recovery must write" argument holds for a narrower reason than first stated: not
"nothing else writes `closed`", but "nothing else writes `closed` on a row whose count has
already reached the threshold". The design is unaffected. The bug is not — it deserves its own
fix, and `recordFailure` should never widen a breaker's admission.

## Testing

- **A successful request against a healthy credential with a zero failure count issues no store
  write.** Store double throwing on `updateHealth`, N successful dispatches, assert none reached
  it.
- **Two sub-threshold failures, one success, a third failure — the breaker is still closed.**
  This is the cumulative-failure test. Without it, a predicate omitting `consecutiveFailures`
  passes every other test in this list.
- **A success against a non-closed breaker writes through**, asserted for `open` **and** for
  `halfOpen`. The `halfOpen` arm is what stops the predicate being narrowed to `=== "open"`.
- **The predicate's column set is a strict superset of the trigger's `WHEN` columns**, asserted
  from a shared definition. Not equality — see the design note.
- **A measurement-only write does not move `config_version`; a decision write does.** Postgres
  only, skipping cleanly without `OMNI_TEST_DATABASE_URL`. **Call `updateHealth` twice on the
  same pair** so the second call takes the `ON CONFLICT` path — that is what catches a
  statement-level `INSERT` arm, which a raw `UPDATE` would not.
- **A sub-threshold failure is patched, not rebuilt.** Postgres only, and specifically a
  `closed → closed` count increment: a failure that *opens* the breaker changes a decision
  column and is *supposed* to rebuild. An earlier draft asked for zero rebuilds across "a
  failure write", which fails by design on Postgres and passes vacuously on SQLite, where the
  patch path is already live.
- **Round-robin still rotates.** Two candidates, no in-flight, four sequential requests through
  the real `loadRegistry` release hook: assert ABAB, not a distribution.
- **`lastUsedByCredential` returns the newest log, `null` past retention, and `null` for a
  credential whose only rows have a `NULL` `credential_id`** — not the newest unrelated row.
  Contract-suite shaped, so both backends answer alike.
- **A credential with no health row renders.** After this change that is the common case for a
  healthy account, and `vitals.ts:223,232` currently reaches its blank-status path only for one
  that never served.
- **Guards, not evidence:** "failures still write", "`credentialHealth` never calls
  `usage.aggregate`", "`packages/router` stays pure" all pass against current code. Keep them,
  do not count them.

Do not add a test per call site. One dispatch-level test with a store double that refuses writes
kills every mutant that reintroduces a per-request write — the instrument
`apps/gateway/test/dispatch/dispatch.test.ts` already uses for registry threading.

## Out of scope

- **`halfOpen` is never written**, and nothing limits a probe to one request, so a dead
  credential takes a full traffic flood once per cooldown. Specced separately in
  [the half-open probe design](2026-09-07-breaker-half-open-probe-design.md).
- **`recordFailure` closing a breaker**, above.
- **The advisory lock's shape.** Single-argument `pg_advisory_xact_lock(hashtext($1))` shares a
  lock space with `MIGRATION_LOCK = 7_140_641` (`postgres/db.ts:48`) and `hashtext` returns
  int4.
- **The other four `config_version` triggers.** `credentials`, `quota_windows`,
  `virtual_models`, `settings` bump the same row unconditionally; only `quota_windows` is
  written often enough to matter.
- **Restoring the CLI TTFT and LAST USED columns from `request_logs`.** Display sourcing, not
  write-path.

## Known unknowns

- No live-Postgres measurement of the ceiling or the rebuild rate. The mechanism is in the code;
  the magnitudes are asserted, not measured, and should be before anyone quotes them.
- Whether a stale-snapshot success is worth handling: replica B opens the breaker, replica A's
  in-flight request routed on the old snapshot succeeds and sees `closed`, so it stays silent
  and the breaker stays open until a probe. One cooldown of cost. Left alone deliberately.
  Related: a success in flight beside a real 429 no longer clears `rateLimitedUntil`, which is
  an improvement.

## History

- **2026-09-07.** Found while tracing what blocks the event loop on the streaming path in
  cluster mode.
- The first survey reported the health write as failure-path-only. Wrong: `dispatch/index.ts:717`
  writes on every success, unguarded.
- The `config_version` trigger was found by asking "but does it still rebuild the snapshot every
  five seconds?" of a draft that batched writes. Following that back found every request
  invalidating every replica's snapshot, and one row the whole fleet updates per request.
- The design shrank three times, each time from a question that refused the current shape rather
  than optimising it. Each draft was internally well-argued, and the argument was what kept the
  unnecessary machinery alive.
- **Adversarial review, 2026-09-08, found two design-breaking flaws.** The success predicate
  omitted `consecutiveFailures`, which would have converted the breaker from consecutive to
  cumulative failures — and every test then proposed passed against that mutant. And the
  round-robin argument was against a strawman: `lastUsedAt` is shared today, not process-local,
  so replacing fleet-wide LRU with `rand` was a regression dressed as a fix. Both errors have
  the same shape — a claim about existing behaviour asserted from the design's own logic rather
  than read from the code. The `lastUsedAt` one had already been corrected once, in the opposite
  direction, earlier in the same spec.
