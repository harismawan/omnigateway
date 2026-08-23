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

Three markers, each independently gated.

| # | Position | Caches | Gate |
| --- | --- | --- | --- |
| 1 | last tool | tools | tools alone ≥ 1024 |
| 2 | last system block | tools + system | tools + system ≥ 1024 *(the 2026-08-22 gate, unchanged)* |
| 3 | last cache-eligible block of the last message | the whole request | whole request ≥ 1024 |

| Decision | Chosen | Rejected because |
| --- | --- | --- |
| Trigger | Unchanged: requests carrying **zero** breakpoints | Three markers of four slots still cannot reach the ceiling, and a client that placed its own is still never second-guessed |
| Marker 1 vs the old `??` | Both, not either | The `??` existed only because the old design had one slot to spend. Tools and system are different invalidation tiers; collapsing them wastes the cheaper one |
| Marker 3 placement | Last message, moving each turn | A fixed anchor needs to know where the last request put one, and the gateway holds no per-conversation state. Moving is also what the reference implementation does |
| Marker 3 stride partner | Not built | It guards one real failure mode (below). Cost is a third write per turn on every request. Measure before paying |
| Gates | Three, independent | Each marker caches a different prefix. One gate over all three would either suppress a marker that would have paid or wave through one that cannot cache |
| TTL | Unchanged: `5m`, left implicit | As before — cheapest write, and naming it sends a field the client never asked for |

### Why the gates must be separate

The prior spec rejected a case it described precisely: "a long conversation under a two-line system
prompt is an ordinary agent session, and it measured 50,014 tokens against a 6-token prefix." Under
one shared gate that request is excluded entirely. Under three, it fails gates 1 and 2 — correctly,
there is nothing there to cache — and passes gate 3, which is the marker that actually serves it.
The separation is not bookkeeping; it is the case the old design had to throw away.

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

**One claim here is unverified.** Nested markers over the same prefix are expected to bill
`cache_creation_input_tokens` once for the union rather than once per marker, because each entry
extends the previous rather than duplicating it. If that is wrong, marker 1 costs a second full write
and stops being nearly free. It is directly readable from `usage` on the first live request after
deploy. Keeping marker 1 is contingent on that measurement — the code is written so removing it is
deleting one branch, not unpicking a design.

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
- Marker count is exactly 3 when tools, system, and messages are all present and all gates pass —
  the four-slot ceiling is never approached.
- Marker 1 absent when the request has no tools; marker 2 absent when it has no system. No `??`
  fallback survives: absent tools plus present system yields marker 2 alone, not marker 2 standing in
  for marker 1.
- Each gate independently: a request passing only gate 3 receives only marker 3, which is the
  50,014-token / 6-token-prefix case the prior design excluded.
- Marker 3 skips a string-content system turn, skips `thinking` blocks, and selects by wire index
  after a turn was dropped for unsignable reasoning.
- All four already-marked shapes (system, tools, message history, vendor bag) still suppress **all
  three** markers.
- The IR is unchanged after encoding, asserted by encoding twice and checking the second pass still
  sees an unmarked request.
- Flag off leaves the body byte-identical.
- The OAuth identity prefix never takes a marker.
- Both degradation ids recorded, each once, only when its marker was placed.

### Mutation checks

Each must turn the suite red: drop any one of the three markers; restore the `??` so markers 1 and 2
become mutually exclusive; collapse the three gates into one; mark the first system block or first
tool instead of the last; mark the first message instead of the last; drop the string-content guard;
drop the `thinking` guard; index `req.messages` instead of `body.messages`; drop the already-marked
guard; write the marker to the IR instead of the body; rename either degradation id; record a
degradation unconditionally; send an explicit TTL.

Two mutations survived a green suite during the 2026-08-22 review — dispatch reading the setting, and
`attempt` forwarding it through a spread that fails silently open. Nothing in this change touches
that path, so those tests stand as written; do not assume they cover the new markers.
