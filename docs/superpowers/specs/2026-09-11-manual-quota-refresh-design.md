# Manual provider-quota refresh

Status: designed, not built.

Provider quota is already polled in the background and rendered on the Accounts page. Operators
cannot request a fresh reading after reconnecting an account, investigating stale telemetry or
validating a deployment; they must wait for the next scheduled pass. This design exposes the
existing quota-probe behavior as an explicit admin operation in the dashboard and CLI.

Manual refresh is not a second probe implementation. Scheduled polling, the HTTP route and the CLI
all use one control-layer account-attempt operation, so eligibility, OAuth refresh, provider
cooldown, persistence and failure behavior cannot diverge.

## Goals

- Refresh one account's provider quota on demand.
- Refresh every stored account with bounded concurrency and partial results.
- Expose the operation in the Accounts dashboard and `omni quota` CLI.
- Preserve the rule that quota-probe failure never disables a credential.
- Preserve previous telemetry after failure, cooldown, unsupported or empty reports.
- Share provider cooldowns and suppress duplicate successful probes across replicas.
- Tell the operator why each account refreshed, skipped or failed without exposing upstream text.
- Make scheduled and manual writes invalidate both current quota meters and open history views.

## Non-goals

- Changing the automatic polling interval or its boot behavior.
- Adding a manual OAuth-token refresh operation.
- Probing disabled credentials.
- Adding quota support to providers that do not expose a usable window.
- Treating missing quota data as unlimited or zero.
- Guaranteeing one provider call for concurrent failed or empty probes across replicas.
- Persisting operation jobs or their results.
- Adding a new setting, table, migration or plugin API.
- Changing staleness, rollover, burn or projection formulas.
- Sending refresh controls to client-key holders.

## Existing behavior

`packages/control/src/quota/poll.ts` owns both the one-account provider operation and the scheduled
sweep. `probe()` refreshes an expiring OAuth token when required, opens only `UsageSecrets`, calls
the provider's optional `usage()` flow, normalizes every returned window and writes the complete
window set through `saveQuota()`.

`poll()` supplies the policy around that mechanism:

- only enabled OAuth credentials with a provider usage flow are eligible;
- `quota:cooldown:<credentialId>` skips a recently rate-limited provider endpoint;
- a provider `RATE_LIMIT` writes a shared three-minute cooldown;
- up to four accounts are attempted concurrently;
- one account's failure does not stop the pass;
- failures never disable credentials;
- null or empty reports do not erase the previous snapshot;
- the return value is only the number of credentials that wrote a snapshot.

The gateway poller runs one pass immediately and then on `quotaPollIntervalMs`, under the fleet-wide
`quota-poll` scheduler lease. A process-local `running` flag prevents overlapping timer callbacks.
The lease and flag belong to the periodic job; neither coordinates interactive requests.

Quota writes go only through `saveQuota()`. It replaces the provider's latest reported window set,
updates `observedAt`, and appends changed history samples in one store transaction. That single
write path remains unchanged.

## One account-attempt operation

Extract the policy for attempting one credential from `poll()` into a private shared operation. It
owns:

1. credential eligibility;
2. shared cooldown lookup;
3. local and distributed coalescing;
4. invocation of `probe()`;
5. rate-limit cooldown writes;
6. safe logging;
7. conversion to a stable result.

Scheduled `poll()` and manual refresh both call it. `probe()` remains the narrow provider and
persistence mechanism; gateway routes and CLI commands never call `probe()` directly.

The public manual operation is conceptually:

```ts
export type QuotaRefreshRequest =
  | { kind: "one"; credentialId: string }
  | { kind: "all" };

export type QuotaRefreshOutcome =
  | { kind: "refreshed"; credentialId: string; windows: number }
  | { kind: "noData"; credentialId: string }
  | { kind: "cooldown"; credentialId: string }
  | { kind: "unsupported"; credentialId: string }
  | { kind: "disabled"; credentialId: string }
  | { kind: "failed"; credentialId: string; code: ErrorCode }
  | { kind: "coalesced"; credentialId: string; windows: number };

export type QuotaRefreshResult = {
  outcomes: QuotaRefreshOutcome[];
};
```

Names may follow surrounding conventions, but the discriminated outcomes and their meanings are
fixed.

`refreshed` means a provider returned one or more usable windows and `saveQuota()` completed.
`coalesced` means another overlapping successful attempt produced the reading used by this request;
it is a success for summaries but remains distinguishable for tests and diagnostics. `noData`
means the provider ran but returned null or no usable windows. `cooldown` means the provider was not
called because the shared rate-limit cooldown was live. `unsupported` covers API-key credentials
and providers without a usage flow. `disabled` preserves the scheduled poller's eligibility rule.
`failed` means an attempted refresh/probe/plugin/store operation failed.

Outcomes contain stable host-authored kinds and an existing closed `ErrorCode`, never raw upstream
or plugin messages. Detailed bounded diagnostics remain in structured logs.

## One and all semantics

A one-account request requires a credential ID and reads that credential from the store. A missing
credential is a request-level `NOT_FOUND`; malformed or empty IDs are `BAD_REQUEST`. A stored but
ineligible account returns `unsupported` or `disabled` rather than an HTTP error.

An all-account request considers every credential returned by `credentials.list()` and returns one
outcome for each stored row. This explains why a visible account did not change instead of silently
omitting it. Workers consume the list in store order with the existing concurrency bound of four.
Completion and result arrival order may differ, so the final result is reordered to the original
credential-list order before returning.

A failure for one account never rejects the whole all-account operation. Request-level failures are
reserved for invalid input, authorization, failure to list credentials, or another failure that
prevents the operation from forming its account set.

Scheduled `poll()` preserves its current `Promise<number>` contract by counting `refreshed` and
successful `coalesced` results according to actual writes: only the worker that writes increments
the scheduled persisted count. It uses the same account-attempt implementation without exposing
manual result types to the timer.

## Coalescing

### Process-local

The shared quota-attempt layer owns one process-local map:

```ts
Map<string, Promise<AccountAttemptResult>>
```

The first caller installs its promise synchronously before yielding. Scheduled polling, HTTP
requests and CLI-in-process callers using that control instance receive the same promise for the
same credential. The entry is removed in `finally`, so failure and no-data results are retryable.
Different credentials continue concurrently.

This map is separate from OAuth refresher coalescing. OAuth's map protects token rotation; quota's
map protects the provider usage call.

### Across replicas

Use `coord.mutex.withLock()` with a per-account key such as
`quota:probe:<credentialId>`. A global lock would serialize unrelated providers and undo the
existing four-worker sweep.

The operation records its start time before waiting. Inside the lock it rereads the credential's
latest quota snapshot. If any reported window has `observedAt >= startTime`, another attempt
completed successfully after this request began; return `coalesced` without another provider call.
Otherwise run the normal account attempt.

This suppresses duplicate successful probes across replicas. It deliberately does not persist a
completion marker for failed, unsupported or empty outcomes. Concurrent callers for those outcomes
may wait and then repeat the provider call. Guaranteeing exactly one call for every outcome would
require an ephemeral distributed result protocol with expiry and error serialization; no operator
need justifies that machinery.

The existing shared `quota:cooldown:<credentialId>` remains the authority after provider 429s. It
prevents a second caller from repeating a rate-limited call during the three-minute window.

If distributed coordination is unavailable, log through the existing closed coordination fields
and fall back to process-local coalescing. Manual telemetry refresh remains available, at the cost
of possible duplicate provider calls across replicas. This matches the existing availability
choice for OAuth refresh coordination.

The periodic job's `quota-poll` lease remains unchanged. It prevents duplicate whole-fleet timer
passes; it is not reused by manual requests. An interactive request must not become a silent no-op
because another node holds a scheduler lease.

## Probe and persistence rules

The shared operation preserves these existing rules:

- Disabled credentials are not opened or probed.
- API-key credentials return `unsupported`.
- Missing provider usage support returns `unsupported`; missing means unknown, never unlimited.
- An OAuth token inside the existing refresh lead is refreshed through the process-wide refresher.
- Only purpose-specific `UsageSecrets` reach the usage flow.
- Provider and plugin HTTP still runs through the host `HttpClient`, timeout, origin and yield caps.
- A null or empty report returns `noData` and leaves the previous snapshot untouched.
- A non-empty report is normalized once and saved through `saveQuota()`.
- A provider 429 writes the existing shared three-minute cooldown.
- Authentication, transport, plugin and persistence failures return `failed` and never disable the
  credential.
- A successful report may remove a previously reported window when the provider's new complete set
  omits it; this is existing `saveQuota()` whole-set behavior.

`quotaPollIntervalMs: 0` disables only the automatic timer. Manual refresh still runs because the
operator supplies the trigger explicitly.

Staleness, rollover and burn continue through `quotaStaleAfterMs`, `quotaRolledOver()` and existing
projection helpers. Failed, skipped and no-data attempts leave the old snapshot visible with its
natural stale or rolled-over state. The UI never replaces it with zero or “unlimited.”

## Gateway API

Add one admin-only mutation:

```text
POST /api/credentials/quota/refresh
```

Body:

```json
{"kind":"one","credentialId":"account-id"}
```

or:

```json
{"kind":"all"}
```

A discriminated body avoids treating an absent credential ID as an implicit all-account command.
Accidentally dropping a field at a caller must fail closed rather than trigger provider calls for
every account.

The route uses `requireAdmin`. Viewer sessions may read current quota and history but cannot cause
provider HTTP, OAuth rotation, cooldown writes or quota persistence. Client sessions receive no
route. Dashboard hiding is usability only; the backend guard remains authoritative.

The route receives the existing shared store, coordinator, OAuth registry, `HttpClient`, clock,
logger and process-wide refresher. It never constructs another refresher or provider registry.

After the requested operation finishes, emit `res:quota` once if at least one outcome is
`refreshed` or `coalesced` from a newly observed reading. Emission occurs after all writes and before
the response is considered complete. Unsupported, disabled, cooldown, no-data and failed-only
operations emit nothing because stored quota did not change.

The response is `QuotaRefreshResult`. Partial account failures are data, not an HTTP error. Normal
gateway envelopes handle request-level errors.

## CLI

Add:

```text
omni quota refresh <credential-id>
omni quota refresh --all
```

Exactly one of an ID or `--all` is required. An omitted target does not mean all; bulk provider
traffic must be explicit.

The CLI calls the same `@omni/control` operation directly and never `/api/*`. Human output prints one
line per account and a final summary. `--json` emits the stable result object through the existing
CLI JSON path. Exit status is:

- zero when every outcome is `refreshed`, `coalesced`, `noData`, `unsupported` or `disabled`;
- nonzero when any outcome is `failed` or the operation itself fails;
- cooldown is nonzero for a one-account request and contributes to a partial-failure summary for
  `--all`, because the requested refresh did not run.

No raw upstream message is printed. Existing account labels may be resolved for human display, but
JSON uses durable credential IDs.

## Dashboard

### Placement and permissions

Add `Refresh all quota` to the Accounts page header beside the existing connect action. Add a
compact action to every account row with accessible name `Refresh quota for <label>`. The overview
rack remains read-only and links to Accounts rather than duplicating controls.

Admin sessions see the controls. Viewer sessions do not render them. Reuse the verified principal
from the existing status/session state; do not infer permission from a rejected mutation. Client
surfaces remain unchanged.

### Pending behavior

The dashboard tracks a refresh-all mutation and per-account pending IDs:

- a row refresh disables only that row's refresh button;
- refresh-all disables itself and every row refresh button;
- while refresh-all is active, another row refresh cannot start from that page;
- while one row is active, unrelated row refreshes remain available;
- button text or accessible names state the pending action;
- focus remains on the triggering control after completion.

These controls reduce accidental duplicate clicks but are not the correctness boundary; server-side
coalescing handles other tabs, callers and replicas.

### Feedback

Render one operation-level `role="status"` region near the page actions. Examples:

- `Quota refreshed for claude-main.`
- `No quota data reported for grok-main.`
- `Quota refresh is cooling down for openai-team.`
- `Refreshed 4 accounts; 1 failed; 2 skipped.`

For bulk partial results, provide visible per-account outcome details without announcing every
window separately. Color is supplementary, never the only distinction. Messages are host-authored
from result kinds and never contain upstream/plugin text.

Existing quota meters and history remain visible while a request is pending or fails. A failed
refresh never clears the current reading.

### Query invalidation

After a successful dashboard mutation, invalidate:

- `["credentials", "health"]`, which contains latest quota and burn estimates;
- all `["quota-history", ...]` queries for affected accounts.

Also correct push invalidation globally: `res:quota` invalidates both credential health and all quota
history query keys. Today it invalidates history alone, so scheduled writes can leave the latest
meter stale while LIVE mode suppresses polling. Emit no misleading `res:credentials` event for a
quota-only change.

The broadcaster's existing topic coalescing remains unchanged. One operation emits once after all
writes rather than once per account.

## Failure handling

- Invalid body or ambiguous CLI target: `BAD_REQUEST`/usage error; no probe starts.
- Unknown one-account ID: `NOT_FOUND`.
- Credential deleted after list but before attempt: return `failed` with a stable host code or a
  dedicated skipped/gone result if the existing error vocabulary supports it; never recreate it.
- Provider usage absent: `unsupported`.
- Provider returns null/empty windows: `noData`, old snapshot retained.
- Provider 429: triggering attempt reports `failed` with `RATE_LIMIT`; later attempts report
  `cooldown` until expiry.
- OAuth refresh, provider, plugin or store failure: `failed`, old snapshot retained, credential
  remains enabled.
- Coordination failure: continue with local coalescing and log the degradation.
- One bulk failure: other workers continue and the response remains successful with partial
  outcomes.
- Whole-list/store failure before workers start: request-level error.

The response never returns tokens, provider bodies, arbitrary headers or plugin-authored messages.
Logging continues through the closed `LogFields` boundary.

## Testing

### Control

Extend the quota poll tests to prove the shared account-attempt behavior:

- one-account results distinguish refreshed, no-data, cooldown, unsupported, disabled and failed;
- all-account operation returns one outcome per stored credential in stable list order;
- one failure does not stop later workers;
- automatic `poll()` preserves its persisted-count contract;
- scheduled and manual callers share the same account-attempt path;
- two simultaneous same-account calls make one local provider usage call;
- two operation instances sharing `Coord` make one provider call after a successful cross-replica
  attempt, with the waiter returning coalesced;
- a failed/no-data cross-replica attempt may be retried after the mutex;
- coordination failure falls back to local operation;
- manual refresh works when automatic polling is disabled;
- failure and no-data preserve old stale or rolled-over snapshots;
- no outcome disables a credential;
- bulk concurrency never exceeds the existing bound of four.

Mutation seams include bypassing cooldown, applying eligibility after secret opening, removing local
coalescing, using a global mutex, omitting the post-lock observed-at check, failing fast on one bulk
error, clearing old rows on no-data, and counting unsupported rows as writes.

### Scheduler integration

Keep the current startup, interval-zero, lease and post-write invalidation tests. Add one seam where
a blocked scheduled attempt and a manual attempt for the same credential share one provider call.
This catches two individually correct entry points wired to separate coalescers.

### Gateway

- Add the route to the complement-based auth matrix: admin allowed; viewer, client and anonymous
  refused.
- One-account and all bodies reach the shared control operation.
- Missing credential and malformed discriminants fail before provider work.
- Partial failures remain response data.
- No token or upstream text appears in responses.
- `res:quota` emits once after all writes and not for unchanged-only outcomes.
- The route uses the injected process-wide refresher and registry.

### CLI

- ID and `--all` are mutually exclusive and one is required.
- Human output and summaries match every outcome.
- JSON output preserves the stable result shape.
- Exit status distinguishes success, cooldown and partial failure.
- The command calls control directly and performs no gateway HTTP.

### Dashboard

- Admin sees bulk and row actions; viewer sees neither.
- Row refresh sends the selected credential ID; bulk sends explicit `{kind:"all"}`.
- Row and bulk pending states disable the intended controls and retain accessible names.
- Unrelated rows remain actionable during a row refresh.
- Success and partial failure produce a `role="status"` summary.
- Failed/no-data refresh preserves the existing meter.
- Success invalidates latest health and affected histories.
- A `res:quota` frame invalidates both latest health and every quota-history key.
- Per-row accessible names include the account label.

## Documentation

Implementation updates:

- `README.md` for dashboard and CLI commands;
- `ARCHITECTURE.md` for shared manual/scheduled attempt semantics, coalescing and cooldown;
- `docs/operations.md` for admin-only behavior, zero polling interval, partial outcomes and retained
  stale readings;
- project `CLAUDE.md` only if implementation introduces a durable invariant not already pinned by
  tests.

## Files expected to change

- `packages/control/src/quota/poll.ts`
- `packages/control/src/index.ts`
- `packages/control/test/quota/poll.test.ts`
- `apps/gateway/src/quota/poller.ts` only where needed to share the operation instance
- `apps/gateway/src/routes/admin.ts`
- `apps/gateway/src/app.ts` and boot wiring for shared dependencies
- `apps/gateway/test/quota/poller.test.ts`
- gateway admin-route and auth-matrix tests
- `apps/cli/src/commands/quota.ts`
- `apps/cli/src/registry.ts`
- CLI command tests
- `apps/dashboard/src/api/types.ts`
- `apps/dashboard/src/api/queries.ts`
- `apps/dashboard/src/session/invalidation.ts`
- `apps/dashboard/src/features/accounts/AccountsBoard.tsx`
- dashboard account and invalidation tests
- `README.md`, `ARCHITECTURE.md`, `docs/operations.md`

No store interface, schema, migration, provider implementation or plugin API changes are expected.

## Decisions

- Manual refresh covers provider quota, not OAuth-token refresh.
- Dashboard and CLI both ship in the first version.
- Bulk invocation is explicit in API and CLI; omission never means all.
- Mutations are admin-only; viewers and clients stay read-only.
- Scheduled and manual callers use one account-attempt implementation.
- Four remains the fixed bulk concurrency; no setting is added.
- Local calls coalesce every outcome.
- Cross-replica successful calls coalesce through a per-account mutex and `observedAt` reread.
- Failed and empty cross-replica calls may serialize and repeat.
- Coordination failure is fail-open.
- Failures and empty reports preserve prior telemetry and never disable credentials.
- `res:quota` invalidates latest health and history; it is emitted once after changed writes.
- No generic job system or background-operation framework is introduced.
