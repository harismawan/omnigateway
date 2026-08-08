# In-Flight Request Log Design

**Date:** 2026-08-09
**Status:** Approved

## Goal

Show a request in the console's log while it is still running, marked with a spinner in the lamp
column, so an operator watching a long stream sees that the gateway is working rather than an empty
table.

Today nothing in the system knows a request exists between its first byte and its last. One row is
inserted after the response stream drains, errors, or is cancelled (`apps/gateway/src/logging.ts`,
called from `apps/gateway/src/routes/proxy.ts`). A ninety-second streaming request is invisible for
ninety seconds, which reads as an idle gateway.

## Scope

This change covers a request-state column on `request_logs`, a two-write request lifecycle in the
store and the proxy route, an orphan sweep at boot, a `live` lamp state, and in-flight rows on the
logs board and the overview activity tail.

It does not add a log socket, a push channel, or an in-memory request registry. It does not change
routing, dispatch, or what a completed row contains. The chassis health strip and the overview
board are not given in-flight rows; they are only taught to ignore them.

## Data model

A migration adds one column and one partial index:

```sql
ALTER TABLE request_logs ADD COLUMN state TEXT NOT NULL DEFAULT 'done';
CREATE INDEX idx_request_logs_pending ON request_logs(state) WHERE state = 'pending';
```

Existing rows default to `done`, so history stays valid without a rewrite. `RequestLog` in
`packages/store/src/types.ts` gains `state: "pending" | "done"`.

`status` stays `NOT NULL`. A pending row carries `0`, and every reader keys off `state`, never off
`status`. Making `status` and `duration_ms` nullable would mean a table rebuild in SQLite, and a
sentinel that no reader consults costs nothing.

Because `RequestLog` is re-exported to the dashboard from `@omni/store/types`, the field reaches the
client from one edit. The `/api/logs` response shape is otherwise unchanged.

## Write path

`UsageRepo` gains two methods beside `append`:

- `begin(log)` — a plain `INSERT` with `state='pending'`, and **no rollup**. A request that has not
  finished has no tokens and no cost to accumulate.
- `sweepPending()` — completes every row still pending.

`append(log)` becomes `INSERT … ON CONFLICT(id) DO UPDATE`, setting `state='done'`, and keeps
writing the `usage_daily` rollup in the same transaction as today. One method serves both the normal
completion and the pre-dispatch failure path, which never began.

The invariant that replaces the primary key's protection: **`append` runs at most once per request
id.** A second call would double-count `usage_daily`, which an upsert accepts silently where the
plain insert used to throw. What guarantees it is the `runOnce` latch inside `sseResponse` and the
single terminal `catch` in the route — both already exist, and both are covered by tests.

In `apps/gateway/src/routes/proxy.ts`, `begin` fires after authentication, parsing, and the model
allowlist check pass, immediately before `dispatch()`. That is the first moment `requestedModel` and
the key id exist. A request that fails those checks never gets a pending row: it falls to the catch
and writes one terminal row, exactly as now.

The pending row's `at` is the request start time, matching what dispatch already records for a
completed row. Completion must not restamp it, or a row would jump position in the tail at the
moment it finished.

Like `finishLog`, the begin path swallows its own errors. A store failure must not turn a working
proxied request into a 500.

One ordering hazard the upsert introduces: the route's terminal `catch` synthesizes a fully zeroed
log with an empty `requestedModel`, and it can now be reached *after* a pending row exists — if
`dispatch()` itself throws rather than yielding an error event. Written blindly, that completion
would overwrite a real requested model with an empty string. The completion statement therefore
leaves the columns that only `begin` knows — `requested_model`, `api_key_id`, `at` — untouched when
they are absent from the completing log, rather than assigning them unconditionally.

## Orphans

A crash or `kill -9` leaves pending rows that will never complete. The gateway is single-node and
single-process, so any row still pending at startup is stale by definition.

`apps/gateway/src/index.ts` calls `sweepPending()` after migrations. Each orphan is completed
through the same transaction as a normal finish, with `status: 499`, `errorCode: "interrupted"`,
`durationMs: 0`. Reusing the completion path is what keeps the daily rollup equal to the raw rows;
deleting the orphans instead would erase the only evidence that requests died mid-flight.

## Read path

`recentLogs` is unchanged. `SELECT * FROM request_logs ORDER BY at DESC LIMIT ?` already returns
pending rows, now carrying `state`. There is no new endpoint and no new query.

Pending rows sort by `at` like any other, so a live request appears at the top of the tail and stays
in place when it completes — the row updates where it sits rather than jumping.

### Cadence

`useLogs` drops its default cadence from `10_000` to `2_000`. A ten-second poll makes a spinner lie
in both directions: short requests never appear at all, and finished ones keep spinning for up to
ten seconds.

This applies to every `useLogs` caller — the logs board, the activity tail, the chassis strip at 200
rows, and the overview board at 500 — so four concurrent polls run at two seconds. Each is an admin
session check plus one indexed `SELECT` against local SQLite. The chassis LIVE switch still turns
all of them off. The cost is roughly five times today's console polling on an idle gateway, which is
the price of the feature being truthful.

### Derived metrics

A pending row carries `status: 0`, `costUsd: 0`, `ttftMs: null`, and zero tokens. Fed to `summarize`
or `bucketLogs`, those zeros dilute every rate toward zero as traffic rises — the health sparkline
would dip exactly when the gateway got busy.

`apps/dashboard/src/lib/vitals.ts` gains:

```ts
export function isPending(log: RequestLog): boolean;
export function completed(logs: readonly RequestLog[]): RequestLog[];
```

`summarize` and `bucketLogs` filter pending rows at entry. That covers the chassis strip and the
overview board without touching either file, which is what keeps the health lamp honest even though
those surfaces do not show in-flight rows.

`isError` gains an explicit `if (isPending(log)) return false`. A pending row reads as non-error
today only because `0 >= 400` is false; the guard makes that intent rather than luck.

## Spinner

`LampState` gains `live`, and `LAMP_GLYPH.live` is `◐` — the static fallback, and what a monochrome
or reduced-motion screen shows. Its tone is `inkFaint`: a request in flight is not a state to judge,
and colour on this console means provider or state only.

The animation is a CSS `steps()` keyframe cycling `◜◝◞◟` through the `content` of a `::before`, four
frames over roughly 0.8 seconds, with the text node hidden. No JavaScript timer and no re-render,
which matters because the table now re-renders on a two-second poll. Under
`@media (prefers-reduced-motion: reduce)` the animation is dropped and the static glyph stands.

The animation attaches only when `$state === "live"`, so nothing about `ok`, `warn`, `down`, or
`idle` changes anywhere `Lamp` is already used.

## Rows

In `LogsBoard`, the lamp becomes three-way: pending renders `live` with the label `in flight`;
otherwise the existing error and success branches stand. The label is the accessible name, so a
screen reader announces "in flight" — the whole signal, since the animation carries nothing for it.

A pending row shows its requested model and its time. Routed to, Account, Try, TTFT, Total, Tokens,
and Cost render an em dash. This follows from writing only twice: `attempts: 0` and `costUsd: 0` are
placeholders, not measurements, and rendering `0` would state something false. Outcome shows a chip
toned `idle` reading `live` in place of a status number. If `Chip` does not already accept an `idle`
tone, add one beside the existing tones rather than reusing `ok`.

Search still matches on requested model, which a pending row has. The `failed` filter excludes
pending rows, because `isError` is false for them — a request in flight is not a failure yet.

Clicking a live row opens the detail modal under the same rule: unknown fields show an em dash, and
the status line reads "in flight". The modal does not refresh itself; the row behind it does, on the
next poll.

`ActivityTail` gets the same three-way lamp and no other change.

## Testing

Store:

1. `begin` writes a pending row and no `usage_daily` rollup.
2. `append` completes that row in place and rolls up exactly once.
3. A second `append` for the same id does not double-count the rollup.
4. `sweepPending` completes orphans as `interrupted` and leaves `done` rows alone.

Gateway:

5. A pending row exists while a stream is in flight and is `done` after it drains.
6. The same holds on stream error and on client cancellation.
7. A pre-dispatch failure — auth, rate limit, bad JSON, allowlist — writes exactly one `done` row
   and never a pending one.
8. A throw from `dispatch()` after `begin` completes the existing row without erasing its requested
   model or its start time.
9. A store failure during `begin` does not fail the proxied request.

Dashboard:

10. A pending row renders the live lamp with the accessible name `in flight` and em dashes in the
    unknown columns.
11. `summarize` and `bucketLogs` ignore pending rows.
12. The `failed` filter excludes pending rows.

Run the changed-area tests, the full root suite, the dashboard suite, `bun run typecheck`, and
`bun run lint` before claiming completion.

## Documentation

`CLAUDE.md` records under known constraints that a `request_logs` row is written twice — once at
dispatch start as `pending`, once at completion — that the rollup is written only on completion, and
that pending rows surviving a crash are swept to `interrupted` at boot.
