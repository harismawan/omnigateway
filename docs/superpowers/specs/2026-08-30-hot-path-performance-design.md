# Hot-path performance: six findings, ordered, and what was measured as fine

## Problem

A dedicated performance pass over the request path (2026-08-30) found six places
where the gateway does more work than the job needs, and confirmed that the
load-bearing design decisions — rollup-backed sums, synchronous limiter claims,
bounded queues, coalesced push — hold. Nothing here is a correctness bug. Each
finding is real, has a file and line, and has a fix that changes no behaviour;
they are ordered by how often the code runs times how much it wastes.

Two facts frame all of it. `bun:sqlite` is synchronous, so every store write on
the request path blocks the whole event loop, not one request — the same fact
that already shaped `usage_rollup` and forbids timeouts around store reads. And
the per-chunk stream path is the hottest loop the gateway has: it runs once per
network chunk of every streamed provider response, which is nearly every
response.

## Findings

### P1 — the SSE parser re-normalizes its whole buffer per chunk

`packages/providers/src/sse.ts:21`:

```ts
buf += decoder.decode(value, { stream: true });
buf = buf.replaceAll("\r\n", "\n");
```

The `replaceAll` runs over the **entire accumulated buffer on every chunk**.
While a record is incomplete — no `\n\n` yet — the buffer only grows, so a
record spanning many chunks re-scans and re-allocates its whole prefix once per
chunk: O(n²) in record size. Large tool results, providers that flush coarsely,
and any big non-delta frame all produce exactly that shape. Even the common
case pays a full rescan of already-normalized text per chunk.

**Fix.** Normalize only the appended segment, carrying the one character that
can straddle a chunk boundary: if the buffer ends in `\r`, hold that byte back
from the scan and prepend it to the next chunk's segment before normalizing.
Everything after the append is then already `\n`-only and is never rescanned.
The alternative — dropping the normalize and teaching `parseRecord` and the
separator search about `\r\n\r\n` — spreads the CRLF knowledge over three
sites; the carry keeps it in one.

**Testing.** The mutation target is the carry: feed a record split *between*
`\r` and `\n`, and a chunk that ends in a bare `\r` followed by ordinary text,
and assert the parsed messages are identical to the unsplit feed. A fix without
the carry passes every whole-chunk test and corrupts exactly the boundary case.

> **Implemented, and the fix is only half of what this finding claimed.**
> Removing the `replaceAll` removed one of *two* superlinear terms. The
> separator search — `buf.indexOf("\n\n")` from index 0 — still scans the whole
> accumulated buffer on every chunk, and because `indexOf` forces a rope
> flatten it dominates what is left. Measured on a single record delivered in
> 1 KB chunks, no separator present:
>
> | chunks | before | after | scan newest segment only |
> |---|---|---|---|
> | 1,000 | 82 ms | 53 ms | 0.9 ms |
> | 4,000 | 1,286 ms | 1,087 ms | 2.9 ms |
> | 8,000 | 6,393 ms | 4,969 ms | 3.9 ms |
> | 16,000 | — | 19,859 ms | 8.9 ms |
>
> Still 4× per doubling: a ~22% constant-factor win on an unchanged curve. A
> control that appends and never scans runs in 0.1 ms at every size, which puts
> the whole remaining cost in `indexOf`. Resuming the search from the join point
> does **not** fix it — the flatten still happens. Only holding pending segments
> in an array and scanning the newest segment plus a one-character overlap is
> actually linear.
>
> Recorded rather than quietly fixed because the original text, the commit
> message and the PR all present this as *the* fix for the superlinear path, and
> a reader who believes that will not look here again.
>
> **Since fixed, in a follow-up commit on the same PR.** Segments are held in an
> array and joined once per record, so nothing accumulates into a growing string
> and no scan ever revisits the prefix. Same benchmark, one record in 1 KB
> chunks:
>
> | chunks | original | after `replaceAll` removal | after the rewrite |
> |---|---|---|---|
> | 1,000 | 82 ms | 53 ms | 2.6 ms |
> | 4,000 | 1,286 ms | 1,087 ms | 7.9 ms |
> | 8,000 | 6,393 ms | 4,969 ms | 13.7 ms |
> | 16,000 | — | 19,859 ms | 28.8 ms |
>
> Doubling with the input rather than quadrupling — about 690× at the top of the
> range. The carry and the normalization both went with it: CRLF is now handled
> at the two sites where it is observable, `separatorEnd` (which accepts `\n\n`
> and `\n\r\n`, together covering all four LF/CRLF blank-line spellings) and
> `parseRecord` (which drops one trailing `\r` per line).
>
> The decision to keep CRLF support at all rests on measurement rather than
> assumption, and the measurement is partial: 25 captured production Anthropic
> streams carry 1,755 LF and **zero** CRLF or bare CR. OpenAI, `custom` and
> OpenRouter are unmeasured — a live OpenAI probe returned 401 with a
> `text/plain` body, and refreshing the credential to retry was refused because
> OAuth refresh rotation would have invalidated the token the running
> installation holds. Support was kept on the grounds that the failure mode if
> some provider does emit CRLF is a *visible* hard failure on an unknown event
> name, not silent corruption.
>
> **The audit's third recommendation is now done too.** `MAX_RECORD_CHARS`
> caps one assembled record at 25 MiB and refuses past it with a retryable
> `UPSTREAM` `GatewayError`. Being linear made the parser willing to assemble a
> record for as long as bytes arrive, which left the remote party deciding how
> much memory the gateway commits — the response-side twin of the absent
> `/v1/*` body ceiling.
>
> The figure is chosen headroom, not something the measurements imply. What they
> say: the same 25 captured responses ran 3,035–26,117 characters whole with
> 45–270 line breaks, so records are ~100–250 characters — the cap sits ~100,000×
> above the largest observed one, ~1,000× the largest whole response, and 50×
> `MAX_ARTIFACT_BYTES`. Deliberately generous, because being wrong low refuses
> legitimate traffic while being wrong high only bounds memory higher. **The
> bound is per concurrent stream**, so the number to reason about under load is
> N × 25 MiB for N streams mid-record; it is a ceiling on the pathological case,
> four orders of magnitude above real records. It shipped at 1 MiB and was raised
> on the operator's call.
>
> It is per **record**, not per stream; the test for that splits each record
> across two chunks, because with one record per chunk the accumulator is empty
> at every completion and a build that never resets it passes anyway — measured,
> that version left the mutant alive. Every size in those tests is derived from
> the constant, so raising the cap cannot quietly put a total back under it and
> retire the assertion.
>
> One behaviour change, pinned by its own test: a `\r` ending the final line is
> now a terminator rather than data, so `data: a\r` yields `"a"` where it used
> to yield `"a\r"`. The SSE grammar terminates a line with CRLF, LF or CR, so
> this is the correct reading. A bare CR *between* lines is still not a
> terminator — unchanged, and still a gap.
>
> One behaviour change fell out of it, unmentioned at the time. `replaceAll` is
> not idempotent — `R("\r\r\n") = "\r\n"` — so running it once per chunk over
> the whole buffer collapsed an extra `\r` per pass, which made the *old*
> parser's output depend on where chunks happened to split. The new code applies
> it exactly once per byte and is chunk-independent, matching what the old code
> produced for an unsplit stream. Every divergence requires a literal `\r\r`;
> there are none without one. Arguably a fix, but it was neither intended nor
> tested.

### P2 — every successful request writes a health row that usually says nothing

> **Superseded at implementation time. Do not implement as written below.** Two
> things were measured wrong, and both are recorded here rather than edited away
> because the reasoning is the reusable part.
>
> **The identity never holds.** `recordSuccess`
> (`packages/router/src/breaker.ts:74-82`) returns `lastUsedAt: opts.now` on
> every success and recomputes `ewmaTtftMs` whenever a TTFT sample exists. A
> field-for-field identity therefore requires two successes inside one
> millisecond with no TTFT — so the skip below would fire on approximately no
> requests. Neither field is cosmetic: `lastUsedAt` is the idle-time routing
> tiebreak (`packages/router/src/index.ts:89`) and `ewmaTtftMs` is the latency
> score (`packages/router/src/score.ts:105,138`), so widening the comparison to
> ignore them is a routing change, not an optimization.
>
> **The cost was not the write.** The share was right — `updateHealth` was 24%
> of a request's store time with failover, 32% without — but the cause was
> `PRAGMA synchronous` defaulting to FULL, which fsyncs the WAL on every commit.
> Measured on xfs, 1,000 iterations after warmup:
>
> | | FULL | NORMAL |
> |---|---|---|
> | `updateHealth`, read + write | 2,177.3 µs | 16.4 µs |
> | `updateHealth`, read + skip write | 2.0 µs | 1.8 µs |
>
> Setting `synchronous = NORMAL` in `packages/store/src/sqlite/db.ts` took a
> request's whole store time from 9,075 µs to 315 µs — more than every finding
> in this document combined, and it is one line. At NORMAL a perfect skip of the
> health write would save 14.6 µs, which does not justify touching a routing
> input. **P2 is closed as won by the pragma.**
>
> The transferable lesson: the finding located the right *row in the profile*
> and inferred the wrong *cause* from it, and the fix that followed from the
> inference would have been a behaviour change worth 0.16% of the one that
> followed from measuring. Measure the layer below the one that looks slow
> before designing around it.

`apps/gateway/src/dispatch/index.ts:636-642`: the success path awaits
`persistHealth` → `credentials.updateHealth`, a write transaction, once per
request. A request already pays `beginLog`'s insert, `routeLog`'s update on
failover, and `finishLog`'s append-plus-two-rollups transaction; this is the
one of the set that is usually an identity — a healthy credential's
`recordSuccess` mostly rewrites the row to what it already says.

**Fix.** Skip the write when the transition is an identity, and decide that
**inside `updateHealth`, against the row the transaction read** — never against
`snapshot.health`, which was read before the upstream call and is stale by the
time this runs; that staleness is the documented reason the transition applies
to the disk row at all. Identity means the resulting row equals the stored row
field for field. It is not "status was healthy": `recordSuccess` also decays
failure counters and clears breaker state, and a skip keyed on the label would
freeze a decaying counter at its current value forever, which is a limiter that
never forgives. Cuts roughly a fifth to a quarter of per-request synchronous
writes at steady state.

**Testing.** Two mutation targets. A credential mid-decay must still write —
assert the stored counter moves across two successes after a failure. And the
skip must be observable: a spy store asserting `updateHealth` performed no
write for a blank→blank success, which is what keeps the fix from regressing
into always-write silently.

### P3 — one frame is serialized once per subscriber, and again per retry

`apps/gateway/src/stream/registry.ts:254`: `flush` calls
`JSON.stringify(frame)` at send time. A publish to N connections stringifies
the same frame N times, and a frame parked at the queue head by backpressure
(`status === 0`) is re-stringified on every subsequent drain until it goes out.

**Fix.** Serialize once in `publish` and queue strings. The queue's drop
accounting, capacity, and head-retry semantics are untouched — only the
element type changes. The per-connection frames (`ack`, `error`, replay) can
serialize at their single call sites; nothing there fans out.

**Testing.** Behavioural coverage already pins the queue semantics; add one
assertion that a two-subscriber publish invokes the serializer once (inject or
spy), which is also the assertion that catches a future per-connection
`stringify` creeping back in.

### P4 — the limiter walks every key on every request

`apps/gateway/src/auth/rateLimit.ts:268,315`: `admit` and `consume` both open
with `cleanup(now)`, which iterates the whole key map; each entry's
`ring.count(now)` allocates via `slice`
(`packages/ratelimit/src/window.ts:32`). O(active keys) per request, plus one
array allocation per key walked.

**Fix.** Two independent halves. Time-gate `cleanup` — run it at most once per
second, tracked by a `lastCleanup` instant — which makes it amortized O(1)
without changing what it drops: an entry that would have been dropped
mid-second is dropped at the next gate, and nothing reads a droppable entry in
between. And make `SlidingWindow.count` trim in place (`splice` or an index)
rather than reallocating; the array is bounded by the `1m` ceiling, so the
allocation is small but runs on every claim of every limited key.

**Testing.** The gate's mutation target is the interval arithmetic: with an
injected clock, two calls inside one second walk once, a call after the gate
walks again. The existing cleanup-condition tests keep pinning *what* is
droppable.

### P5 — autoCache walks the request three times per attempt

`packages/providers/src/anthropic/wire.ts:483-506`: the three tier prefixes
are computed as three separate `estimateInputTokens` calls — tools alone,
tools+system, whole request — so tools are summed three times and system
twice, on every attempt of every marker-eligible request.

**Fix.** One walk producing the three cumulative sums: the tiers are nested by
construction (that nesting is the documented reason the gating compares
against the last *placed* marker), so `toolsPrefix`, `systemPrefix` and the
total are one pass with two checkpoints. The estimate function itself is
untouched; only this caller stops calling it three times.

**Testing.** The existing auto-cache suite in
`packages/providers/test/anthropic.test.ts` pins marker positions and types
against the deep-frozen fixture; it is the harness that proves the single-walk
refactor placed every marker where three walks did. No new test shape needed —
the change is invisible if it is correct, which is the point.

### P6 — body capture accumulates a response by string concatenation

`apps/gateway/src/bodyCapture.ts:197`: `entry.responseText += decoder.decode(…)`
per chunk, up to the artifact cap. JavaScriptCore's rope strings make this
tolerable rather than quadratic, but a chunk array joined once at the end of
`drain` is strictly cheaper and removes the reliance on an engine
representation detail. Opt-in path — runs only with body capture on — which is
why it is last.

**Fix.** Collect decoded segments in an array, join in the `finally` (and once
in the flush after the loop). `framesOf` and the cap arithmetic already work
on the joined result and byte counts respectively; neither changes.

**Testing.** Existing capture tests cover content and truncation; they pin the
join. Nothing new needed.

## Measured and accepted — no action, stated so the next pass does not re-open them

- **`store.routing.version()` per request** (`dispatch/snapshotCache.ts:62`) is
  a `PRAGMA data_version` read: synchronous, sub-microsecond, and the whole
  mechanism by which the snapshot cache notices a write. Caching it would be
  caching a cache key.
- **`apply`'s quotaSaved shape** (`snapshotCache.ts:43-54`) filters the row
  array once per credential in the change — O(rows × credentials) over a
  handful of each, on the poller's cadence, not the request path.
- **`sumSince` and `oldestSince`** are flat: rollup buckets plus a one-hour
  edge scan under `idx_request_logs_key_at`, and an index-served `MIN`. This
  is the design that replaced the unbounded `SELECT SUM`; nothing to do.
- **Memory growth is bounded everywhere it was checked**: limiter debits
  (`MAX_DEBITS` with folding, never dropping), socket queues (capacity with
  counted drops), the stream ring, coalescer pending entries, capture caps.
  The decoders hold no accumulating strings — `sse.ts` is the only buffer,
  which is why P1 is the finding and not them.
- **Coalescing floors** (`stream/broadcaster.ts:67-75`) are the load-bearing
  perf design on the push path and are correctly a single table.
- The absent `/v1/*` body-size ceiling is the top memory-exhaustion item and
  is tracked as a security finding, not here — one fix, one home.

## Sequencing

P1 first — it is the per-chunk path of every stream and the only superlinear
entry. P2 second — the largest event-loop win, and the one with real mutation
surface. P3–P6 are independent, opportunistic, and safe to batch with adjacent
work. Nothing here blocks or is blocked by anything else in flight.

**As implemented:** P1, P3, P4, P5 and P6 landed as described. P2 was closed
without the change it proposed — see the note under that finding — and the
`synchronous = NORMAL` pragma it led to is the largest win in the set by two
orders of magnitude.

## Out of scope

- **No timeout around store reads**, reaffirmed: `bun:sqlite` is synchronous
  and the timer cannot fire until the query returns. The fix for store cost is
  doing less of it (P2), never bounding it.
- **No async SQLite driver, no worker thread for writes.** Either would
  re-open every ordering guarantee `finishLog` and the swap forwarder are
  built on, for throughput this deployment shape does not need.
- **No benchmark harness.** Each fix above is pinned by behaviour tests;
  timing assertions in CI are flake generators. The measurements that
  motivated the ordering live in this document.
- **No further pragma tuning.** `synchronous = NORMAL` is taken and documented
  in `ARCHITECTURE.md#storage`. `OFF` is not: what it gives up over NORMAL is
  **integrity** — SQLite says the database "might become corrupted if the
  operating system crashes" — for no measured gain, since NORMAL already
  removes the per-commit fsync. Both settings keep durability across an
  application crash, so that is not the distinction; an earlier version of this
  line said it was.
