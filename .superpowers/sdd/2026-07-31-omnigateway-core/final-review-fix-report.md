# Final Review Fix Report

## Fixes

- Enforced `ApiKey.modelAllowlist` against the exact client-supplied model before dispatch. `null` is unrestricted and an empty list denies every model.
- Added a concurrency-safe, per-key, in-memory fixed-window limiter for `rateLimitPerMin`. Windows align to minute boundaries, roll over exactly at the boundary, and expired entries are cleaned while consuming. Rejections use canonical `RATE_LIMIT` / HTTP 429 responses.
- Added shared credential extraction for `Authorization: Bearer` and `x-api-key` on proxy and `/v1/models` routes. Matching dual headers are accepted; conflicting values are rejected.
- Applied `requestDeadlineMs` as one absolute dispatch deadline covering candidate attempts, failover, OAuth refresh, and reactive refresh retry. The deadline aborts downstream work and surfaces `TIMEOUT`; client abort reasons remain distinct; listeners and timers are cleared when dispatch completes or is cancelled.

## Tests

- Added proxy-route tests for `x-api-key`, conflicting credentials, exact allowlists, empty-list denial, independent counters, concurrent boundary enforcement, rollover, and pre-dispatch rejection.
- Added dispatch tests for absolute deadline cancellation during upstream streaming and refresh, plus preservation of client aborts.

## Verification

- Targeted: `bun test apps/gateway/test/routes/proxy.test.ts apps/gateway/test/dispatch/dispatch.test.ts` — 36 pass, 0 fail.
- Full: `bun test` — 442 pass, 0 fail, 1038 assertions across 39 files.
- Typecheck: `bun run typecheck` — passed.
- Lint: `bun run lint` — passed with only the pre-existing Biome `recommended` configuration deprecation notice.
- Diff hygiene: `git diff --check` — passed.

## Concerns

- The fixed-window limiter is intentionally process-local. Multiple gateway processes do not share counters; distributed enforcement would require a shared atomic store.
- Limiter state is ephemeral across process restarts.

## Fix Round 1

- Retained the authenticated API key on `GET /v1/models` and filtered the response to models visible through its exact `modelAllowlist`. A `null` allowlist returns every model; an empty allowlist returns an empty `data` array.
- Added route coverage for restricted, `null`, and empty model allowlists.

### Exact verification results

- Targeted: `bun test apps/gateway/test/routes/proxy.test.ts` — 19 pass, 0 fail, 47 assertions in 1 file.
- Full: `bun test` — 445 pass, 0 fail, 1044 assertions across 39 files.
- Typecheck: `bun run typecheck` — passed (`tsc -b --pretty false`).
- Lint: `bun run lint` — passed; checked 121 files with no fixes, errors, or warnings. It emitted one pre-existing informational Biome `recommended` configuration deprecation notice.
- Diff hygiene: `git diff --check` — passed with no output.
