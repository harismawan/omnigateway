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

Two things follow, and the second is the expensive one.

**`halfOpen` is read in three places and written in none.** `packages/router/src/breaker.ts:114`
opens immediately when `current.breakerState === "halfOpen"` — the "a failed probe means the
credential is still down" rule, which cannot fire. `packages/router/src/score.ts:97` halves the
score for `open` or `halfOpen` — the second arm is unreachable. `apps/dashboard/src/lib/vitals.ts:261-264`
renders a "probing" lamp that cannot light. `grep -rn halfOpen` over `packages/` and `apps/`
outside tests returns those three readers and no assignment.

**Nothing limits the probe to one request.** Once `elapsed` passes the cooldown, the guard stops
dropping and every candidate evaluation admits the credential. A burst of two hundred concurrent
requests arriving one millisecond after the cooldown expires sends two hundred requests to a
credential last known to be dead. They fail; `recordFailure` re-opens the breaker and moves
`openedAt` to now, so the cycle restarts. `consecutiveFailures` keeps climbing, `cooldownMs`
doubles per failure past threshold and caps at an hour — so the steady state for a permanently
dead credential is **a full traffic flood once an hour, indefinitely**.

Each request in that flood also writes health, at roughly six sequential round-trips on one
advisory lock (see [the write-path spec](2026-09-07-credential-health-write-path-design.md)).
The flood and the write herd are the same event.

The circuit breaker exists to stop sending traffic to something that is down. Past the first
cooldown it does the opposite of that on a schedule.

## Design

A probe is a claim, and the claim has to be made somewhere that can perform I/O.

### The claim

One in-flight probe per `(credentialId, model)` across the fleet, taken through the existing
gauge:

```ts
const held = await coord.gauge.acquire(`probe:${healthKey(id, model)}`, PROBE_TTL_MS);
// held === 0  -> this request is the probe
// held  >  0  -> someone is already probing; treat the credential as still open
```

`gauge.acquire` returns the count *before* the acquisition and, per the coord invariant
(`packages/coord/src/index.ts:12-17`), the claim is visible to every concurrent claimant at call
time rather than when the promise settles. That is exactly the property "exactly one of two
hundred concurrent requests wins" needs, and it is the same property `rateLimit.ts` already
relies on.

`gauge` is also in the fail-open set (`apps/gateway/src/coord/redis.ts:216-227`): a Redis fault
degrades the claim to per-process, so a fleet of N replicas sends N probes instead of one.
Still bounded, still nothing like a flood, and it fails in the direction that keeps serving.

`PROBE_TTL_MS` releases a slot whose holder died mid-probe, the same role `GAUGE_TTL_MS` plays
for concurrency slots (`apps/gateway/src/auth/rateLimit.ts:41-53`). It must exceed the request
deadline; a probe that outlives it admits a second probe, which is the direction that recovers
rather than the one that stalls.

### Where it goes

**Not in `packages/router`.** That package is pure — no I/O, no clocks, no coordination
(CLAUDE.md, boundary 3). `filters.ts` keeps deciding *whether a credential is in probe
territory*; it cannot decide *who gets to probe*.

So `eligible()` reports the fact rather than acting on it. The `Pair` it already returns gains a
flag — `probe: true` — set where the comment is today, for a candidate whose breaker is open and
whose cooldown has elapsed. Ranking is unchanged: a probe candidate is still scored, still
halved by `score.ts:97`, still ordered normally.

Dispatch makes the claim, in the candidate loop, immediately before the attempt
(`apps/gateway/src/dispatch/index.ts`, at the top of the iteration where `checkCancellation()`
already sits). A candidate marked `probe` whose claim comes back non-zero is skipped exactly as
a filtered candidate is, with a `drop`-equivalent degradation recorded as `breaker:probing` —
distinct from `breaker:open`, because "someone else is testing it right now" and "it is in
cooldown" are different facts and an operator reading a degradation should not have to guess
which.

Release goes where the concurrency slot's release goes, at request scope: the probe is over when
the attempt resolves either way. It must not be released at head-of-stream — a probe that
streams for thirty seconds and then fails is not a successful probe, and freeing the slot at
first byte would admit a second probe against a credential that is still failing.

### The state transition

With a claim in place, `halfOpen` becomes writable, and the three existing readers start
working as written:

- **Claim taken** → write `breakerState: "halfOpen"`. This is a decision-field change under the
  write-path spec, so it writes through immediately and reaches other replicas.
- **Probe succeeds** → `recordSuccess` closes the breaker, as it already does.
- **Probe fails** → `recordFailure`'s existing `current.breakerState === "halfOpen"` branch
  (`breaker.ts:114`) opens immediately without burning the threshold. That branch is already
  written and already tested; it has simply never been reachable.

`score.ts:97`'s `halfOpen` arm and the dashboard's "probing" lamp both come alive with no change
to either.

**This is the whole reason to write `halfOpen` rather than keep the claim purely in coord.** The
state is what tells the *other* replicas to stop treating the credential as merely
cooldown-expired, and it is what an operator sees. A claim nobody can read is a lock, not a
state.

### Interaction with the write-path spec

That spec makes a successful request silent unless it is a recovery. A probe success *is* a
recovery — the breaker was `halfOpen`, not `closed` — so it writes through, which is the
behaviour that spec already specifies. The condition there is "was the breaker open?", and it
must be read as "was it anything other than closed", so `halfOpen` counts. Worth stating,
because a literal `=== "open"` check would make every probe recovery silent and strand the
credential in `halfOpen` — the failure mode this spec exists to remove, reintroduced by a
narrower comparison.

Order: either spec can land first. If this one lands first, probe recoveries write through the
existing unconditional path. If the other lands first, its recovery predicate must be written
against `!== "closed"` from the start.

## Decisions

- **One probe per `(credentialId, model)`, not per credential.** A credential can be healthy for
  one model and refused for another — quota and capability differ per model, and `credential_health`
  is keyed on the pair for that reason. Probing per credential would let a working model's
  success close a breaker a different model opened.
- **The gauge, not `lease`.** `lease.acquire(job, holder, ttlMs)` is single-holder job election
  and would fit, but it is scoped to named background jobs with a renew loop, and a probe has no
  holder to name beyond the request. `gauge` already carries the "claim visible at call time"
  guarantee this needs, already fails open, and is already threaded into dispatch.
- **`mutex.withLock` is wrong here.** A contender should be *dropped*, not queued: waiting for
  the probe to finish and then also probing is the flood again, arriving slightly later.
  `memoryCoord.mutex` also carries `// ponytail: contenders race, no fairness`.
- **The probe is a real request, not a synthetic one.** Same reasoning the write-path spec
  records for rejecting a probing scheduler: a synthetic probe is billed, and a one-token probe
  succeeds against a credential that would fail the real request.

## Testing

- **N concurrent requests past an elapsed cooldown produce exactly one upstream attempt.** The
  central claim. An in-memory coord and a stub `HttpClient` counting calls; assert one, and
  assert the other N−1 are excluded as `breaker:probing`. This is the test the current code
  fails.
- **A failed probe re-opens without burning the threshold.** Reaches `breaker.ts:114`, which no
  test can reach today — worth checking that the existing breaker tests around that line are
  currently vacuous, and saying so if they are.
- **A successful probe closes the breaker**, and does so on the write-through path rather than
  being swallowed as a silent success.
- **The slot is released on failure as well as success**, and at request scope rather than at
  head-of-stream: a streaming probe that fails after twenty frames must not have freed the slot
  at the first frame. Assert no second attempt during the stream.
- **A fault degrades to one probe per replica, not a flood.** Two coord instances standing in
  for two replicas with the shared table faulted; assert two attempts, not 2N.
- **`packages/router` stays pure.** The `probe` flag is computed from the snapshot and the clock
  and nothing else; `eligible()` gains no async and no coord. Existing purity pins cover this if
  the flag is genuinely a field on `Pair`.

## Out of scope

- **The cooldown curve itself.** `cooldownMs` doubling past threshold, capped at an hour
  (`filters.ts:116-119`), is unchanged. With probes actually limited to one, the cap means one
  probe an hour against a long-dead credential, which is what the comment at `filters.ts:113-114`
  always claimed it meant.
- **`rateLimitedUntil`.** A rate-limit park is a claim from the provider with its own expiry and
  needs no probe: when it expires, the credential is admitted normally. Only the breaker gets a
  probe.
- **Making `drop` reasons machine-readable.** `breaker:probing` joins a set of forensic strings
  that CLAUDE.md notes are never parsed. It stays text.

## History

- **2026-09-07.** Found while writing the write-path spec, by grepping `halfOpen` to check
  whether a probe success counted as a recovery. It does not currently arise, because nothing
  ever sets the state.
- The dead enum was the visible symptom and the cheap thing to fix. The flood was underneath it
  and is the reason this is a spec rather than a one-line assignment: writing `halfOpen` at the
  point of the comment would light the dashboard lamp and change no traffic, because the guard
  admits every concurrent request either way. A fix that made the symptom go away without
  touching the flood would have been worse than the bug, since the lamp would then assert that
  probing was working.
