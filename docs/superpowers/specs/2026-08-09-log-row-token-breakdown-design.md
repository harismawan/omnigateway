# Log Row Token Breakdown Design

**Date:** 2026-08-09
**Status:** Approved

## Goal

Show each completed request's input, output, cache-read, and cache-write token counts directly in
the request-log table without increasing row height.

The table currently shows only `inputTokens + outputTokens` in its Tokens column. Operators must
open request detail to see cache activity or distinguish prompt tokens from generated tokens.

## Scope

This change affects only the Tokens cell in `apps/dashboard/src/features/logs/LogsBoard.tsx` and its
dashboard tests. It does not change request-log storage, API responses, shared types, usage
aggregation, the request-detail modal, or other dashboard token displays.

## Row presentation

A completed row renders all four counts on one non-wrapping line in this order:

```text
↓1.2k  ↑340  ◫↓8.4k  ◫↑120
```

The visible indicators use Lucide icons rather than Unicode glyphs:

1. `ArrowDown` followed by the input-token count.
2. `ArrowUp` followed by the output-token count.
3. `Database` plus `ArrowDown` followed by the cache-read count.
4. `Database` plus `ArrowUp` followed by the cache-write count.

Counts use the existing `formatCount` helper. Icons use the surrounding neutral text colour; colour
does not encode token category. Compact gaps separate each icon-count group, and
`white-space: nowrap` keeps every request row at its current height. The existing horizontal table
scroll remains the fallback when the wider Tokens column cannot fit.

Zero values remain visible as `0`. Hiding them would make the four positions variable and force an
operator to infer which category is absent.

A pending row still renders one em dash. Its stored zero token values are placeholders, not
measurements, and must remain hidden.

## Accessibility

Icons are decorative and carry `aria-hidden="true"`. The completed cell has one accessible label and
matching title that spell out unabridged values, for example:

```text
1,200 input, 340 output, 8,400 cache read, 120 cache write tokens
```

This keeps the compact visual notation from becoming the only explanation. Pending cells retain the
existing em dash and do not claim token measurements.

## Components and data flow

`LogsBoard` already receives all four fields on each `RequestLog`:

- `inputTokens`
- `outputTokens`
- `cacheReadTokens`
- `cacheWriteTokens`

A small local styled component owns the one-line layout. Rendering reads those fields directly; no
new derived state, request, query, or shared abstraction is needed. The existing request-detail modal
continues to show its textual breakdown unchanged.

## Testing

Extend `apps/dashboard/test/features/logs.test.tsx` with a completed fixture whose four token fields
are distinct. Assert that the Tokens cell exposes the full accessible label and contains all four
compact formatted counts. This behavior-level assertion verifies category order and values without
coupling the test to generated classes or SVG internals.

Keep the pending-row test unchanged in intent: Try, TTFT, Total, Tokens, and Cost remain em dashes.

Before completion, run the focused logs-board test, full dashboard suite, root suite, typecheck, and
lint as required by repository guidance.
