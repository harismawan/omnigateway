# Request-log investigation and metadata export

Status: designed, not built.

`request_logs` already records the metadata needed to investigate routing, failures, latency,
tokens and cost. The current product exposes only a newest-first tail: at most 500 rows, filtered
in the browser after retrieval. On a busy gateway, “failed requests” therefore means “failures in
the latest selected rows,” and older retained data is inaccessible through normal operator tools.

This design turns that tail into a bounded investigation surface. It adds deterministic keyset
pagination and exact server-side filters to operator and client views, plus metadata-only CSV and
JSONL export for operators and viewers. It does not make captured request bodies searchable or
exportable.

## Goals

- Traverse retained request logs without skips or duplicates.
- Apply authorization scope and filters before the page limit.
- Give admin and viewer sessions the same paginated metadata investigation surface.
- Give client sessions pagination over only their own projected rows.
- Export the operator/viewer result set as streaming CSV or JSONL.
- Use one query definition across SQLite, Postgres, API, CLI, dashboard and export.
- Keep first-page tail reads cheap for overview and chassis consumers.
- Preserve request-body privacy and existing live-invalidation semantics.

## Non-goals

- Captured-body search or export.
- Fuzzy or full-text search.
- Searching current key or credential labels.
- Client export.
- Total result counts.
- Numbered pages or random page access.
- Saved searches, scheduled reports or background export jobs.
- Arbitrary sort columns.
- Snapshot isolation across several HTTP pages.
- A combinatorial index for every filter combination.

## Existing behavior

`UsageRepo.recent(limit, apiKeyId?)` returns rows ordered by `at DESC`, optionally scoped to one
API key. `packages/control/src/usage.ts` clamps the limit to 1–500 and applies the verified
principal scope. `/api/logs`, `/api/client/logs`, `omni logs`, overview and chassis all build on
that operation.

The dashboard fetches 50–500 rows, then applies failure and text filters locally. The result set is
therefore bounded before filtering. The CLI's follow mode remembers only the newest timestamp, so
two rows written in the same millisecond can be missed.

A separate `UsageRepo.scan(cursor, limit)` already walks `(at, id)` in ascending order. It belongs
to store copying: it has no authorization scope or investigation filters and its oldest-first
ordering is intentional. It remains unchanged.

Request bodies remain a separate encrypted artifact reached through the admin-only
`/api/requests/:id/body` route. A log page or export must never call the body repository.

## One query contract

Add the investigation vocabulary to `@omni/store/types`:

```ts
export type RequestLogCursor = {
  at: number;
  id: string;
};

export type RequestLogQuery = {
  limit: number;
  cursor: RequestLogCursor | null;
  apiKeyId?: string;
  credentialId?: string;
  provider?: ProviderId;
  requestedModel?: string;
  resolvedModel?: string;
  errorCode?: ErrorCode;
  state?: "pending" | "done";
  failed?: boolean;
  since?: number;
  until?: number;
};

export type RequestLogPage = {
  logs: RequestLog[];
  next: RequestLogCursor | null;
};
```

The exact names may follow the surrounding type style, but the semantics are fixed:

- sort by `(at DESC, id DESC)`;
- the cursor is exclusive;
- `since` and `until` are inclusive;
- every supplied filter is combined with `AND`;
- scope and filters apply before the limit;
- `failed: true` means a completed row with an error status, matching the dashboard's existing
  `isError` behavior;
- `failed: false` is omitted rather than interpreted as “successful only”;
- model filters are explicit because requested and resolved models are different facts;
- page size remains bounded to 1–500 at the control boundary.

`UsageRepo` gains one method taking the required query object. Passing one object avoids the
SQLite swap-forwarder's previous lower-arity failure, where an omitted optional scope argument
compiled and exposed every key's rows.

The stores ask for `limit + 1` rows. If the extra row exists, they return the first `limit` rows and
a cursor derived from the last returned row. Otherwise `next` is null. A full final page therefore
does not falsely advertise another page.

`recentLogs` remains as a compatibility wrapper that requests the first unfiltered page. Overview,
chassis and callers that only need a tail do not become infinite-query consumers.

## Cursor wire format

HTTP and CLI cursors are opaque, versioned base64url JSON values:

```json
{"v":1,"at":1789091285123,"id":"request-id"}
```

Opacity is not secrecy: both fields are already request metadata. It creates one validation
boundary and leaves room to revise the wire shape without making SQL ordering fields a permanent
client contract.

The control layer owns cursor encoding and decoding. It rejects malformed base64, invalid JSON,
unknown versions, extra fields, non-safe-integer timestamps, and empty or overlong IDs with
`BAD_REQUEST`. A malformed cursor never silently restarts from the newest page.

The cursor carries neither scope nor filters. Every request derives scope again from the verified
session. Changing filters while reusing a cursor is legal and resumes the new query below that
tuple; the dashboard resets pagination whenever a filter changes.

## Store queries and indexes

Both stores implement the same descending keyset predicate:

```sql
WHERE (at < ? OR (at = ? AND id < ?))
ORDER BY at DESC, id DESC
LIMIT ?
```

All optional values remain bound parameters. No stored provider, model, ID or error value is ever
interpolated into SQL.

Add matching migrations for:

```sql
CREATE INDEX ... ON request_logs (at DESC, id DESC);
CREATE INDEX ... ON request_logs (api_key_id, at DESC, id DESC);
CREATE INDEX ... ON request_logs (credential_id, at DESC, id DESC);
```

The first index makes the universal traversal deterministic and index-backed. The key index keeps
client and scoped control reads bounded. The credential index supports the most common operator
account investigation. Existing shorter indexes may be replaced when the database permits it,
rather than retained redundantly.

Do not add leading indexes for every provider, model, state and error filter in the first version.
They would multiply write maintenance without evidence about query distribution. Time bounds and
the cursor constrain scans; production measurements can justify another index later.

Both implementations map rows through their existing `toLog` function. Export never encodes raw
database rows, because Postgres `BIGINT` values and SQLite booleans otherwise produce different
wire values.

Add the new method to the SQLite swap forwarder and its source-level arity guard. Store behavior is
proved once in the shared contract suite and therefore runs against SQLite and Postgres.

## Authorization and projection

The control operation accepts verified `Scope` separately from caller filters. It follows the
existing order:

1. `readsNothing(scope)` returns an empty page without touching the store.
2. `scopeKey(scope)` supplies the mandatory key restriction for client scope.
3. Operator filters are applied inside that restriction and can only narrow it.

A caller-provided `apiKeyId` can never widen client scope. The client route does not accept a key
filter at all.

Access remains:

| Surface | Principal | Rows |
|---|---|---|
| `/api/logs` | admin, viewer | all metadata allowed by filters |
| `/api/client/logs` | client | own key only, projected through `toClientLog` |
| operator export | admin, viewer | same metadata visible through `/api/logs` |
| request body lookup | admin | unchanged, one request at a time |

Every client page maps each row through `toClientLog` before returning it. This remains an
allowlist projection; raw rows are never serialized and then stripped. Credential identity,
operator-only RTK details and credential-bearing degradation entries remain absent.

Viewer export is deliberate. A viewer may already retrieve every exported row and field through
`/api/logs`; export changes transfer shape, not authority. Snapshot download remains admin-only
because it contains encrypted credentials and API-key hashes. Every export response uses
`Cache-Control: no-store`.

## API shape

`GET /api/logs` and `GET /api/client/logs` return:

```json
{
  "logs": [],
  "nextCursor": null
}
```

Accepted query parameters are:

- `limit`
- `cursor`
- `since`
- `until`
- `state`
- `failed`
- `provider`
- `requestedModel`
- `resolvedModel`
- `credentialId` on the operator route only
- `apiKeyId` on the operator route only
- `errorCode`

Empty strings are not null-filter sentinels. The first version does not add “unrouted only,”
“anonymous only,” or “no error” filters. Unknown provider IDs remain valid only where the existing
validated-provider-string contract permits them; every value still passes the relevant schema and
length bounds.

The old `{ logs }` response is additively extended with `nextCursor`, so consumers reading only
`logs` continue to work.

## Dashboard

Keep the existing bounded `useLogs(limit)` and `useClientLogs(limit)` behavior for overview,
chassis and the client summary. Implement a dedicated paginated investigation hook for the Logs
board; do not turn every tail consumer into an infinite query.

The Logs board provides exact controls for:

- time range;
- pending/done/failed state;
- provider;
- requested and resolved model;
- account/credential;
- gateway key;
- error code.

Controls send durable IDs or exact values. Rows outlive deleted keys and credentials, so missing
labels continue to fall back to stored IDs. The first version removes the ambiguous global search
box rather than pretending an exact server query preserves its fuzzy, current-label semantics.

“Load older” appends the next page. Numbered pages are absent because keyset cursors cannot jump to
an arbitrary page without walking previous cursors. Changing any filter resets to the first page.
Query keys include every normalized filter and page size; cursors remain page parameters.

`res:logs` remains an invalidation topic, not a row stream. It refreshes the head page only. It does
not refetch every historical page or synthesize rows from socket payloads. Immutable request-body
queries remain excluded from log invalidation.

The client log view gains the same “Load older” behavior and only filters expressible without
operator identity. It does not gain export.

## CLI

`omni logs` gains the same exact filter vocabulary and an opaque continuation cursor. Default table
output remains newest-first. `--json` retains its existing structured-command meaning; it does not
become JSONL.

Follow mode remembers the full `(at, id)` tuple, fixing the existing same-millisecond loss. New rows
are ordered consistently before display. Polling remains the mechanism; no second push client is
introduced into the CLI.

Operator export is available as a distinct command shape:

```text
omni logs export --format csv|jsonl --since <time> --until <time> [filters]
```

It writes to stdout. Shell redirection already provides file output, so the first version adds no
output-path option or file-overwrite policy. Diagnostics go to stderr.

The CLI calls `@omni/control` directly and never `/api/*`.

## Export

Export uses the same normalized query and authorization operation as interactive pages. It walks
pages internally in fixed batches and writes rows incrementally. It never loads the full result set
into memory and never calls `UsageRepo.scan` or a body repository.

Both `since` and `until` are required. The control layer rejects an inverted range and clamps the
range to retained data where that fact is available. There is no silent row cap: every retained
matching metadata row in the requested interval is written. If production volume later makes a
maximum interval necessary, add an explicit pre-stream rejection rather than truncating a valid
CSV or JSONL response.

HTTP export stops requesting pages when the downstream request is cancelled. A database or encoder
failure before headers produces the normal gateway error. A failure after streaming begins closes
the response; formats contain no fake error or truncation row.

Responses include:

- `Content-Disposition: attachment` with a server-generated filename;
- `Cache-Control: no-store`;
- the format-specific content type.

### JSONL

JSONL is the exact machine-readable representation:

- one normalized `RequestLog` object per line;
- stable key order;
- JSON nulls preserved;
- `\n` after every row, including the last;
- no outer array, cursor record or summary record.

Use `application/x-ndjson`.

### CSV

CSV is spreadsheet-safe presentation output:

- UTF-8;
- one fixed header row and stable column order;
- RFC 4180 quoting;
- CRLF row endings;
- null scalar values as empty fields;
- booleans as `true` or `false`;
- locale-independent numbers;
- arrays encoded as compact JSON strings.

Text cells beginning, after leading whitespace, with `=`, `+`, `-` or `@` receive a leading
apostrophe to prevent spreadsheet formula execution. This means CSV is intentionally not a
byte-exact representation of dangerous text; JSONL is the lossless option.

Exports contain stored IDs, not current labels. Labels are mutable and joined outside the log row
today. Adding them would make old exports change after a rename and would introduce a second query
path.

## Concurrent writes and retention

Keyset pagination is read-committed, not a snapshot:

- rows inserted after page one sort above its cursor and do not displace older traversal;
- retention deletion creates gaps but no duplicates;
- a cursor older than retention returns an empty page;
- `at` and `id` never change, so a pending row does not move between pages;
- routing and completion fields may change, so a pending row can enter or leave a filter between
  page requests.

The system does not hold a transaction across HTTP requests. Export includes rows in the state
observed as each page is read, matching the investigation surface. It does not exclude pending rows
or promise a frozen incident snapshot.

## Failure handling

- Malformed cursor, time, enum or boolean input: `BAD_REQUEST`.
- `since > until`: `BAD_REQUEST`.
- Unknown cursor version: `BAD_REQUEST`.
- Store failure before a page response: normal internal error handling.
- Store failure during export: terminate the stream; never append an in-band pseudo-row.
- Client cancellation: stop paging and release stream resources.
- Missing deleted labels: show stored IDs.
- No matches: empty page with `nextCursor: null`; export writes only the CSV header or zero JSONL
  rows.

No failure path logs query values that may contain arbitrary model text. Structured logging remains
inside the closed `LogFields` boundary.

## Testing

### Store contract

Run the same cases against SQLite and Postgres:

- deterministic descending order for equal timestamps;
- exclusive cursor boundaries across at least three pages;
- no omissions or duplicates;
- a new row above the cursor does not disturb older traversal;
- scope and every exact filter apply before the limit;
- requested and resolved model filters cannot be swapped;
- combined filters use intersection semantics;
- inclusive `since` and `until` boundaries;
- `limit + 1` distinguishes a full final page from another page;
- pending rows retain their stable position;
- persisted RTK values still pass through the existing mapper.

Mutation seams include removing the ID tie-break, changing `<` to `<=`, applying scope after limit,
omitting one predicate, swapping model fields, and ordering by timestamp alone.

### Control and security

- malformed and unknown-version cursors fail closed;
- limit clamping remains 1–500;
- `none` scope never reaches the repository;
- a supplied key filter cannot widen client scope;
- admin and viewer receive equivalent operator metadata;
- every client row passes through `toClientLog`;
- export authorization matches the table above;
- no export path calls the body repository.

### Store swap

Extend the source-level forwarder test and behavior test so the required query object, including
scope, filters and cursor, reaches both pre-swap and post-swap handles.

### Routes and serialization

- every query parameter reaches control with the specified meaning;
- page responses carry the right cursor;
- CSV quotes commas, quotes, CR and LF and neutralizes formulas;
- JSONL writes one normalized object per line;
- export headers include attachment and `no-store`;
- export cancellation stops another repository page read;
- client responses contain no API-key or credential identity;
- body routes and authorization remain unchanged.

### CLI and dashboard

- follow mode does not lose equal-timestamp rows;
- CLI filters and continuation use the shared control operation;
- `--json` remains distinct from JSONL export;
- dashboard filters are request parameters, not local filtering over a tail;
- loading older appends without duplicates;
- changing filters resets pagination;
- `res:logs` refreshes only the head;
- overview and chassis remain bounded first-page consumers;
- client pages cannot render operator-only fields.

## Documentation

Implementation updates:

- `README.md` for CLI/API behavior and the metadata-only export boundary;
- `docs/operations.md` for exact filters, time-bounded export and retention effects;
- `ARCHITECTURE.md` for keyset order, scope-before-limit and head-only invalidation;
- project `CLAUDE.md` only if implementation introduces an invariant not already pinned by tests.

## Files expected to change

- `packages/store/src/types.ts`
- `packages/store/src/sqlite/usage.ts`
- `packages/store/src/postgres/usage.ts`
- `packages/store/src/sqlite/store.ts`
- SQLite and Postgres migration registries and new index migrations
- `packages/store/test/contract/usage.test.ts`
- `packages/store/test/swap.test.ts`
- `packages/control/src/usage.ts`
- `packages/control/src/clientLog.ts` only if its page projection needs a generic helper
- control usage and scoped-read tests
- `apps/gateway/src/routes/admin.ts`
- `apps/gateway/src/routes/client.ts`
- gateway route, auth and client-shape tests
- `apps/cli/src/commands/usage.ts` and CLI tests
- `apps/dashboard/src/api/types.ts`
- `apps/dashboard/src/api/queries.ts`
- `apps/dashboard/src/features/logs/LogsBoard.tsx`
- dashboard log, client and mirror tests
- `README.md`, `docs/operations.md`, `ARCHITECTURE.md`

## Decisions

- Keyset pagination, not offsets.
- One shared filtered query, not separate listing and export SQL.
- Existing ascending `scan` remains copy-specific.
- Both operator and client views paginate.
- Only admin and viewer export.
- Export requires an explicit time range and has no silent row cap.
- Exact structured filters only.
- Viewer export is allowed because it adds no row or field authority.
- Captured bodies remain entirely separate and admin-only.
- JSONL is lossless; CSV is spreadsheet-safe.
- No generic pagination or export framework is introduced for one resource.
