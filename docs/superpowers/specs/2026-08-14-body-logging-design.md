# Body Logging Design

## Goal

Give operators an opt-in record of request and response bodies for incident forensics, covering both
the client-facing pair and every provider wire pair, without weakening the existing redaction
boundary. Body capture is off by default, encrypted at rest, bounded in size, and expires on the
existing log retention schedule.

## Security posture

`LogFields` is not widened, and no body ever reaches a logger sink. Stdout, journald, `OMNI_LOG_FILE`,
and the dashboard console tail carry exactly what they carry today. The closed allowlist in
`packages/ir/src/logger.ts` remains the compile-time redaction boundary; this feature adds a separate
storage path rather than relaxing it.

Bodies are captured. Headers are not, at any layer. Anthropic, OpenAI, and Kimi all authenticate
through headers, so `HttpRequest.headers` is where OAuth tokens and API keys live. The capture
decorator reads `HttpRequest.body`, which is a plain string, and never receives the header list. This
is the property that keeps credentials out of the table, and it is asserted by test rather than left
to review.

Stored bodies are ciphertext under the required `OMNI_ENCRYPTION_KEY`, using the same encryption path
as provider credentials. A database file copied without the key yields nothing. An operator who never
enables the setting stores nothing at all.

## Configuration contract

`Settings` gains `bodyLoggingEnabled: boolean`, defaulting to `false`, alongside the existing
`rtkEnabled` runtime boolean. The value is read per request, so an operator can enable capture mid
incident and disable it afterwards without restarting the gateway. Disabling stops new capture; it
does not delete rows already written.

Per-body size cap is a constant, 256 KB, not a setting. A body past the cap is stored truncated with
`truncated` set. Total storage per request is therefore bounded by `maxAttempts * 2 * 256 KB`.

Retention reuses `settings.logRetentionDays`. Body rows expire on the same schedule as the
`request_logs` rows they describe.

## Schema

A single table, discriminated by attempt:

```sql
CREATE TABLE request_bodies (
  request_id     TEXT NOT NULL,
  attempt        INTEGER NOT NULL,
  at             INTEGER NOT NULL,
  provider       TEXT,
  request_ct     BLOB NOT NULL,
  response_ct    BLOB,
  request_bytes  INTEGER NOT NULL,
  response_bytes INTEGER,
  truncated      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (request_id, attempt)
);
CREATE INDEX idx_request_bodies_at ON request_bodies (at DESC);
```

Attempt `0` holds the client-facing pair: what arrived at `/v1/*` and what the gateway returned.
Attempts `1..n` hold one wire pair each, in dispatch order, with `provider` set. A failover incident
reads as one ordered story: client payload, what went to the first provider, what it returned, what
went to the second.

`request_bytes` and `response_bytes` record pre-truncation sizes, so a reader can tell a small body
from a truncated large one.

## Capture path

Client-facing capture hooks the `finishLog` choke point in `apps/gateway/src/routes/proxy.ts`, which
already runs exactly once per request id on both the success and error paths, and therefore inherits
the existing single-write guarantee.

Wire capture wraps the `HttpClient` injected into each dispatch attempt through `AdapterRequest.http`.
`HttpClient` is a single function type, so capture is a decorator: `nodeHttpClient` is unchanged, the
rule that all outbound provider HTTP goes through `HttpClient` is unchanged, and the decorator knows
its provider and attempt number without threading extra context. Rows accumulate in memory during the
request and are written together at `finishLog`.

Streaming provider responses require teeing `HttpResponse.body`. A tee whose second branch is not
drained builds backpressure until the first branch stalls, which would make body logging a latency
bug under load. The implementation must hold these rules:

- The adapter's branch is byte-identical to the uncaptured stream and is never delayed by capture.
- The capture branch is always drained to completion, discarding bytes past the cap. It is never
  abandoned mid-stream.
- An error or cap hit in the capture branch never propagates to the adapter branch. Capture failure
  degrades to a missing row, never to a failed request.
- No database write happens on the commit path. Rows are written after the response completes.
- Pre-commit failover and post-commit stream semantics are unchanged.

Streaming responses are stored as the reassembled final response rather than the raw SSE frame log.
This keeps rows comparable with non-streaming rows and bounded in size; it means SSE framing itself is
not recoverable from a stored body.

Client cancellation still produces a row. The captured response is whatever completed before the
disconnect, marked truncated.

## Retention

`apps/gateway/src/maintenance.ts` deletes `request_bodies` rows past `logRetentionDays` by `at`, as an
explicit statement rather than relying on a foreign key cascade. Cascade behavior depends on the
`foreign_keys` pragma being enabled, and a silently disabled pragma would turn expiry into unbounded
retention of a prompt corpus. The explicit delete is asserted by test.

## Access

`GET /api/requests/:id/body` returns the decrypted rows for one request, ordered by attempt. It
requires an admin session like every other `/api/*` route. The dashboard shows the bodies on request
log row expansion. No CLI command in this change.

## Tests

- Setting defaults to `false`; with it off, no row is written.
- With it on, rows exist for the client pair and for each provider attempt, ordered, with the correct
  provider per row.
- Stored ciphertext does not contain the plaintext marker, so a refactor that skips encryption fails
  rather than passing a green suite.
- A distinctive marker in a prompt appears nowhere in the captured stdout sink while capture is on.
  This is the regression test that fails if `LogFields` is later widened.
- A synthetic bearer token placed in upstream request headers appears nowhere in `request_bodies`.
- Streaming and non-streaming paths both capture.
- Bytes delivered to the adapter are identical with capture on and off.
- A slow capture branch does not delay adapter-side stream delivery.
- A body past the cap is stored truncated with pre-truncation size recorded.
- Retention sweep removes body rows at the configured window.
- The access route rejects an unauthenticated caller.
- Client cancellation mid-stream still writes a truncated row.
- Full core, dashboard, typecheck, and lint suites run before completion.

## Scope

Add the settings field and its schema validation, the store migration and repository, the capture
decorator and its wiring into dispatch, the `finishLog` write, the retention delete, the admin route,
and the dashboard row expansion. Do not widen `LogFields`, do not capture headers at any layer, do not
change `nodeHttpClient`, and do not alter existing retention defaults or stream commit semantics.
