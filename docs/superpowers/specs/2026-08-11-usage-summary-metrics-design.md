# Usage Summary Metrics Design

## Goal

Make token accounting legible on the Usage page and expose RTK compression benefit over the selected time range. Preserve existing provider-normalized accounting: uncached input, cache reads, cache writes, and output remain disjoint token classes.

## Summary deck

The Usage page shows ten readouts for the selected range:

1. **Requests** — completed request count. Subtitle: selected range.
2. **Error rate** — errors divided by requests. Subtitle: failed request count.
3. **Prompt input** — uncached input plus cache-read and cache-write tokens. Subtitle: uncached input count.
4. **Output** — generated output tokens. Subtitle: mean output tokens per request.
5. **Cache reads** — cache-read tokens. Subtitle: percentage of prompt input served from cache.
6. **Cache writes** — cache-write tokens. Subtitle: percentage of prompt input newly written to cache.
7. **RTK saved** — estimated tokens removed from historical tool results by RTK. Subtitle: count of requests where RTK applied.
8. **Mean duration** — summed duration divided by request count. Subtitle: per request.
9. **Spend** — total cost. Subtitle: selected range.
10. **Cost / request** — total cost divided by request count. Subtitle: mean.

Zero-request windows avoid division by zero and display zero-valued rates or the existing unavailable duration representation as appropriate. Every readout has a sparkline derived from the same measure as its headline value. The deck keeps its existing responsive auto-fit behavior; ten cards wrap according to available width.

## Token semantics

`Usage.inputTokens` remains uncached input. No provider, pricing, persistence, or IR semantics change.

Prompt input is a dashboard-derived measure:

```text
inputTokens + cacheReadTokens + cacheWriteTokens
```

The Token mix panel continues to show four disjoint classes. Its `Input` label changes to `Uncached input`; Output, Cache read, and Cache write remain unchanged. Token mix total continues to include all four classes, including output.

Cache-read and cache-write percentages use prompt input as denominator. An empty prompt produces 0%, not a non-finite value.

## RTK aggregate data

Individual request logs already store `rtkApplied` and `rtkEstimatedTokensSaved`. Usage aggregation adds two additive measures:

- `rtkSavedTokens`: sum of `rtkEstimatedTokensSaved`
- `rtkAppliedRequests`: count of completed request logs with `rtkApplied === true`

Both fields become required numeric members of `UsageBucket`. They flow unchanged through store queries, `@omni/control`, `/api/usage`, dashboard API types, totals, and time-series rendering.

## Persistence and migration

Add a SQLite migration after `005_rtk_metrics.sql` that extends `usage_daily` with two non-null integer columns defaulting to zero:

- `rtk_saved_tokens`
- `rtk_applied_requests`

After adding columns, rebuild both measures for existing `usage_daily` groups from `request_logs`. Backfill uses the same local-day and grouping tuple as normal rollup:

- day
- resolved provider
- credential
- requested model
- resolved model
- API key

A completed log contributes its non-negative estimated saved-token count and either one or zero applied requests. Normal `rollupLog` updates these fields in the same transaction as request-log completion. Existing installations therefore receive historical RTK totals without losing current usage aggregates.

The migration does not recreate or reinterpret old RTK estimates. Rows recorded before RTK metrics existed contribute zero through column defaults.

## API and compatibility

`UsageBucket` gains required `rtkSavedTokens` and `rtkAppliedRequests` fields. This is an additive JSON response change. Existing query dimensions, grains, sorting metrics, and routes remain unchanged.

RTK savings remains a summary/time-series measure only. It is not added as an Activity Grid or ranking lens in this change.

## Testing

Store tests cover:

- one applied request incrementing both RTK aggregate fields
- one unapplied request contributing zero
- multiple requests summing saved tokens and applied count
- split/group queries returning the new measures
- migration columns and historical backfill from request logs

Gateway/control tests assert `/api/usage` returns both RTK fields.

Dashboard tests use known buckets to assert:

- Prompt input equals uncached input plus cache reads plus cache writes
- Output is a separate readout
- cache percentages use prompt input
- RTK saved total and applied-request subtitle
- RTK sparkline uses saved tokens per time bucket
- Cost / request handles populated and empty windows
- Token mix says `Uncached input`
- all ten readouts render without changing existing range behavior

## Non-goals

- Changing provider token normalization
- Repricing cached tokens
- Combining output into Prompt input
- Adding RTK as a ranking or Activity Grid metric
- Recomputing RTK estimates from historical prompt bodies, which are never stored
