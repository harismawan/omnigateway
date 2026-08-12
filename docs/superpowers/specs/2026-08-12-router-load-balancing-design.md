# Router Load Balancing — Design

Date: 2026-08-12
Status: approved, not yet implemented

## Problem

The router ranks candidates well when requests arrive one at a time and badly when they arrive
together. Four defects, found by reading `packages/router` against a multi-user deployment
(tens of concurrent requests, single gateway process).

### 1. No load awareness, so concurrent requests herd

Nothing tracks in-flight work. `lastUsedAt` is written only when a request *finishes*
(`breaker.ts:68`, `:93`, `:109`), and the routing snapshot is built once and shared
(`snapshotCache.ts`). Twenty simultaneous requests therefore read identical health, score
identically, and pick the same head.

`roundRobin` is worst affected. Its sort key is `idle = now - lastUsedAt` (`index.ts:71-74`), so
"least recently used" means "least recently *finished*". Under concurrency it degenerates into
sending everything to one credential — the opposite of what the strategy name promises.

`weighted` randomises only the head (`index.ts:45-47`); its tail is score-sorted and deterministic,
so a failing head sends every concurrent request to the same second choice.

### 2. Min–max normalisation discards magnitude

`lowerIsBetter(value, min, max)` (`score.ts:10-13`) maps the worst candidate in the current set to
0 and the best to 1, whatever the spread. Latencies of 100ms and 105ms score 1.0 and 0.0. Latencies
of 100ms and 10s also score 1.0 and 0.0.

Two consequences. Configured weights have no stable meaning — `weights.latency = 1` contributes a
different real amount on every request, depending only on who else was eligible. And the `reasons`
map surfaced to operators through `dryRun` is uninterpretable: `latency: 0.0` might mean "5% slower"
or "100× slower".

### 3. The weighted lottery ignores health

`drawWeight = credential.weight * target.weight * headroom` (`index.ts:30`). A credential whose
breaker just came out of cooldown — admitted as a half-open probe (`filters.ts:106-113`) — draws at
its full configured weight. `score.ts:58` halves such a candidate, but the lottery deliberately
bypasses score, so a flapping credential keeps taking proportional production traffic.

### 4. Cost is request-blind

`blendedCost` (`score.ts:19-21`) is a fixed `input*0.25 + output*0.75`. A 200k-token prompt and a
200-token prompt rank targets identically on cost, though the cheapest target differs between them.

## Scope

In scope: all four defects above.

Out of scope, with reasons:

- **Cache-read pricing.** `Target.costPerMTok` has no cache-read field; adding one is a catalog
  change with its own migration.
- **Multi-replica load sharing.** The gateway runs as a single process. The in-flight counter is
  authoritative because of that, and this design does not try to preserve correctness if that
  changes. A multi-replica deployment would need a different mechanism, not a tuned version of this
  one.
- **Concurrency caps and queueing.** Providers already signal saturation with `429` / `OVERLOADED`,
  which `breaker.ts` parks as a soft failure. That is a discovered cap; a configured one is a number
  operators cannot pick correctly.

## Decisions

Recorded with reasoning, because the alternatives are all defensible.

**The four strategies stay, and are fixed from underneath.** The defects live in the shared scoring
layer and in the missing load signal, not in the four sort functions. Adding a fifth `leastLoaded`
strategy would leave the bug in the four strategies people already use, and would mean maintaining
five code paths. No config migration for `strategy` values.

**Load affects ordering only, never admission.** A saturated credential ranks last but stays
reachable. If everything is busy, requests still route. This adds no new failure mode and no new
operator knob.

**Ratio normalisation for continuous terms, ordinal min–max for `tier`.** Cost and latency are
magnitudes and become `min / value`: best scores 1, twice-as-bad scores 0.5, ten-times-worse scores
0.1. `tier` is a priority label rather than a magnitude, and its current dominance is intended, so it
keeps min–max.

This changes routing outcomes for existing installs on upgrade under unchanged weights. Accepted:
the current behaviour is the bug, and weights that were tuned against set-relative scores were tuned
against noise.

**`recency` is deleted rather than retuned.** Its job was spreading traffic, which it did badly
because it also measures completion rather than start. The `load` term does that job correctly.
Keeping both would double-count.

**Expected output tokens use `min(maxTokens ?? K, K)` with `K = 1000`.** `maxTokens` alone is a cap,
not a prediction — clients routinely send 64000 and return 300 — so using it directly would make
every request look output-dominated. The floor respects an unusually *low* cap, which is a real
signal and free to read. A per-target EWMA of observed output was considered and rejected: it adds
persisted state and a migration to measure the *target*, when the thing that actually varies is the
*request*, so a summarisation workload and a codegen workload on one target would average into a
number describing neither.

`K` is a module constant, not a setting. It is a prior; an operator cannot tune it meaningfully
without data the gateway does not collect.

**The weighted lottery gains `health` but not `load`.** The lottery already spreads statistically;
scaling by both makes the resulting distribution hard to reason about and hard to test.

## Design

### Load registry — `apps/gateway/src/dispatch/loadRegistry.ts` (new)

Mutable state, so it lives in the gateway. The router receives a read-only view and stays pure.

```ts
export type LoadRegistry = {
  /** Returns an idempotent release. */
  acquire(credentialId: string, model: string): () => void;
  /** healthKey -> in-flight count. */
  counts(): ReadonlyMap<string, number>;
};
```

Keyed by `healthKey(credentialId, model)`, matching health, so a credential serving two models is
tracked separately per model.

The counts are deliberately **not** part of `Snapshot`. The snapshot is cached across requests and
invalidated by version and generation; in-flight counts change many times per second, and putting
them there would invalidate the cache on every request.

### Router input — `packages/router/src/types.ts`

```ts
export type RankInput = {
  request: ChatRequest;
  model: VirtualModel;
  snapshot: Snapshot;
  now: number;
  rand: number;
  /** healthKey -> in-flight count. Read-only; the router never writes it. */
  load: ReadonlyMap<string, number>;
};
```

`request` is already present, so request-aware cost needs no plumbing:
`estimateInputTokens` (`packages/ir/src/tokens.ts:112`) is pure and `@omni/ir` is already a router
dependency.

### Scoring — `packages/router/src/score.ts`

Six terms. `recency` is removed, `load` is added.

| Term | Before | After |
| --- | --- | --- |
| `tier` | min–max | unchanged |
| `health` | `1/(1+failures)`, halved if breaker open or halfOpen | unchanged |
| `quota` | `quotaHeadroom` | unchanged |
| `cost` | min–max over fixed 25/75 blend | ratio `min/value` over request-aware cost |
| `latency` | min–max over EWMA TTFT | ratio `min/value` |
| `recency` | `min(1, idle/maxIdle)` | **deleted** |
| `load` | — | `1/(1+inflight)` |

New helper alongside `lowerIsBetter`:

```ts
/** Maps a raw value into 0..1 against the best observed, preserving magnitude. */
function ratio(value: number, min: number): number {
  return Math.min(1, min / value);
}
```

`min` is taken over **positive** values only, and a candidate whose own value is zero or missing
scores `UNKNOWN` rather than being passed to `ratio`. Both parts matter:

- A single unpriced target in an otherwise priced pool would otherwise drive `min` to 0 and zero the
  cost term for every candidate, discarding the signal for the whole pool.
- Scoring that unpriced target 1.0 would read "free", which contradicts the existing and correct
  rule that a zero price means unknown. Today's `maxCost === 0` check only catches the case where
  *every* target is unpriced; taking `min` over positive values generalises it to the mixed pool,
  which is a small behaviour fix in its own right.

The same rule covers latency: `min` spans only candidates with a recorded `ewmaTtftMs`, and one
without still scores `UNKNOWN`.

Request-aware cost:

```ts
const EXPECTED_OUTPUT_TOKENS = 1000;

const inTok = estimateInputTokens(request);
const outTok = Math.min(request.maxTokens ?? EXPECTED_OUTPUT_TOKENS, EXPECTED_OUTPUT_TOKENS);
const cost = inTok * target.costPerMTok.input + outTok * target.costPerMTok.output;
```

`UNKNOWN = 0.5` semantics are unchanged: an unmeasured latency and a fully unpriced target still
score neutral rather than best or worst. A zero-priced target still means "unpriced", not "free".

### Weights — `packages/store/src/types.ts`

```ts
weights: { tier: 10, health: 3, quota: 2, load: 2, cost: 1, latency: 1 }
```

`load: 2` sits above cost and latency and below quota: spreading traffic matters more than shaving
price, and less than not stranding an account against its window.

This is a `Settings` schema change. A store migration drops `recency` and defaults `load` to 2 on
existing rows. A row that somehow arrives unmigrated falls back to `DEFAULT_SETTINGS` rather than
crashing.

### Strategies — `packages/router/src/index.ts`

- **`score`** — sort unchanged; behaviour changes only through scoring.
- **`priority`** — unchanged.
- **`roundRobin`** — sort key becomes `spent → inflight ascending → idle descending`. This is the
  herd fix: twenty simultaneous requests see in-flight counts 0, 1, 2, 3 … and fan out, instead of
  reading one stale `lastUsedAt` and stacking.
- **`weighted`** — `drawWeight` gains health:

  ```ts
  c.credential.weight * c.target.weight * headroom(c) * health(c)
  ```

  using the same `1/(1+failures)`, halved-if-open form as scoring. The existing comment block at
  `index.ts:14-23` explaining why the draw runs over arrival order rather than score order stays
  accurate and stays.

### Dispatch — `apps/gateway/src/dispatch/index.ts`

```
snapshot = snapshotCache.get(now)          // cached, shared, unchanged
load     = loadRegistry.counts()           // fresh, per request
rank({ request, model, snapshot, now, rand, load })

candidateLoop:
  release = loadRegistry.acquire(candidate.credential.id, candidate.target.model)
  try { attempt } finally { release() }
```

`Candidate.reasons` gains `load` and loses `recency`, flowing to the request log and to `dryRun`.

`dryRun` (`packages/control/src/dryRun.ts:65`) passes an empty load map. A hypothetical request has
no in-flight peers, and its existing `deterministic: strategy !== "weighted"` reporting stays
correct.

## Error handling

**A leaked release is the only new failure mode, and it is silent.** A slot that is never released
permanently deranks a credential, with no error, until restart. Mitigations:

- `release` is idempotent — a guard flag means a double call cannot drive the count negative.
- The registry clamps at zero and never stores a negative count.
- A release that would go negative logs `logger.warn`, because it means a bug rather than a race.

No new client-visible errors. Ordering-only load means nothing about load can fail a request.
Provider `429` / `OVERLOADED` handling in `breaker.ts` is unchanged and remains the real cap.

## Testing

Router — pure, so these are cheap and are the primary coverage:

- Ratio normalisation: 100ms against 105ms scores about 1.0 and 0.95, not 1.0 and 0.0; 100ms against
  10s scores about 1.0 and 0.01. Unmeasured latency and unpriced cost still land on `UNKNOWN`.
- Mixed pricing: one unpriced target alongside priced ones scores `UNKNOWN` itself and leaves the
  priced candidates' cost scores unchanged, rather than collapsing them all to zero.
- Request-aware cost: the same pool ranks differently for a small request and a 200k-token request.
  `maxTokens: 100` shifts the blend towards input.
- `roundRobin` with in-flight `{a: 0, b: 2, c: 1}` orders `a, c, b` regardless of `lastUsedAt`.
- `weighted` never draws a breaker-open candidate at full configured weight.
- **Herd regression.** Rank repeatedly against a registry that acquires without releasing; assert the
  head rotates rather than pinning. This is the test that would have caught the original defect, and
  it is the one to write first.

Gateway:

- `loadRegistry.test.ts` — release fires on every path: success, pre-commit failure, post-commit
  failure, client abort, deadline timeout, and generator early return when a client hangs up
  mid-stream. Each asserts the count returns to zero. Double release is a no-op.
- `dispatch.test.ts` — the count is zero after a completed streaming request.

Store:

- Migration: a settings row carrying `recency` and no `load` loads with `load: 2` and no `recency`.

Existing tests that will legitimately change: assertions in `rank.test.ts` tied to min–max scoring,
and anything asserting `reasons.recency`.

## Known gaps

- Cache-read and cache-write pricing are invisible to the cost term. For a heavily cached workload
  the estimate overstates input cost, since cache reads are priced well below fresh input.
- `EXPECTED_OUTPUT_TOKENS` is a fixed prior. It is wrong for any specific request and only aims to be
  unbiased across a mixed workload.
- In-flight counts are process-local and reset on restart, like the existing rate limits and quota
  cooldowns.
