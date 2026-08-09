# Mid-Conversation System Cache-Control Design

## Problem

Anthropic clients can send an in-place `role: "system"` message whose text block carries
`cache_control`. OmniGateway preserves that message's position and authority, but its Anthropic
encoder flattens the content array to the text-only wire form. The block-level marker is therefore
lost and the request records `anthropic:system-turn-cache-control-dropped`.

Large clients such as Claude Code resend project instructions, tool guidance, conversation history,
and runtime reminders because the Messages API is stateless. Losing this breakpoint makes the
repeated prefix full-price input instead of a cache read.

## Evidence

A live Claude API probe against `claude-opus-5` established these behaviors:

- A content-block array on a mid-conversation system message is accepted, but a nested
  `cache_control` marker is ignored: repeated requests report zero cache creation and reads.
- A message-level marker on that system message is also ignored.
- A top-level automatic `cache_control` marker caches through the last cacheable block: the first
  request reports cache creation and the second reports a cache read.
- Existing top-level-system and ordinary-message block markers work normally.

Reference implementations do not provide exact preservation:

- OmniRoute hoists marked system text into the top-level system prompt, preserving the marker but
  changing when the instruction takes effect.
- CLIProxyAPI retains approximate position by rewriting the system turn as a user
  `<system-reminder>`, losing both system authority and the marker.

## Design

Keep the mid-conversation system turn at its original message position and retain the documented
text wire form. Translate its block marker to Anthropic's top-level automatic `cache_control` only
when automatic placement selects the same boundary the caller requested.

A marked system turn is exactly representable when its marked block is the request's final
cacheable block. This includes the common Claude Code shape where a runtime system reminder closes
the request. In that case:

1. Encode the system turn as its existing plain string.
2. Set top-level `cache_control` to the marked block's value, including an explicit TTL when present.
3. Do not record `anthropic:system-turn-cache-control-dropped`.

If any cacheable block follows the marker, automatic placement would move the breakpoint later and
cache content the caller did not mark. Keep current degradation instead of silently broadening the
cached prefix.

If a system turn contains several marked blocks, only its final marked block can be represented by
automatic placement. Earlier markers remain losses. Record the degradation even if the final marker
is promoted. Use the final marker's TTL for automatic placement.

Provider vendor passthrough remains last. An explicit raw Anthropic `cache_control` value therefore
continues to override derived automatic placement.

## Boundaries

- No IR change: `ContentBlock.cacheControl` already carries caller intent and TTL.
- No ingress change: Anthropic ingress already preserves marked system-turn blocks in IR.
- Change stays in `packages/providers/src/anthropic/wire.ts`.
- Do not hoist the turn into top-level `system`.
- Do not rewrite it as user content.
- Do not synthesize markers when caller supplied none.
- Do not alter ordinary system, message, or tool marker behavior.

## Detection

While encoding messages, determine whether a caller marker on a system turn is the final cacheable
block in rendered message order. Cacheable blocks are every block that can carry `CacheControl` in
IR; thinking blocks do not qualify.

Promotion requires:

- exactly one otherwise-lost system-turn marker across the representable suffix, and
- no cacheable block after that marked block.

Any additional lost marker keeps the degradation because top-level automatic caching supplies only
one breakpoint and cannot preserve all caller intent.

## Failure and Degradation Behavior

Requests continue upstream even when exact placement is impossible. Existing degradation remains
request-level and deduplicated:

```text
anthropic:system-turn-cache-control-dropped
```

This means:

- no degradation when the sole lost marker is exactly promoted;
- degradation when later cacheable content would shift the boundary;
- degradation when multiple system-turn markers cannot all survive;
- no new error surface for clients.

## Testing

Add focused Anthropic provider tests covering:

1. Final marked system turn emits top-level automatic `cache_control`, preserves message order and
   string content, and produces no degradation.
2. Explicit `ttl: "1h"` survives promotion.
3. A later cacheable block prevents promotion and retains degradation.
4. Multiple system-turn markers retain degradation; no caller intent is reported as fully
   preserved.
5. Unmarked system turns remain unchanged.
6. Raw `vendor.anthropic.cache_control` still overrides derived placement because passthrough is
   applied last.

Run focused provider tests, full root tests, dashboard tests, typecheck, and lint before completion.
