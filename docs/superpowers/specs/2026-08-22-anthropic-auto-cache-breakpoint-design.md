# Gateway-added Anthropic cache breakpoint

Status: implemented, superseded in part.
Date: 2026-08-22.
Amended by: `2026-08-23-anthropic-auto-cache-full-prefix-design.md`, which adds a marker at
end-of-tools and one on the message history. Two sections below no longer hold and say so inline:
"Why never a message block" and the one-constant argument under "The gate measures the prefix".

## The problem, measured

Measured against the live gateway on 2026-08-22, over seven days of `request_logs`:

| Key | Requests | Uncached input | Cache read | Cache write |
| --- | --- | --- | --- | --- |
| claude-code | 15,342 | 5,461,538 | 2,689,130,170 | 105,192,550 |
| **hermes** | **492** | **552,648** | **0** | **0** |

Same gateway, same models, same 24 tools. Hermes had never once read from cache.

A captured body artifact settled why. Structure only, no prompt text:

```
claude-code | breakpoints=3 at [system[1], system[2], messages[22].content[0]]
            | system = 3 blocks, tools=24, messages=24
hermes      | breakpoints=0 at []
            | system = STRING,  tools=24, messages=1
```

Hermes sends **no `cache_control` at all**, and sends `system` as a plain string, which cannot carry
one — the field lives on a content block. Anthropic's prompt caching is opt-in: with no breakpoint
there is no write, so there is nothing to read, so every token bills at full rate. The wire body the
gateway produced carried zero breakpoints too, and no degradation claimed otherwise: the gateway was
forwarding faithfully and had nothing to drop.

Four consecutive *identical* 20,801-token hermes requests were each billed in full. The minimum
cacheable prefix is ~1024 tokens, so size was never the obstacle.

## Decision

The correct fix is in the hermes client. This does it at the gateway instead, by explicit operator
decision, so every current and future client that under-marks benefits without client changes.

**This modifies the caller's request**, which is a departure from the rule that the gateway preserves
breakpoints rather than inventing them. It is defensible only because `cache_control` is a caching
directive: it changes neither the tokens the model sees nor the output it returns, unlike prompt
scrubbing or schema rewriting. It *does* change billing, which is why every guard below is
load-bearing rather than defensive.

| Decision | Chosen | Rejected because |
| --- | --- | --- |
| Scope | Requests carrying **zero** breakpoints | Anthropic caps at 4 and claude-code already sends 3; topping up risks a 400 and second-guesses a placement that is already correct |
| Default | On | Operator's call. Only defensible because the size gate is measured correctly — see below |
| TTL | `5m`, left implicit | The cheapest write multiplier, and naming it would send a field the client never asked for |
| Placement | Last system block, else last tool | Render order is tools → system → messages, so this covers the whole stable prefix and excludes the volatile turn |
| Size gate | ~1024 tokens **of the prefix** | See "The gate measures the prefix" |
| Malformed setting | Reads as off | Matches every other request-rewriting flag; a garbled row returns the installation to its pre-feature behaviour, which costs nothing |

## Why never a message block

`systemCacheControl()` (`packages/providers/src/anthropic/wire.ts`) handles markers on
mid-conversation system-role messages. A marker on the final cacheable block is *promoted* to
top-level `body.cache_control`, which is different semantics from an inline breakpoint; a marker
anywhere else flips its `lost` flag and emits `anthropic:system-turn-cache-control-dropped` for a
marker the client never set. Restricting injection to `system` and `tools` avoids that path entirely.

> **Correction (2026-08-23).** This section is wrong, and restricting injection was never what
> avoided the path. `systemCacheControl()` walks `req.messages` — the IR. Injection writes
> `body.messages` — the wire body. The promotion path cannot observe a wire-side marker at all. The
> rule that actually protects it is the one in the next section, which is unaffected: the IR is never
> written. See `2026-08-23-anthropic-auto-cache-full-prefix-design.md`.

## Why the IR is never touched

`dispatchRequest` is one shared object across every attempt. A breakpoint written onto it would
survive failover into a non-Anthropic candidate, and would change what RTK's classification and the
token estimate believe the client sent. The injection therefore writes only to the wire body, whose
`system` and `tools` arrays `toWire` has just built from fresh object literals. This is the same trap
the tool-name cloak documents, and it is pinned by a test that encodes twice and asserts the second
pass still sees an unmarked request.

## The gate measures the prefix

`estimateInputTokens(req)` counts tools, system **and every message**. The breakpoint caches only
tools and system. Gating on the whole request therefore waves through a request whose prefix is far
too small to cache — a long conversation under a two-line system prompt is an ordinary agent session,
and it measured 50,014 tokens against a 6-token prefix. The gate measures
`estimateInputTokens({ ...req, messages: [] })` for that reason.

One constant rather than a per-model table: the real minimum is larger for Haiku than for Opus and
Sonnet, but the estimator is nowhere near accurate enough for that difference to mean anything, so it
takes the smaller published value. The estimator over-counts, so the error runs safely — a prompt
that squeaks past and turns out too small is ignored upstream at no cost.

> **Correction (2026-08-23).** "The smaller published value" is false, and the minimum is not
> monotonic across generations: 512 on Opus 5, 1024 on Opus 4.8 and Sonnet 5/4.6, 2048 on Opus 4.7,
> 4096 on Opus 4.6 and Haiku 4.5. 1024 is neither the floor nor the ceiling — it over-gates Opus 5
> and under-gates Opus 4.6 and Haiku 4.5. The conclusion survives (the error still runs safe in both
> directions, at no charge) but the reasoning given for it does not.

## The vendor blind spot

`cache_control` is not a field ingress names, so a client setting the request-level auto-caching form
has it forwarded through `vendor` — where `estimateCachedInputTokens`, which walks only the IR,
cannot see it. Such a request would read as unmarked and receive a second breakpoint. The guard
therefore checks the vendor bag as well.

## Record

The degradation `anthropic:cache-breakpoint-added`, per request, through the existing `note()`
helper. That column normally names something a request *lost*; this names something added. It still
belongs there — the client's request was changed, which is exactly what the column exists to make
visible — and the name says `added` so no reader mistakes it for a capability reduction. Note that it
now fires on nearly every unmarked Anthropic request, which changes the column's density for anyone
reading logs.

## Testing

Covered in `packages/providers/test/anthropic.test.ts` and `apps/gateway/test/dispatch/dispatch.test.ts`:
placement on the last system block and the tools fallback; the OAuth prefix never taking the marker;
the flag off leaving the body byte-identical; all four shapes of "already marked" (system, tools,
message history, vendor); the prefix-measured size gate; the IR unchanged after encoding; and the
setting travelling store → snapshot → dispatch → attempt → adapter → wire.

### Mutation checks

Each must turn the suite red: drop the already-marked guard; drop the size gate; measure the whole
request instead of the prefix; mark the first system block instead of the last; remove the tools
fallback; ignore the flag; stop the adapter forwarding it; stop dispatch reading the setting; drop
the `attempt` forwarding spread; rename or unconditionally record the degradation; send an explicit
TTL; make an absent setting read as off; drop the zod field in `packages/control`.

Two of these — dispatch reading the setting, and `attempt` forwarding it — survived a full green
suite in review. `attempt` forwards through a `...(x === undefined ? {} : { x })` spread that fails
silently open, so a typo in the key produces a feature that is simply never on with nothing red.
