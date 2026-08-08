# OmniGateway Engineering Audit

**Date:** 2026-08-08  
**Scope:** Repository-wide, read-only review of security, correctness, performance,
maintainability, tests, and product gaps.

Findings prioritize verified failure paths and measurable bottlenecks over generic advice.
No production files were modified during the audit.

## Executive priorities

| Priority | Recommendation | Impact | Effort |
| --- | --- | --- | --- |
| P0 | Reject upstream streams missing terminal events | Prevent partial responses from being reported as successful | Medium, 2–4 days |
| P0 | Make credential-health transitions concurrency-safe | Preserve breaker failures and provider rate-limit state | Medium/large, 4–7 days |
| P0 | Derive admin cookie security from public origin | Protect admin sessions behind TLS-terminating proxies | Small, less than 1 day |
| P1 | Cache immutable routing snapshots | Remove repeated SQLite reads and object construction from every request | Large, 1–2 weeks |
| P1 | Add pull-request and main-branch CI | Catch regressions before release tags | Small, less than 1 day |
| P2 | Move CLI admin operations through `@omni/control` | Prevent CLI and HTTP policy drift | Medium, 3–6 days |

## Confirmed defects

### 1. Premature provider EOF becomes successful completion

**Severity:** High  
**Confidence:** 10/10

Anthropic and OpenAI decoders finish normally when the upstream transport closes before the
provider's terminal event. Kimi can synthesize a successful `end` after an empty or truncated
stream. Dispatch treats normal generator exhaustion as success, records status 200, and calls
`recordSuccess`.

#### Failure scenario

1. Upstream sends a start event and one or more content deltas.
2. Connection closes before `message_stop`, `response.completed`, or valid Kimi completion.
3. Decoder generator returns without an error.
4. Dispatch records successful credential health and status 200.
5. Non-streaming clients receive partial JSON as a completed response. Streaming clients receive
   clean EOF; OpenAI egress may append `[DONE]`, falsely indicating completion.

This also corrupts usage and routing health. A broken upstream connection is rewarded with a
successful health transition instead of triggering pre-commit failover or a post-commit error.

#### Evidence

- `packages/providers/src/anthropic/decode.ts:65-155`
- `packages/providers/src/openai/decode.ts:69-190`
- `packages/providers/src/kimi/decode.ts:63-138`
- `packages/providers/src/sse.ts:17-34`
- `apps/gateway/src/dispatch/index.ts:198-254`
- `apps/gateway/src/routes/proxy.ts:121-139`
- `apps/gateway/src/egress/openai.ts:121-145`

#### Recommendation

1. Track and require provider-specific terminal events in every decoder.
2. Treat EOF without a valid terminal event as an `UPSTREAM` error.
3. Add a dispatch-level invariant requiring each attempt to produce canonical `end` or `error`.
   This protects against future adapter mistakes.
4. Before stream commit, allow normal candidate failover.
5. After stream commit, emit a client-compatible in-band error and record failed health/status.
6. Emit OpenAI `[DONE]` only after canonical successful completion.

#### Required tests

- Anthropic start plus text delta plus EOF: `UPSTREAM`, never `end`.
- OpenAI created plus output delta plus EOF: `UPSTREAM`, never `end`.
- Kimi content plus EOF without `[DONE]`: `UPSTREAM`.
- Kimi valid `[DONE]` without `finish_reason`: preserve explicitly intended behavior.
- Dispatch adapter yielding partial events then returning: failed health and status 502.
- Both client surfaces, streaming and non-streaming, before and after commit.

### 2. Concurrent health updates lose breaker and rate-limit state

**Severity:** High  
**Confidence:** 10/10

Every dispatch reads credential health into a detached request-start snapshot. Terminal paths then
calculate a complete replacement row from that snapshot and perform a blind SQLite upsert.
Concurrent requests therefore overwrite each other's transitions.

#### Failure scenarios

**Lost hard failures**

1. Two requests read blank health with zero failures.
2. Both upstream attempts fail.
3. Both calculate `consecutiveFailures: 1`.
4. Both write one.
5. Final persisted count is one, not two; breaker threshold may never be reached under concurrent
   failure bursts.

**Stale success clears newer protection**

1. Request A reads blank health and later produces a successful stream.
2. Request B records a breaker-opening failure or provider rate limit.
3. Older request A completes afterward.
4. A writes `recordSuccess(blankHealth)`, clearing B's breaker or `rateLimitedUntil` value.
5. Later requests immediately route back to the failing or rate-limited credential.

#### Evidence

- `apps/gateway/src/dispatch/index.ts:52-54`
- `packages/router/src/snapshot.ts:11-20`
- `apps/gateway/src/dispatch/index.ts:141-143`
- `apps/gateway/src/dispatch/index.ts:227-311`
- `packages/router/src/breaker.ts:60-109`
- `packages/store/src/sqlite/credentials.ts:193-220`

#### Recommendation

Persist health transition events rather than snapshot-derived replacement rows.

Add a repository operation conceptually shaped like:

```ts
applyHealthTransition(credentialId, model, transition, options): Promise<void>
```

Implementation requirements:

- Read current row, apply transition, and write next row atomically.
- Hard failures increment current persisted count.
- Provider rate-limit transitions preserve the later or longer active park.
- A stale success must not clear a failure or rate limit observed after that attempt started.
- Add a revision, transition sequence, or comparable event-order mechanism. A transaction alone
  fixes lost increments but does not distinguish an older attempt completing after a newer event.

#### Required tests

1. Gate two concurrent failures after both snapshots exist; expect two persisted failures.
2. Complete a newer rate limit before an older success; expect rate limit to remain active.
3. Complete a threshold-one failure before an older success; expect breaker to remain open.
4. If multi-process SQLite behavior matters later, repeat against two stores connected to one file.

### 3. Admin session cookie loses `Secure` behind TLS termination

**Severity:** Medium  
**Confidence:** 9/10

Session-cookie policy derives from the backend request URL:

```ts
const secure = new URL(request.url).protocol === "https:" ? ["Secure"] : [];
```

OmniGateway documents a reverse-proxy deployment where TLS commonly terminates at the proxy and
traffic reaches Bun over HTTP. In that topology, a successful HTTPS login produces an admin cookie
without `Secure`.

If the browser later makes an HTTP request to the same public host, an on-path attacker can capture
and replay the live admin session. `HttpOnly` and `SameSite=Strict` do not provide transport
confidentiality.

#### Evidence

- `apps/gateway/src/routes/admin.ts:32-42`
- `apps/gateway/src/index.ts:67`
- `packages/control/src/config.ts:50-63`
- `README.md:191`
- `README.md:244-245`

#### Recommendation

Derive secure-cookie policy from trusted deployment configuration, preferably the configured public
origin in `OMNI_BASE_URL`, rather than the backend request scheme.

Do not trust `X-Forwarded-Proto` unless OmniGateway also gains explicit trusted-proxy configuration;
a directly reachable client could otherwise forge the header.

Apply the same policy to login, setup, and logout cookie deletion. Add a route test proving an HTTPS
public origin issues `Secure` even when the internal request URL is HTTP.

## Performance opportunities

### 1. Cache routing snapshots ✅ Done

**Completed:** 2026-08-08  
**Priority:** Highest performance improvement  
**Effort:** Large

Implemented one process-local immutable routing snapshot cache shared by gateway dispatches. Local
health and quota writes patch cached maps; credential, model, and settings writes invalidate the
snapshot. `PRAGMA data_version` detects CLI writes from another SQLite connection before the next
request. Cold and invalidated rebuilds coalesce, reject rather than serve known-stale state, and
retry after failure. Snapshot construction now selects credential routing metadata without token
ciphertext and loads current encrypted secrets by credential ID only for an attempted candidate.

Verification completed with `bun test` (654 passed), dashboard tests (180 passed),
`bun run typecheck`, and `bun run lint`. Lint reports only the existing Biome configuration
deprecation notice.

`dispatch` rebuilds the entire routing snapshot before every proxied request. Snapshot construction
loads all credentials, health rows, quota rows, virtual models, and settings, then parses and maps
them into fresh objects.

#### Evidence

- `apps/gateway/src/dispatch/index.ts:53`
- `packages/router/src/snapshot.ts:11-20`
- `packages/store/src/sqlite/credentials.ts:70-72`
- `packages/store/src/sqlite/credentials.ts:167-190`
- `packages/store/src/sqlite/credentials.ts:223-245`
- `packages/store/src/sqlite/config.ts:20-31`
- `packages/store/src/sqlite/config.ts:49-60`

#### Recommendation

Use an immutable in-memory routing snapshot:

1. Build it at startup.
2. Replace it atomically after relevant control-plane writes.
3. Update health and quota portions incrementally or through explicit invalidation.
4. Add a metadata-only credential query so snapshot construction does not select ciphertext fields.
5. Avoid an unversioned TTL cache that delays credential disablement or model edits.

Benchmark with representative credentials, health rows, quota windows, and models. Measure dispatch
setup latency, SQLite statement count, allocation, and throughput before and after caching.

### 2. Reduce terminal SQLite write pressure

Every completed request writes health and then writes request logs plus the daily rollup. SQLite
WAL improves concurrency but still has one writer.

#### Evidence

- `apps/gateway/src/dispatch/index.ts:227-254`
- `apps/gateway/src/dispatch/index.ts:301-311`
- `apps/gateway/src/routes/proxy.ts:111-123`
- `packages/store/src/sqlite/usage.ts:123-152`
- `packages/store/src/sqlite/rollup.ts:39-54`

#### Recommendation

Keep breaker openings and provider rate limits durable immediately. Consider coalescing routine
EWMA and last-used health updates over a short bounded interval. Preserve atomic raw-log and daily
rollup writes unless the product explicitly accepts a crash-loss window.

### 3. Consolidate dashboard polling

Usage screen launches six aggregate queries. Chassis and Overview independently poll overlapping
recent-log windows with different cache keys, preventing query deduplication.

#### Evidence

- `apps/dashboard/src/features/usage/UsageBoard.tsx:77-89`
- `apps/dashboard/src/components/ChassisBar.tsx:95`
- `apps/dashboard/src/features/overview/OverviewBoard.tsx:33-38`
- `apps/dashboard/src/api/queries.ts:81-130`

#### Recommendation

- Share one recent-log query at the largest required limit and derive smaller views locally.
- Consider a purpose-built Overview endpoint for related state.
- Cache normalized usage aggregates slightly longer than polling interval.
- Disable focus refetch for expensive history queries already refreshed by polling.

### 4. Decrypt only secrets needed by each operation ✅ Done

**Completed:** 2026-08-08

Credential views now expose purpose-specific inference, refresh, and usage loaders. OAuth inference
and quota reads decrypt only the access token, API-key inference decrypts only the API key, and token
refresh decrypts only the refresh token. Routing views query current required ciphertext by credential
ID, and no plaintext cache was added.

Verification completed with focused tests (149 passed), `bun test` (657 passed), dashboard tests
(180 passed), `bun run typecheck`, and `bun run lint`. Lint reports only the existing Biome
configuration deprecation notice.

Inference previously opened access token, refresh token, API key, and ID token serially, although
adapters need only access token or API key.

#### Evidence

- `apps/gateway/src/dispatch/attempt.ts:35-61`
- `packages/store/src/sqlite/credentials.ts:56-61`
- `packages/store/src/encryption.ts:51-73`

#### Recommendation

Replace broad `secrets()` access with purpose-specific methods such as `openForInference()` and
`openForRefresh()`. Open only required fields. Avoid broad plaintext caching without a separate
threat-model decision.

### 5. Incrementally collect non-streaming responses

Non-streaming requests retain every canonical event, then build accumulated block strings, a final
response object, and serialized JSON. Peak memory grows with event count and output size.

#### Evidence

- `apps/gateway/src/routes/proxy.ts:121-136`
- `packages/ir/src/stream.ts:65-127`
- `apps/gateway/src/egress/anthropic.ts:124-148`
- `apps/gateway/src/egress/openai.ts:148-187`

#### Recommendation

Maintain incremental collection state while consuming events. Store completed block state rather
than the full event history, collect fragments in arrays, and join once at block finalization.

### 6. Profile raw usage query plans

Raw usage aggregation scans the selected time range, groups dynamically, and sorts aggregates. The
existing indexes cover time and credential/time but not every common grouping shape.

#### Evidence

- `packages/store/src/sqlite/usage.ts:178-193`
- `packages/store/src/sqlite/migrations/001_init.sql:81-82`
- `packages/store/src/sqlite/migrations/002_usage_daily.sql:29-32`

#### Recommendation

Use `EXPLAIN QUERY PLAN` and production-like data for standard dashboard queries before adding
indexes. Prefer shared aggregate scans or short server-side caching over speculative indexes for all
dimensions.

### 7. Make SSE parsing incremental

The parser appends decoded text, normalizes the full buffer, searches it, and slices it after every
provider chunk. One large SSE record fragmented into many small chunks can produce quadratic copying.

#### Evidence

- `packages/providers/src/sse.ts:14-52`

#### Recommendation

Parse incrementally at byte or segment level, normalize CRLF per record, and cap incomplete-record
size with a controlled upstream-protocol error.

### 8. Refresh OAuth credentials with bounded concurrency

The scheduler refreshes due credentials serially. Several accounts expiring together make sweep time
the sum of provider latencies.

#### Evidence

- `apps/gateway/src/oauth/scheduler.ts:34-58`
- `packages/control/src/quota.ts:116-139`

#### Recommendation

Reuse the quota poller's bounded-worker pattern with a conservative concurrency limit. Preserve the
shared refresher's per-credential coalescing and scheduler no-overlap guard.

## Maintainability and test leverage

### 1. Add pull-request and default-branch CI

Current release workflow triggers only for `v*` tags. It runs the correct root tests, dashboard
tests, typecheck, and lint, but only immediately before publishing.

#### Evidence

- `.github/workflows/release.yml:6-9`
- `.github/workflows/release.yml:39-57`

#### Recommendation

Add a non-publishing workflow for pull requests and pushes to `main`. Add discoverable root scripts
such as `test:dashboard` and `test:all`, then reuse them in CI.

### 2. Route CLI admin operations through `packages/control`

CLI credential creation and operational reads access repositories directly. This duplicates policy
that should be shared with HTTP admin operations.

#### Evidence

- `apps/cli/src/commands/credentials.ts:72`
- `apps/cli/src/commands/credentials.ts:188-260`
- `apps/cli/src/commands/status.ts:76-77`

#### Recommendation

Add control operations for API-key credential creation and credential/status projections. Keep CLI
store access limited to context construction and operation dependencies.

### 3. Decompose dispatch after characterizing its state machine

`dispatch` combines snapshot loading, deadline and cancellation ownership, ranking, refresh retry,
provider execution, stream commit semantics, health persistence, logging, and terminal rendering.

#### Evidence

- `apps/gateway/src/dispatch/index.ts:47-355`

#### Recommendation

First add tests covering implicit transitions. Then extract typed units for deadline scope, one
candidate attempt, stream outcome reduction, and terminal finalization. Keep `dispatch()` as a short
orchestration layer.

### 4. Unify admin HTTP session and error utilities

Admin and connect routes duplicate cookie parsing and admin authorization while using different
error-rendering paths.

#### Evidence

- `apps/gateway/src/routes/admin.ts:45-85`
- `apps/gateway/src/routes/connect.ts:8-49`

#### Recommendation

Extract gateway-local cookie, authorization, JSON parsing, and canonical control-error helpers.
Apply one error contract across `/api/*`.

### 5. Create one request-log factory and ID owner

Normal dispatch and proxy exception paths duplicate the request-log object. Proxy also overwrites an
ID created by dispatch.

#### Evidence

- `apps/gateway/src/dispatch/index.ts:56-75`
- `apps/gateway/src/routes/proxy.ts:108-111`
- `apps/gateway/src/routes/proxy.ts:143-163`

#### Recommendation

Create `newRequestLog()` in the logging boundary. Generate request ID once in the route and pass it
to dispatch.

### 6. Inject CLI credential-refresh HTTP

Credential refresh creates a production HTTP client inside the command, outside the CLI's injected
side-effect seams.

#### Evidence

- `apps/cli/src/commands/credentials.ts:194-199`

#### Recommendation

Put the HTTP/refresher factory behind CLI context or runtime dependencies. Add tests for OAuth
success, API-key rejection, provider failure, token rotation, and persisted expiry.

### 7. Remove hidden quota-poller global state

Quota cooldowns live in module-global mutable state with a test-only reset function.

#### Evidence

- `packages/control/src/quota.ts:28-32`
- `packages/control/src/quota.ts:103-140`

#### Recommendation

Inject a cooldown store or create an explicit poller instance. Gateway can still own one process-wide
instance without hiding that state from tests and future embeddings.

## Product roadmap candidates

### P0: Add provider API-key credentials through the dashboard

**Effort:** 2–4 days

Console implements OAuth connection flows, while provider API-key credentials can only be added
through CLI. Add a shared control operation, authenticated route, and write-only dashboard form.
Never return or retain submitted provider secrets after persistence.

Evidence:

- `apps/dashboard/src/features/accounts/ConnectDialog.tsx:155-279`
- `apps/gateway/src/routes/admin.ts:152-172`
- `apps/cli/src/commands/credentials.ts:214-249`

### P0: Edit and rotate gateway API keys

**Effort:** 3–6 days

Gateway keys can be created and revoked but not edited or rotated. Add policy patching for label,
model allowlist, and rate limit. Rotation should mint a replacement, show it once, and optionally
preserve a short overlap before revoking the previous key.

Evidence:

- `packages/control/src/keys.ts:8-52`
- `apps/gateway/src/routes/admin.ts:191-207`
- `apps/dashboard/src/api/queries.ts:227-243`

### P1: Add cursor-based log investigation and export

**Effort:** 4–7 days

Current storage and API expose only latest-N logs, capped at 500, with filtering performed in the
browser. Add cursor `(at, id)`, time bounds, provider/model/credential/key/error filters, and
metadata-only CSV or JSON export. Preserve the no-body logging contract.

Evidence:

- `packages/store/src/types.ts:252-259`
- `packages/store/src/sqlite/usage.ts:159-164`
- `packages/control/src/usage.ts:45-56`
- `apps/dashboard/src/features/logs/LogsBoard.tsx:75-126`

### P1: Add on-demand quota probes

**Effort:** 1–3 days

Reuse existing quota probe logic through a control operation, protected route, Accounts action, and
CLI command. Respect the existing provider cooldown and never disable credentials because a usage
endpoint failed.

Evidence:

- `packages/control/src/quota.ts:51-95`
- `apps/gateway/src/quota/poller.ts:13-43`

### P1: Add backup and guarded restore

**Effort:** 3–6 days

Provide a SQLite-consistent backup command, non-secret manifest and checksum, explicit restore
confirmation, managed-service stop, and encryption-key validation before replacing live data.

Evidence:

- `apps/cli/src/registry.ts:79-81`
- `packages/store/src/sqlite/db.ts:22-26`

### P2: Add readiness diagnostics

**Effort:** 2–4 days

Keep `/health` as unauthenticated liveness. Add an authenticated readiness projection and, if needed,
a restricted non-secret `/readyz` endpoint for orchestration. Report database reachability,
configured models, enabled/eligible credential counts, breaker summary, and stale quota count without
exposing account identities or quota details.

Evidence:

- `apps/gateway/src/app.ts:65-67`
- `apps/gateway/src/routes/admin.ts:152-160`

### Later architectural work

- **OpenAI Responses API compatibility:** separate 3–6 week specification and implementation project.
- **Per-model request-shape compatibility:** future major-version project because capability truth
  varies by model, account tier, and provider rollout.

Do not prioritize semantic caching, body storage, multi-tenancy, browser-session providers, or
horizontal scaling in version 1; current approved product boundaries explicitly exclude them.

## Suggested execution sequence

### Phase A: Protect correctness and security

1. Require terminal provider events and add dispatch invariant.
2. Fix secure-cookie policy.
3. Add PR/default-branch CI and root `test:all` command.
4. Add deterministic regression tests for both defects.

### Phase B: Repair state model and boundaries

1. Design ordered credential-health transitions.
2. Add atomic transition persistence and concurrency tests.
3. Move CLI credential and status operations into `packages/control`.
4. Unify admin/connect HTTP session and error helpers.

### Phase C: Scale request hot paths

1. Benchmark current routing snapshot rebuild.
2. Add invalidated immutable snapshot cache.
3. Consolidate dashboard polling.
4. Narrow credential-secret opening.
5. Add incremental non-streaming collection.
6. Profile usage query plans before adding indexes.

## Rejected candidate

A proposed shutdown race claimed timer work could access SQLite after `store.close()`. Independent
verification rejected that specific failure: shutdown closes the store and calls synchronous
`process.exit()` in the same call stack, preventing pending promise continuations from resuming after
close.

The loops are not gracefully drained, so an in-progress quota probe, OAuth refresh, or prune can be
abandoned. Async bounded draining may be added if graceful shutdown becomes a product requirement,
but this is not a confirmed post-close database defect.

Evidence:

- `apps/gateway/src/index.ts:73-92`
- `apps/gateway/src/quota/poller.ts:18-43`
- `apps/gateway/src/oauth/scheduler.ts:80-99`
- `apps/gateway/src/maintenance.ts:28-40`
