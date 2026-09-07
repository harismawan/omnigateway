# The breaker's half-open probe, which does not exist

## Problem

`packages/router/src/filters.ts:240-247` gates an open breaker:

```ts
if (h.breakerState === "open") {
  const elapsed = now - (h.openedAt ?? now);
  if (elapsed < cooldownMs(h.consecutiveFailures, breakerThreshold, breakerCooldownMs)) {
    drop("breaker:open");
    continue;
  }
  // Cooldown elapsed: admitted as a half-open probe.
}
```

That last line is the entire implementation of the probe. It is a comment.

**`halfOpen` is read in three places and written in none.** `breaker.ts:114` opens immediately
when the state is `halfOpen` — the "a failed probe means the credential is still down" rule,
unreachable. `score.ts:97` halves the score for `open` or `halfOpen`; the second arm never
matches. `apps/dashboard/src/lib/vitals.ts:261-264` renders a "probing" lamp that cannot light.

**Nothing limits the probe to one request.** Once `elapsed` passes the cooldown the guard stops
dropping, and every candidate evaluation admits the credential. Two hundred concurrent requests
arriving one millisecond after expiry all go upstream to a credential last known to be dead.
They fail; `recordFailure` re-opens and moves `openedAt` to now, so the cycle restarts.
`consecutiveFailures` climbs, `cooldownMs` doubles per failure past threshold and caps at an
hour (`filters.ts:116-119`) — so the steady state for a permanently dead credential is **a full
traffic flood once an hour, indefinitely**.

Each request in that flood also writes health, at about six sequential round-trips on one
advisory lock (see [the write-path spec](2026-09-07-credential-health-write-path-design.md)).
The flood and the write herd are the same event.

## Design

A probe is a claim, and the claim has to be made where I/O is allowed.

### `filters.ts` must gate `halfOpen`, not just `open`

**This is the load-bearing part, and an earlier draft omitted it entirely.** `filters.ts:240`
tests `h.breakerState === "open"`. A `halfOpen` row is neither dropped, nor cooldown-checked,
nor flagged — it walks straight through, score merely halved.

So writing `halfOpen` without changing that guard makes things *worse*: request 1 claims the
gauge and writes `halfOpen`; the emit patches the writer's own snapshot synchronously
(`sqlite/credentials.ts:370`, `postgres/credentials.ts:341`) and pubsub patches every replica
within milliseconds (`app.ts:276-281`); requests 2..200 then rank *against `halfOpen`*, are not
in probe territory, make no claim, and all go upstream. The flood returns with the "probing"
lamp lit — exactly the failure this spec's earlier History section said would be worse than the
bug.

The guard becomes:

```ts
if (h.breakerState === "open") {
  const elapsed = now - (h.openedAt ?? now);
  if (elapsed < cooldownMs(...)) { drop("breaker:open"); continue; }
  probe = true;                       // cooldown elapsed: probe territory
} else if (h.breakerState === "halfOpen") {
  probe = true;                       // someone may already be probing
}
```

`probe` becomes a field on the `Pair` that `eligible()` returns. The router still decides
*whether* a candidate is in probe territory; it never decides *who* probes, because
`packages/router` is pure — no I/O, no coordination (CLAUDE.md, boundary 3).

Treating `halfOpen` as probe territory also makes the abandoned-probe case self-heal. A probe
aborted by the client (`dispatch/index.ts:417-420` rethrows `signal.reason` without reaching
`persistHealth`) or failing with a `none` penalty (`breaker.ts:99` returns `current` unchanged)
leaves the row `halfOpen` forever. With the guard in place, the next request simply re-claims
the released gauge slot and probes again.

### The claim

One in-flight probe per `(credentialId, model)` — not per credential. A credential can be
healthy for one model and refused for another; `credential_health` is keyed on the pair for
that reason, and probing per credential would let one model's success close a breaker another
model opened.

```ts
const held = await coord.gauge.acquire(`probe:${healthKey(id, model)}`, PROBE_TTL_MS);
// held === 0 -> this request is the probe
// held  >  0 -> someone is already probing; skip this candidate
```

`gauge.acquire` returns the count *before* the acquisition. **The property that makes exactly
one of two hundred concurrent requests win differs by implementation, and an earlier draft cited
the wrong one for the cluster case.** `memoryCoord` mutates then returns `Promise.resolve(before)`
(`packages/coord/src/index.ts:231-237`), so the claim is visible at call time. The Redis
implementation awaits `ready` first (`coord/redis.ts:413-423`) and therefore is *not* visible at
call time — the guarantee there comes from Lua-script atomicity instead. Same outcome, different
mechanism; both hold, and the spec should not claim a single invariant covers both.

`gauge` is in the fail-open set (`coord/redis.ts:196-207`): a Redis fault degrades the claim to
per-process, so N replicas send N probes instead of one. Bounded, and nothing like a flood.

### Where the claim goes

`dispatch/index.ts:442-448` already acquires a `loadRegistry` slot per attempt and releases it
in a `finally` at `:855`. The comment at `:449-451` states what that `finally` covers: "Held for
the whole attempt, including the stream drain… Every way out of the block below unwinds through
the `finally`."

**The probe claim goes there, beside `releaseSlot`, and nowhere else.** An earlier draft said
"where the concurrency slot's release goes" and pointed at request scope in
`routes/proxy.ts:719-727` — wrong on two counts: that code does not know which candidate probed,
and the claim is per-candidate inside dispatch's loop.

The acquire must be **inside** the `try` at `:471`, not at the top of the iteration beside
`checkCancellation()` (`:417`) as an earlier draft said. Outside the `try`, the release has a
path it cannot reach.

Releasing there is also what makes the claim survive failover: a retryable probe failure hits
`continue candidateLoop` and unwinds through the same `finally`.

A candidate marked `probe` whose claim returns non-zero is skipped, recording
`breaker:probing` — distinct from `breaker:open`, because "someone is testing it right now" and
"it is in cooldown" are different facts.

### Two costs to name

**Skipping burns an attempt.** `maxAttempts = min(settings.maxAttempts, candidates.length)`
(`dispatch/index.ts:355`) and the loop counts iterations, so a `breaker:probing` skip consumes
one. With `maxAttempts: 3` and candidates `[probeA, B, C]`, only B is tried. Under round-robin
the probe candidate has zero in-flight and ranks at the head for every request while the probe
runs, so this fires on every request during a probe. The skip must not increment `i` — it is a
candidate that was never attempted, which is what the counter means.

Relatedly: if the probe is the sole candidate and loses the claim, `lastError` is null and the
current code rejects with `ALL_CANDIDATES_FAILED` "all candidates failed"
(`dispatch/index.ts:846-852`). Nothing failed. It should be `NO_CANDIDATES`.

**A faulted release strands the slot.** If the acquire reaches Redis and a fault lands before
the release, the release goes to `fallback.gauge.release` (`coord/redis.ts:426-433`) and the
Redis slot lives until `PROBE_TTL_MS`, blocking the whole fleet from probing that pair for that
long. The same shape `rateLimit.ts:41-53` documents for the concurrency gauge. An earlier draft
claimed the fault "fails in the direction that keeps serving" — for this leg it does not. It
fails in the direction that keeps the credential out, and `PROBE_TTL_MS` is the bound on how
long.

`PROBE_TTL_MS` must exceed the request deadline (`requestDeadlineMs`, 120s default,
`packages/store/src/types.ts:1431`) so a live probe is never displaced, and should not greatly
exceed it, because it is also how long a fault strands the pair. **180s.**

One more, minor: `gauge.release` pops the oldest slot (`packages/coord/src/index.ts:238-244`).
If a probe's slot expires by TTL and a second probe acquires, the first probe's late release
pops the second's slot and a third can be admitted alongside. Two concurrent probes, bounded,
not worth extra machinery.

### The state transition

- **Claim taken** → write `breakerState: "halfOpen"`. A decision-field change, so it writes
  through and reaches other replicas.
- **Probe succeeds** → `recordSuccess` closes the breaker.
- **Probe fails** → `recordFailure`'s `current.breakerState === "halfOpen"` branch
  (`breaker.ts:114`) opens immediately without burning the threshold. Already written, already
  unit-tested at `packages/router/test/breaker.test.ts:67-74` — the test is not vacuous, the
  branch is simply unreachable in production.

`score.ts:97`'s `halfOpen` arm and the dashboard's "probing" lamp come alive with no change to
either.

### Interaction with the write-path spec

A probe success is a recovery, so it writes through under that spec's predicate — provided the
predicate is `!== "closed"` rather than `=== "open"`. That spec now says so.

The `halfOpen` write is a decision-field change, so under that spec's conditional trigger it
does bump `config_version` and does rebuild every replica's snapshot. Once per cooldown, which
is fine, but that spec's "the counter mostly stops moving" gains a mover.

Landing order: either first. If this lands first, probe recoveries write through the existing
unconditional path — which means this spec's "a successful probe closes the breaker on the
write-through path" test passes trivially and proves nothing until the other lands. Say so in
the test.

## Decisions

- **The gauge, not `lease`.** `lease.acquire(job, holder, ttlMs)` is single-holder job election
  scoped to named background jobs with a renew loop; a probe has no holder to name beyond the
  request.
- **`mutex.withLock` is wrong.** A contender should be *dropped*, not queued — waiting for the
  probe and then also probing is the flood again, arriving later. `memoryCoord.mutex` also
  carries `// ponytail: contenders race, no fairness`.
- **The probe is a real request, not a synthetic one.** Same reasoning the write-path spec
  records for rejecting a probing scheduler.

## Testing

- **N concurrent requests past an elapsed cooldown produce exactly one upstream attempt.** Stub
  `HttpClient` counting calls; assert one, and assert the other N−1 are excluded as
  `breaker:probing`.
- **A request that ranks *after* the `halfOpen` write is still excluded.** Sequential, not
  concurrent: one request claims and is mid-stream, a second ranks and must be `breaker:probing`.
  **The concurrent test above cannot catch the missing `halfOpen` guard**, because all N rank
  before the write lands — which is what "concurrent" means. This is the test for critical 2.
- **An abandoned `halfOpen` row is re-probed.** Write `halfOpen`, release the slot, rank again:
  one attempt, not zero and not a flood.
- **A skipped probe candidate does not consume an attempt.** `[probeA, B, C]`,
  `maxAttempts: 2`, claim lost: assert B *and* C were tried.
- **Sole probe candidate losing the claim yields `NO_CANDIDATES`**, not `ALL_CANDIDATES_FAILED`.
- **The slot is released on failure and on failover**, at request scope rather than
  head-of-stream: a streaming probe failing after twenty frames must not free the slot at the
  first frame. Assert no second attempt during the stream.
- **A failed probe re-opens without burning the threshold.** Reaches `breaker.ts:114` in
  production for the first time; the pure unit test at `breaker.test.ts:67-74` already covers
  the transition itself.
- **`packages/router` stays pure** — `probe` is computed from the snapshot and the clock alone;
  `eligible()` gains no async and no coord.
- **Weak, keep but do not count:** "a fault degrades to one probe per replica" using two
  `memoryCoord`s passes for any implementation that does anything per-process.

## Out of scope

- **The cooldown curve.** Unchanged. With probes actually limited to one, the hourly cap means
  one probe an hour against a long-dead credential — what `filters.ts:113-114` always claimed.
- **`rateLimitedUntil`.** A provider's park has its own expiry and needs no probe.
- **`recordFailure` writing `"closed"`** (`breaker.ts:120`), which lets a failure widen a
  breaker's admission. Pre-existing; recorded in the write-path spec.

## History

- **2026-09-07.** Found while writing the write-path spec, by grepping `halfOpen` to check
  whether a probe success counted as a recovery.
- The dead enum was the visible symptom; the flood underneath it is why this is a spec and not a
  one-line assignment. Writing `halfOpen` at the point of the comment would light the lamp and
  change no traffic, because the guard admits every concurrent request either way — a fix worse
  than the bug, since the lamp would then assert that probing worked.
- **Adversarial review, 2026-09-08, found the first draft doing precisely that.** It specified
  the `halfOpen` write and the gauge claim but left `filters.ts:240` testing `=== "open"`, so
  every request ranking after the write sailed through unclaimed. The draft's own History
  paragraph, quoted above, describes the bug the draft then shipped. Writing down the failure
  mode did not prevent implementing it — the paragraph was about a *simpler* fix, and it was not
  re-read against the design that replaced it.
