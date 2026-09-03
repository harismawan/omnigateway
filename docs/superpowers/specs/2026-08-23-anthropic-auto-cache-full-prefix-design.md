# Gateway-added Anthropic cache breakpoints: covering the whole prefix

Status: designed.
Date: 2026-08-23.
Amends: `2026-08-22-anthropic-auto-cache-breakpoint-design.md`.

## The problem, measured

The 2026-08-22 feature works and stops early. Against a live claude-code-shaped session it caches
**34.8k tokens and never more**, however long the conversation runs. The number is constant because
the marker is constant:

```ts
const target = body.system?.at(-1) ?? body.tools?.at(-1);   // wire.ts:348
```

Anthropic caches everything up to and including the marked block, and render order is tools → system
→ messages. One marker on the last system block therefore caches tools plus system and nothing else.
34.8k is the size of that prefix. Message history — which is the part that grows, and past the first
few turns the part that dominates — is billed fresh every request, forever.

The 2026-08-22 design says this in as many words. It was not an oversight; it was the scope chosen
then. This document changes the scope.

## What the reference implementation does

The captured artifact in the prior spec, re-read for placement rather than for presence:

```
claude-code | breakpoints=3 at [system[1], system[2], messages[22].content[0]]
            | system = 3 blocks, tools=24, messages=24
```

Three markers, not one. Two nested inside the system prompt, one walking the message history. One of
Anthropic's four slots left spare.

**The two system markers cannot be copied literally.** They sit at `system[1]` and `system[2]` of a
three-block system prompt: `[1]` ends the frozen core, `[2]` ends the part that churns per session —
project instructions, environment, git state, date. If `[2]` changes, `[1]` still hits. Claude Code
can place that boundary because it authored both blocks and knows which one moves. The gateway is
looking at a system prompt some stranger sent it. Choosing a split point inside it would be
placement with nothing behind it, which is the failure every guard in the prior spec exists to
prevent.

There is a stability boundary the gateway does know for certain. From Anthropic's invalidation
hierarchy, a change to system-prompt content invalidates the system and message caches and leaves
the **tools cache intact** — tools and system are separate tiers. So the faithful analogue of the
nested hedge is one marker at end-of-tools and one at end-of-system. That boundary is visible in
every request, from any client, without guessing.

## Decision

Up to three markers, placed by one rule.

> Walk the tiers in render order — tools, then system, then history. Place a marker at a tier
> boundary when that tier's prefix exceeds the last *placed* marker's prefix by ≥ 1024. Start the
> running comparison at zero, and advance it only when a marker actually lands.

| # | Position | Caches |
| --- | --- | --- |
| 1 | last tool | tools |
| 2 | last system block | tools + system |
| 3 | last cache-eligible block of the history | the whole request |

**One condition, not two.** The obvious reading wants a second test — cumulative ≥ 1024, Anthropic's
own minimum, below which a prefix silently does not cache. It is subsumed. The running comparison
starts at 0 and only ever advances to a prefix that already cleared the increment, so it is 0 or
≥ 1024; either way `prefix − marked ≥ 1024` implies `prefix ≥ 1024`. Writing both would add a branch
no input can fail, which is an equivalent mutation and precisely what the tests below exist to catch.

**The gate measures the IR, and the wire body can be smaller.** `estimateInputTokens` walks
`req.system` whole, while `toWire` (`wire.ts:370`) drops every non-text system block. An image-only
system prompt therefore contributes ~1,600 tokens to the system and whole-request prefixes that are
never sent, which can carry the history tier over the increment on a body that really grew by six
tokens. Left as is: the prefix clears Anthropic's minimum either way, the cost is one slot of four,
and filtering here would put a second copy of `toWire`'s own rendering rule in the gate — where it
would drift. Recorded so the next reader does not take the formulas as measuring the wire.

| Decision | Chosen | Rejected because |
| --- | --- | --- |
| Trigger | Unchanged: requests carrying **zero** breakpoints | Three markers of four slots still cannot reach the ceiling, and a client that placed its own is still never second-guessed |
| Marker 1 vs the old `??` | Both, not either | The `??` existed only because the old design had one slot to spend. Tools and system are different invalidation tiers; collapsing them wastes the cheaper one |
| Marker 3 placement | Last message, moving each turn | A fixed anchor needs to know where the last request put one, and the gateway holds no per-conversation state. Moving is also what the reference implementation does |
| Marker 3 stride partner | Not built | It guards one real failure mode (below). Cost is a third write per turn on every request. Measure before paying |
| Gating | One rule, on the **increment** | Three cumulative gates were specified first and were wrong — see below. A single gate over the whole request would suppress markers that would have paid |
| TTL | Unchanged: `5m`, left implicit | As before — cheapest write, and naming it sends a field the client never asked for |

### What the gate rule recovers

The prior spec rejected a case it described precisely: "a long conversation under a two-line system
prompt is an ordinary agent session, and it measured 50,014 tokens against a 6-token prefix." Under
one gate over the stable prefix that request is excluded entirely. Under this rule the tools and
system tiers place nothing — correctly, there is nothing there to cache — and the history tier
places marker 3, which is the marker that actually serves it.

### Why the increment, and not three cumulative gates

The first draft of this document gated each marker on the cumulative prefix it caches and called the
three gates independent. They are not independent, and the error is arithmetic:
`estimateInputTokens` sums non-negative terms, so tools ≤ tools+system ≤ whole request. Gate 1
passing *implies* gate 2 passing, which implies gate 3. Three reproductions off the built code:

```
big tools + 1-token system + 2-token history   → 3 markers
big system + 2-token history                    → 2 markers
big tools + no system, OAuth leg                → identity line marked
```

The first two spend two extra slots, and two extra cache writes, to re-cache a prefix the marker
below already covers. The third is the same failure in a costume worth naming separately.

### The OAuth identity line

When a client sends no system prompt on the OAuth leg, `toWire` (`wire.ts:380`) injects
`OAUTH_IDENTITY` as the only system block. A cumulative gate measures the **IR**, which has no
system, so it passes on the tools alone and marks a ~15-token extension of the tools prefix.

Under the increment rule this needs no special case: 15 < 1024, so the tier places nothing and the
injected line is never the marked block. That the same rule closes both is the reason to prefer it
over a targeted `OAUTH_IDENTITY` check — a check that names one string protects against that string
and nothing else.

## Why a message-block marker is safe after all

The prior spec's "Why never a message block" argues that marking message content reaches
`systemCacheControl()`'s promotion path, where a marker on the final cacheable block is promoted to
top-level `body.cache_control` and a marker anywhere else flips `lost` and emits
`anthropic:system-turn-cache-control-dropped` for something the client never set.

That argument does not survive reading the two functions together. `systemCacheControl()`
(`wire.ts:120`) walks `req.messages` — the **IR**. Injection writes `body.messages` — the **wire
body**, built moments earlier by `toWire`'s own flatMap. The promotion path cannot observe a wire-side
marker at all. The section was written defensively and read as a constraint; it is neither.

The rule it was protecting still holds and still matters: **the IR is never written.**
`dispatchRequest` is one object shared across every attempt, so a marker placed there survives
failover into a non-Anthropic candidate and changes what RTK and the token estimate believe the
client sent. Marker 3 writes wire-side for exactly the reason markers 1 and 2 do.

## Selecting the block for marker 3

Three ways the last message is not markable, each of which produces a silently wrong request rather
than an error:

- **Content may be a string.** `encodeSystemTurn` (`wire.ts:113`) returns a joined string for a
  mid-conversation system turn whose blocks are all text. A string carries no `cache_control`. Walk
  back to the last message whose content is an array.
- **`thinking` blocks take no `cache_control`.** Anthropic accepts it on `text`, `image`, `tool_use`,
  `tool_result`, and `document`. Walk back past anything else rather than assuming the last block is
  eligible.
- **Wire indices are not IR indices.** The flatMap at `wire.ts:394` drops any turn whose content was
  entirely unsignable reasoning. Marker 3 selects from `body.messages`; reading a position out of
  `req.messages` and applying it to the body marks the wrong turn as history grows.

`AnthropicBody.messages` is `unknown[]`, so selection narrows before it writes. That is the type
doing its job — the array holds whatever the encoders produced — and the narrowing is the same check
the three rules above already require.

## The 20-block lookback, and the marker not being built

Each breakpoint walks back at most **20 content blocks** looking for a prior cache entry. That is
what makes a moving marker work: turn N writes at end-of-history, turn N+1's marker finds that entry
within 20 blocks, reads it, and writes the extension. Hits accrue incrementally with no state on
either side.

It is also marker 3's one failure mode. An agentic turn that appends more than 20 blocks at once —
routine in a tool-heavy loop, and this gateway's traffic carries 24 tool definitions — overshoots the
window. The marker finds nothing, writes a fresh entry, and that turn's history is billed uncached.
The next turn recovers on its own.

A fourth marker on a fixed stride (every ~15 blocks from the start of history) would close it, at the
cost of a third cache write on every request including the ones that never needed it. It is not built
here. The frequency of >20-block turns is measurable from the captured bodies under
`request_bodies/`, and that measurement, not this document, should decide it. A miss costs exactly
what today's behaviour costs on every request, so the floor is never below where we already are.

## Cost

Marker 3 writes a cache entry on every turn at the 1.25× write multiplier. Repeating traffic wins
outright — the hermes case in the prior spec, four identical 20,801-token requests, goes from zero
cache reads to reading everything but the first. Genuinely one-shot traffic, where no prefix ever
recurs, pays 1.25× on the message portion for an entry nobody reads. Break-even is roughly one
reuse. This is the same bet the operator already took when `autoCacheEnabled` defaulted on for tools
and system; marker 3 extends it to the part of the request that grows.

The increment rule bounds the exposure below. A marker only exists when it extends the one under it
by at least 1024 tokens, so the worst case is three markers over three genuinely different prefixes
rather than three over the same one.

**Nested markers bill once for the union — measured, 2026-08-24.** Each entry extends the previous
rather than duplicating it, so marker 1 costs a slot and not a second write. Measured over 27,279
consecutive warm turn-pairs in `request_logs`, all of them claude-code traffic carrying three nested
markers:

```
read(N+1) / [write(N) + read(N)]   p25=1.000  p50=1.000  p75=1.000
79% within [0.85, 1.15];  2% near the 0.33 that per-marker billing would produce
```

The ratio is estimate-free — both terms come from the provider's own `usage` — which matters,
because the obvious test does not work. Comparing `cache_write` against a token estimate of the
captured body reads 14-19× on long sessions, and that is `slice(-24)` in the body capture
understating the prompt, not a billing anomaly. Any check of this that leans on a captured body is
measuring the truncator.

## Record

`anthropic:cache-breakpoint-added` keeps its meaning and now covers markers 1 and 2 — the stable
prefix. Marker 3 records `anthropic:history-cache-breakpoint-added`. Two ids rather than one because
the column is how an operator sees what the gateway did to a request, and "we cached your tools" and
"we cached your entire conversation" are not the same statement. Both dedupe through the existing
`note()` helper.

## Not fixed here

`AUTO_CACHE_MIN_TOKENS` is a flat 1024. The real minimum cacheable prefix is model-dependent and
**not monotonic across generations**: 512 on Opus 5, 1024 on Opus 4.8 and Sonnet 5/4.6, 2048 on
Opus 4.7, 4096 on Opus 4.6 and Haiku 4.5. On the last two the gate waves through prompts that
silently never cache, and on Opus 5 it suppresses markers that would have paid.

The error still runs safe — a marker on an under-sized prefix is ignored upstream at no charge — so
this stays out of scope. But the prior spec's justification for the constant, that 1024 is "the
smaller published value", is now false and is corrected in that document rather than left standing.

## Testing

In `packages/providers/test/anthropic.test.ts` unless noted.

- Each marker lands where it should, individually and with all three present.
- Marker count is exactly 3 when all three tiers are present and each clears the increment — the
  four-slot ceiling is never approached.
- Marker 1 absent when the request has no tools; marker 2 absent when it has no system. No `??`
  fallback survives: absent tools plus present system yields marker 2 alone, not marker 2 standing in
  for marker 1.
- The three reproductions above, as regression tests: a big tool set under a 1-token system prompt
  yields **one** marker, a big system prompt over a 2-token history yields **one**, and the OAuth leg
  with no client system prompt leaves `OAUTH_IDENTITY` unmarked. Each asserts the marker count *and*
  which block carries the marker.
- A tier skipped for a small increment does not stop a later tier: big tools, 1-token system,
  50,000-token history places markers on tools and history and nothing on system.
- The history-only case — the 50,014-token / 6-token-prefix request the prior design excluded.
- Marker 3 skips a string-content system turn, skips `thinking` blocks, and selects by wire index
  after a turn was dropped for unsignable reasoning.
- On that last one, note what is *not* reachable. An IR-index bug manifests as **no marker at all**,
  never as the wrong turn marked, and no fixture changes that: dropping only shortens, so the IR
  index of the last markable turn is at or past its body index — either out of range, or pointing at
  a turn the backwards walk already rejected. The test is still worth building with several
  surviving turns, because that is what makes first-versus-last read as `messages[0]` vs
  `messages[2]`; a single-turn fixture cannot distinguish them. Say so in the test rather than
  letting a later reader think the wrong-turn case is covered.
- All four already-marked shapes (system, tools, message history, vendor bag) still suppress **all
  three** markers.
- Marker 3 lands on each cache-eligible block type — `text`, `image`, `tool_use`, `tool_result`,
  `document` — one fixture per type, each ending a turn. Reviewing the first implementation found
  four of the five pinned by nothing: the allowlist could lose `tool_result`, the shape that ends
  almost every agentic turn, and the suite stayed green.
- The IR is unchanged after encoding. **Not** by cloning a shared fixture and diffing: module-level
  fixtures are handed to `toWire` unclone by earlier tests in the same file, so a leaked marker is
  already inside the clone and the assertion compares polluted to polluted. That test passed with a
  marker written to the IR. Deep-freeze the module fixtures instead — ESM is strict mode, so an IR
  write throws a `TypeError` in every test in the file rather than being missed in one.
- Flag off leaves the body byte-identical.
- The OAuth identity prefix never takes a marker.
- Both degradation ids recorded, each once, only when its marker was placed.

### Mutation checks

Each must turn the suite red: drop any one of the three markers; restore the `??` so markers 1 and 2
become mutually exclusive; gate on the cumulative prefix instead of the increment; compare the
increment against the previous *tier* rather than the last *placed* marker; mark the first system
block or first tool instead of the last; mark the first message instead of the last; drop the
`thinking` guard; **remove any single entry from the eligible-block allowlist**; index
`req.messages` instead of `body.messages`; drop the already-marked guard; write a
marker to the IR *in addition to* the body — not only instead of it; rename either degradation id;
record a degradation unconditionally; send an explicit TTL on any of the three markers.

Run the sweep against the **whole file**, not the single test named after the behaviour. Both
mutations that survived the first review — an IR write and a missing allowlist entry — are invisible
to a full-file run and caught instantly in isolation, which is the opposite of the usual failure and
the reason to check both ways.

Two mutations are **equivalent** and must not be listed as checks; a checklist item that cannot go
red teaches the next reader to ignore a green result:

- **Dropping the string-content guard** (`Array.isArray` on a message's content). A string's indexed
  characters fail `isRecord`, so the walk skips them anyway. The guard stays — it is what narrows
  `unknown` to an array so indexing typechecks at all — but it is not what skips string turns, and
  the comment beside it must not claim otherwise.
- **Adding the redundant cumulative gate** described above.

Two mutations survived a green suite during the 2026-08-22 review — dispatch reading the setting, and
`attempt` forwarding it through a spread that fails silently open. Nothing in this change touches
that path, so those tests stand as written; do not assume they cover the new markers.

## History

Measurements moved here from `CLAUDE.md` on 2026-09-03.

### System-turn retarget

Four requests each the previous plus an exchange, marked on the trailing turn, read **0** and
wrote the whole prefix every time (14,329 then 14,340 then 14,351); moved one block back, the
second request wrote **11** and read 13,896. The code used to hoist the marker to request-level
`cache_control` instead, and that behaved identically — the probe says root marker and marker on
the turn itself are both dead. Cost in production before the fix: one session of 21 consecutive
requests each rewriting ~190k tokens, 09-02 alone 5.96M cache-write tokens and $70.53, with
`cache_read_tokens` pinned at exactly the end-of-system prefix (37,960 / 38,062) — the signature
to recognise.

### Marker gating

Gating each marker on the prefix it caches is what shipped first and was wrong:
`estimateInputTokens` sums non-negative terms, so tools ≤ tools+system ≤ whole and gate 1 passing
implies the other two — a big tool set under a 1-token system prompt took 3 slots and 2 cache
writes to re-store the same bytes. The last-placed-marker rule also removed the `OAUTH_IDENTITY`
special case: the injected line is ~15 tokens, not in IR, so the system tier adds nothing and
never gets marked.

The IR-not-wire rule is pinned by deep-freezing the module fixture in
`packages/providers/test/anthropic.test.ts`, not by cloning and diffing: the fixture is handed to
`toWire` unclone by an earlier test, so a leaked marker is already inside the clone and the
assertion compares polluted to polluted. An earlier claim that `systemCacheControl` could see
wire-side markers was wrong — it walks IR.
